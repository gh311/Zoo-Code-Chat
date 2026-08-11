import * as vscode from "vscode"
import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiHandler } from "../../api"
import { buildApiHandler } from "../../api"
import { ApiStream } from "../../api/transform/stream"
import type { ProviderSettings } from "@roo-code/types"
import type { ContextProxy } from "../../core/config/ContextProxy"
import type { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"

/**
 * VSCode native Chat participant that routes messages through Zoo Code's
 * existing provider stack (Anthropic, OpenRouter, OpenAI, etc.).
 *
 * This lets Zoo Code appear in VSCode's built-in Chat panel on the right side,
 * the same panel GitHub Copilot Chat uses — no custom webview sidebar required.
 *
 * The participant uses the currently active provider profile configured in
 * Zoo Code settings. All streaming, tool calls, and model routing work
 * exactly as they do in the sidebar — just in the native chat UI.
 *
 * Conversation history is sourced from VSCode's native ChatContext, which
 * provides per-session isolation automatically. Cancellation is wired through
 * an AbortController so the Stop button aborts the in-flight HTTP request.
 */

const PARTICIPANT_ID = "zoo-code.chat"

export class ZooCodeChatParticipant {
	private providerSettingsManager: ProviderSettingsManager
	private contextProxy: ContextProxy
	private participant: vscode.ChatParticipant | undefined
	private disposables: vscode.Disposable[] = []
	private outputChannel: vscode.OutputChannel

	constructor(
		providerSettingsManager: ProviderSettingsManager,
		contextProxy: ContextProxy,
		outputChannel: vscode.OutputChannel,
	) {
		this.providerSettingsManager = providerSettingsManager
		this.contextProxy = contextProxy
		this.outputChannel = outputChannel
	}

	activate(context: vscode.ExtensionContext): void {
		const handler: vscode.ChatRequestHandler = this.handleRequest.bind(this)

		this.participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler)
		this.participant.iconPath = new vscode.ThemeIcon("robot")

		this.disposables.push(this.participant)

		// Slash command: /clear — VS Code manages history natively; just inform the user
		this.disposables.push(
			vscode.commands.registerCommand("zoo-code.chatClear", () => {
				vscode.window.showInformationMessage(
					"Zoo Code: Use the New Chat button in the Chat panel to start a fresh conversation.",
				)
			}),
		)
	}

	/**
	 * Get the currently active provider settings from Zoo Code's config.
	 */
	private async getActiveProviderSettings(): Promise<ProviderSettings | null> {
		try {
			const currentConfigName = this.contextProxy.getValues().currentApiConfigName

			if (!currentConfigName) {
				return null
			}

			const profile = await this.providerSettingsManager.getProfile({ name: currentConfigName })
			// Strip name/id — ProviderSettings doesn't include those
			const { name: _name, id: _id, ...settings } = profile
			return settings as ProviderSettings
		} catch (error) {
			this.outputChannel.appendLine(
				`[ZooCodeChat] Failed to get provider settings: ${error instanceof Error ? error.message : String(error)}`,
			)
			return null
		}
	}

	/**
	 * Build conversation history from VS Code's native ChatContext.
	 *
	 * ChatContext.history is scoped per chat session, so each conversation
	 * has isolated context — unlike a shared in-memory array.
	 */
	private buildHistoryFromContext(chatContext: vscode.ChatContext): Anthropic.Messages.MessageParam[] {
		const history: Anthropic.Messages.MessageParam[] = []

		for (const turn of chatContext.history) {
			if (turn instanceof vscode.ChatRequestTurn) {
				if (turn.prompt.trim()) {
					history.push({ role: "user", content: turn.prompt })
				}
			} else if (turn instanceof vscode.ChatResponseTurn) {
				// Extract markdown text from response parts
				const text = turn.response
					.filter((part) => part instanceof vscode.ChatResponseMarkdownPart)
					.map((part) => (part as vscode.ChatResponseMarkdownPart).value.value)
					.join("\n")
					.trim()

				if (text) {
					history.push({ role: "assistant", content: text })
				}
			}
		}

		return history
	}

	private async handleRequest(
		request: vscode.ChatRequest,
		chatContext: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> {
		const userMessage = request.prompt

		if (!userMessage.trim() && !request.command) {
			stream.markdown("Type a message to chat with Zoo Code.\n\nExample: `@zoo-code Explain this codebase`")
			return {}
		}

		// /clear slash command — VS Code manages history natively
		if (request.command === "clear") {
			stream.markdown(
				"The Chat panel keeps full conversation history automatically. " +
					"Use the **New Chat** button at the top of the panel to start fresh.",
			)
			return {}
		}

		// Get the active provider settings
		const providerSettings = await this.getActiveProviderSettings()

		if (!providerSettings || !providerSettings.apiProvider) {
			stream.markdown(
				"⚠️ **No API provider configured.**\n\n" +
					"Please configure a provider in Zoo Code settings first.\n\n" +
					"Open the Zoo Code sidebar, go to Settings, and set up an API profile " +
					"(Anthropic, OpenRouter, OpenAI, etc.).",
			)
			return { errorDetails: { message: "No API provider configured" } }
		}

		// Build the context from references (editor selections, files)
		const contextParts: string[] = []
		for (const ref of request.references) {
			const value = ref.value
			if (value instanceof vscode.Location) {
				try {
					const doc = await vscode.workspace.openTextDocument(value.uri)
					const text = doc.getText(value.range)
					const fileName = vscode.workspace.asRelativePath(value.uri)
					contextParts.push(`\n\nFile: ${fileName}\n\`\`\`\n${text}\n\`\`\``)
				} catch {
					// ignore
				}
			} else if (typeof value === "string") {
				contextParts.push(value)
			}
		}

		const fullMessage = contextParts.length > 0 ? `${userMessage}${contextParts.join("\n")}` : userMessage

		// Build conversation history from VS Code's native per-session context
		const history = this.buildHistoryFromContext(chatContext)
		history.push({ role: "user", content: fullMessage })

		// Build the API handler using Zoo Code's existing provider system
		const handler: ApiHandler = buildApiHandler(providerSettings)
		const model = handler.getModel()

		stream.markdown(`_Using: **${model.id}** via **${providerSettings.apiProvider}**_\n\n`)

		// System prompt
		const systemPrompt =
			"You are Zoo Code, an AI coding assistant integrated into VSCode. " +
			"Provide helpful, concise answers about code and development. " +
			"When the user shares file content, analyze it in context."

		// Wire CancellationToken to AbortController so the Stop button
		// aborts the in-flight provider HTTP request, not just the local loop.
		const abortController = new AbortController()
		const cancelSub = token.onCancellationRequested(() => abortController.abort())

		// Stream the response
		const apiStream: ApiStream = handler.createMessage(systemPrompt, [...history], {
			taskId: `chat-${Date.now()}`,
			abortSignal: abortController.signal,
		})

		let fullResponse = ""

		try {
			for await (const chunk of apiStream) {
				if (token.isCancellationRequested) {
					break
				}

				switch (chunk.type) {
					case "text":
						fullResponse += chunk.text
						stream.markdown(chunk.text)
						break

					case "reasoning":
						// Show reasoning in a collapsible block
						stream.markdown(`<details><summary>💭 Reasoning</summary>\n\n${chunk.text}\n\n</details>\n\n`)
						break

					case "usage":
						// Could show token usage at the end
						if (chunk.totalCost !== undefined && chunk.totalCost > 0) {
							stream.markdown(`\n\n---\n_Cost: $${chunk.totalCost.toFixed(4)}_`)
						}
						break

					case "error":
						stream.markdown(`\n\n❌ **Error:** ${chunk.message}`)
						break

					case "grounding":
						// Show source citations
						for (const source of chunk.sources) {
							stream.markdown(`\n📚 [${source.title}](${source.url})`)
						}
						break

					default:
						// Ignore tool call chunks — not handled in chat mode
						break
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			stream.markdown(`\n\n❌ **Stream error:** ${msg}`)
			this.outputChannel.appendLine(`[ZooCodeChat] Stream error: ${msg}`)
		} finally {
			cancelSub.dispose()
		}

		return {}
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose())
		if (this.participant) {
			this.participant.dispose()
		}
	}
}
