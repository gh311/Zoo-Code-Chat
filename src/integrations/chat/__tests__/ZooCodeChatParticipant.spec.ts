import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

// ── Mock vscode chat API classes ──────────────────────────────────────
// vi.mock factories are hoisted above imports, so class stubs must be
// created inside vi.hoisted() to be available at mock time.

const { mockClasses, mockDisposable, mockHandler } = vi.hoisted(() => {
	const mockDisposable = { dispose: vi.fn() }

	const mockHandler = {
		getModel: () => ({ id: "test-model", info: {} }),
		createMessage: vi.fn(),
	}

	// Minimal class stubs for instanceof checks in the participant code
	class MockChatResponseMarkdownPart {
		value: { value: string }
		constructor(value: string) {
			this.value = { value }
		}
	}

	class MockChatRequestTurn {
		prompt: string
		command?: string
		participant: string
		constructor(prompt: string, command: string | undefined, participant = "zoo-code.chat") {
			this.prompt = prompt
			this.command = command
			this.participant = participant
		}
	}

	class MockChatResponseTurn {
		response: MockChatResponseMarkdownPart[]
		result: { errorDetails?: { message: string } }
		participant: string
		constructor(response: MockChatResponseMarkdownPart[], participant = "zoo-code.chat") {
			this.response = response
			this.result = {}
			this.participant = participant
		}
	}

	return {
		mockDisposable,
		mockHandler,
		mockClasses: {
			MockChatRequestTurn,
			MockChatResponseTurn,
			MockChatResponseMarkdownPart,
		},
	}
})

vi.mock("vscode", () => ({
	chat: {
		createChatParticipant: vi.fn().mockReturnValue({
			iconPath: undefined,
			dispose: vi.fn(),
		}),
	},
	commands: {
		registerCommand: vi.fn().mockReturnValue(mockDisposable),
	},
	window: {
		showInformationMessage: vi.fn(),
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			append: vi.fn(),
			dispose: vi.fn(),
		}),
	},
	workspace: {
		openTextDocument: vi.fn(),
		asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath),
	},
	ThemeIcon: class {
		constructor(public id: string) {}
	},
	Location: class {},
	ChatRequestTurn: mockClasses.MockChatRequestTurn,
	ChatResponseTurn: mockClasses.MockChatResponseTurn,
	ChatResponseMarkdownPart: mockClasses.MockChatResponseMarkdownPart,
	Disposable: mockDisposable,
}))

// ── Mock buildApiHandler ──────────────────────────────────────────────
// mockHandler is defined in vi.hoisted() above for hoisting safety.

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue(mockHandler),
}))

vi.mock("../../../api/transform/stream", () => ({
	ApiStream: {},
}))

// ── Mock config managers ──────────────────────────────────────────────

const mockContextProxy = {
	getValues: vi.fn().mockReturnValue({ currentApiConfigName: "test-profile" }),
}

const mockProviderSettingsManager = {
	getProfile: vi.fn().mockResolvedValue({
		name: "test-profile",
		id: "test-id",
		apiProvider: "anthropic",
		apiModelId: "claude-sonnet-4-20250514",
	}),
}

// ── Import after mocks are set up ─────────────────────────────────────

import { ZooCodeChatParticipant } from "../ZooCodeChatParticipant"

// ── Helpers ───────────────────────────────────────────────────────────

function createMockStream(chunks: Array<{ type: string; [key: string]: any }>) {
	const generator = async function* () {
		for (const chunk of chunks) {
			yield chunk
		}
	}
	mockHandler.createMessage.mockReturnValue(generator())
}

function createMockRequest(prompt: string, command?: string) {
	return {
		prompt,
		command,
		references: [],
		toolReferences: [],
		toolInvocationToken: undefined,
		model: undefined,
	}
}

function createMockStreamApi() {
	return {
		markdown: vi.fn(),
	}
}

function createMockToken() {
	return {
		isCancellationRequested: false,
		onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	}
}

function createMockContext(history: any[] = []) {
	return { history }
}

describe("ZooCodeChatParticipant", () => {
	let participant: ZooCodeChatParticipant
	let outputChannel: any

	beforeEach(() => {
		// Reset call history but preserve implementations
		vi.clearAllMocks()
		// Re-establish default mock return values that clearAllMocks resets
		mockProviderSettingsManager.getProfile.mockResolvedValue({
			name: "test-profile",
			id: "test-id",
			apiProvider: "anthropic",
			apiModelId: "claude-sonnet-4-20250514",
		})
		mockContextProxy.getValues.mockReturnValue({ currentApiConfigName: "test-profile" })
		;(vscode.chat.createChatParticipant as any).mockReturnValue({
			iconPath: undefined,
			dispose: vi.fn(),
		})
		outputChannel = { appendLine: vi.fn() }
		participant = new ZooCodeChatParticipant(
			mockProviderSettingsManager as any,
			mockContextProxy as any,
			outputChannel,
		)
		// Default stream setup
		createMockStream([{ type: "text", text: "Hello!" }])
	})

	describe("activate", () => {
		it("should register the chat participant", () => {
			participant.activate({ subscriptions: [] } as any)

			expect(vscode.chat.createChatParticipant).toHaveBeenCalledWith("zoo-code.chat", expect.any(Function))
		})
	})

	describe("handleRequest", () => {
		// Access the private handler via the registered callback
		async function callHandler(request: any, chatContext: any, stream: any, token: any): Promise<any> {
			participant.activate({ subscriptions: [] } as any)
			const handler = vscode.chat.createChatParticipant.mock.calls[0][1]
			return handler(request, chatContext, stream, token)
		}

		it("should prompt when message is empty and no command", async () => {
			const stream = createMockStreamApi()
			const result = await callHandler(createMockRequest(""), createMockContext(), stream, createMockToken())

			expect(stream.markdown).toHaveBeenCalledWith(
				expect.stringContaining("Type a message to chat with Zoo Code"),
			)
			expect(result).toEqual({})
		})

		it("should return error when no provider is configured", async () => {
			mockContextProxy.getValues.mockReturnValue({ currentApiConfigName: undefined })
			const stream = createMockStreamApi()

			const result = await callHandler(createMockRequest("Hello"), createMockContext(), stream, createMockToken())

			expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining("No API provider configured"))
			expect(result).toEqual({ errorDetails: { message: "No API provider configured" } })
		})

		it("should stream text chunks from the provider", async () => {
			createMockStream([
				{ type: "text", text: "Hello " },
				{ type: "text", text: "world!" },
			])
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("Hi"), createMockContext(), stream, createMockToken())

			// Should have called markdown with model info + both text chunks
			const markdownCalls = stream.markdown.mock.calls.map((c: any[]) => c[0])
			expect(markdownCalls.some((s: string) => s.includes("test-model"))).toBe(true)
			expect(markdownCalls.some((s: string) => s.includes("Hello "))).toBe(true)
			expect(markdownCalls.some((s: string) => s.includes("world!"))).toBe(true)
		})

		it("should handle reasoning chunks", async () => {
			createMockStream([{ type: "reasoning", text: "Thinking..." }])
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("Why?"), createMockContext(), stream, createMockToken())

			const markdownCalls = stream.markdown.mock.calls.map((c: any[]) => c[0])
			expect(markdownCalls.some((s: string) => s.includes("Reasoning"))).toBe(true)
			expect(markdownCalls.some((s: string) => s.includes("Thinking..."))).toBe(true)
		})

		it("should handle usage chunks with cost", async () => {
			createMockStream([{ type: "usage", totalCost: 0.001234 }])
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("Hi"), createMockContext(), stream, createMockToken())

			const markdownCalls = stream.markdown.mock.calls.map((c: any[]) => c[0])
			expect(markdownCalls.some((s: string) => s.includes("$0.0012"))).toBe(true)
		})

		it("should handle error chunks", async () => {
			createMockStream([{ type: "error", message: "API rate limited" }])
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("Hi"), createMockContext(), stream, createMockToken())

			const markdownCalls = stream.markdown.mock.calls.map((c: any[]) => c[0])
			expect(markdownCalls.some((s: string) => s.includes("API rate limited"))).toBe(true)
		})

		it("should handle /clear command", async () => {
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("", "clear"), createMockContext(), stream, createMockToken())

			expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining("New Chat"))
		})

		it("should confirm mode switch and return early when no message", async () => {
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("", "architect"), createMockContext(), stream, createMockToken())

			const markdownCalls = stream.markdown.mock.calls.map((c: any[]) => c[0])
			expect(markdownCalls.some((s: string) => s.includes("Architect"))).toBe(true)
			expect(mockHandler.createMessage).not.toHaveBeenCalled()
		})

		it("should switch mode and process message when command has prompt", async () => {
			const stream = createMockStreamApi()

			await callHandler(
				createMockRequest("Plan a REST API", "architect"),
				createMockContext(),
				stream,
				createMockToken(),
			)

			// API should be called with architect mode system prompt
			expect(mockHandler.createMessage).toHaveBeenCalled()
			const sysPrompt = mockHandler.createMessage.mock.calls[0][0]
			expect(sysPrompt).toContain("experienced technical leader")
		})

		it("should default to Code mode when no mode command in history", async () => {
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("Hello"), createMockContext(), stream, createMockToken())

			expect(mockHandler.createMessage).toHaveBeenCalled()
			const sysPrompt = mockHandler.createMessage.mock.calls[0][0]
			expect(sysPrompt).toContain("highly skilled software engineer")
		})

		it("should persist mode from history when no current command", async () => {
			const stream = createMockStreamApi()
			// History contains a prior debug command
			const history = [
				new vscode.ChatRequestTurn("investigate", "debug"),
				new vscode.ChatResponseTurn([new vscode.ChatResponseMarkdownPart("Found it")]),
			]

			await callHandler(createMockRequest("Next step?"), createMockContext(history), stream, createMockToken())

			const sysPrompt = mockHandler.createMessage.mock.calls[0][0]
			expect(sysPrompt).toContain("expert software debugger")
		})

		it("should pass abortSignal in createMessage metadata", async () => {
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("Hi"), createMockContext(), stream, createMockToken())

			const metadata = mockHandler.createMessage.mock.calls[0][2]
			expect(metadata).toBeDefined()
			expect(metadata.abortSignal).toBeDefined()
			expect(metadata.taskId).toMatch(/^chat-/)
		})

		it("should build conversation history from ChatContext", async () => {
			const stream = createMockStreamApi()
			const history = [
				new vscode.ChatRequestTurn("What is X?"),
				new vscode.ChatResponseTurn([new vscode.ChatResponseMarkdownPart("X is a thing")]),
			]

			await callHandler(createMockRequest("Tell me more"), createMockContext(history), stream, createMockToken())

			const messages = mockHandler.createMessage.mock.calls[0][1]
			// history (2 turns) + current message = 3
			expect(messages).toHaveLength(3)
			expect(messages[0]).toEqual({ role: "user", content: "What is X?" })
			expect(messages[1]).toEqual({ role: "assistant", content: "X is a thing" })
			expect(messages[2]).toEqual({ role: "user", content: "Tell me more" })
		})

		it("should handle stream errors gracefully", async () => {
			// createMessage should return an async iterator that throws,
			// simulating a mid-stream error (not a synchronous throw)
			mockHandler.createMessage.mockReturnValue({
				async *[Symbol.asyncIterator]() {
					yield { type: "error", message: "Connection refused" }
				},
			})
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("Hi"), createMockContext(), stream, createMockToken())

			const markdownCalls = stream.markdown.mock.calls.map((c: any[]) => c[0])
			expect(markdownCalls.some((s: string) => s.includes("Error"))).toBe(true)
			expect(markdownCalls.some((s: string) => s.includes("Connection refused"))).toBe(true)
		})

		it("should stop streaming on cancellation", async () => {
			createMockStream([
				{ type: "text", text: "chunk1" },
				{ type: "text", text: "chunk2" },
				{ type: "text", text: "chunk3" },
			])
			const stream = createMockStreamApi()
			const token = createMockToken()
			// Simulate cancellation after first text chunk
			token.isCancellationRequested = false
			let callCount = 0
			const originalMarkdown = stream.markdown
			stream.markdown = vi.fn((s: string) => {
				callCount++
				if (callCount === 2) {
					// After model info + first text chunk, cancel
					token.isCancellationRequested = true
				}
				return originalMarkdown(s)
			})

			await callHandler(createMockRequest("Hi"), createMockContext(), stream, token)

			// Should not have processed chunk3
			const markdownCalls = stream.markdown.mock.calls.map((c: any[]) => c[0])
			expect(markdownCalls.some((s: string) => s.includes("chunk3"))).toBe(false)
		})

		it("should handle grounding chunks with sources", async () => {
			createMockStream([
				{
					type: "grounding",
					sources: [
						{ title: "Docs", url: "https://example.com/docs" },
						{ title: "Blog", url: "https://example.com/blog" },
					],
				},
			])
			const stream = createMockStreamApi()

			await callHandler(createMockRequest("Search"), createMockContext(), stream, createMockToken())

			const markdownCalls = stream.markdown.mock.calls.map((c: any[]) => c[0])
			expect(markdownCalls.some((s: string) => s.includes("Docs"))).toBe(true)
			expect(markdownCalls.some((s: string) => s.includes("Blog"))).toBe(true)
		})
	})

	describe("dispose", () => {
		it("should dispose without error", () => {
			expect(() => participant.dispose()).not.toThrow()
		})
	})
})
