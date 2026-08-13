import type {
  ImageContent,
  Message,
  SimpleStreamOptions,
  TextContent,
  ThinkingBudgets,
  Transport,
} from "../../llm-core/src/index.js";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import {
  EMPTY_USAGE,
  createMutableAgentState,
  defaultConvertToLlm,
  PendingMessageQueue,
  type ActiveRun,
  type AgentOptions,
  type MutableAgentState,
} from "./agent-state.js";
import { TranscriptNotContinuableError } from "./errors.js";
import { resolveAgentReasoningOption } from "./reasoning.js";
import { type AgentCoreStreamRuntimeDeps, resolveAgentCoreStreamFn } from "./runtime-deps.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentTool,
  AgentState,
  BeforeToolCallContext,
  BeforeToolCallResult,
  QueueMode,
  StreamFn,
  ToolExecutionMode,
} from "./types.js";

/** Stateful agent runtime, separated from the public state/queue definitions. */
export class Agent {
  private mutableState: MutableAgentState;
  private readonly listeners = new Set<
    (event: AgentEvent, signal: AbortSignal) => Promise<void> | void
  >();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;

  public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  public transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;
  public runtime?: AgentCoreStreamRuntimeDeps;
  public streamFn: StreamFn;
  public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  public onPayload?: SimpleStreamOptions["onPayload"];
  public onResponse?: SimpleStreamOptions["onResponse"];
  public beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  public resolveDeferredTool?: AgentLoopConfig["resolveDeferredTool"];
  public afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  public prepareNextTurn?: (
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  public shouldStopAfterTurn?: AgentLoopConfig["shouldStopAfterTurn"];
  private activeRun?: ActiveRun;
  private toolInventoryOwner?: {
    token: symbol;
    installed: readonly AgentTool[];
    previous: readonly AgentTool[];
  };
  /** Session identifier forwarded to providers for cache-aware backends. */
  public sessionId?: string;
  /** Optional per-level thinking token budgets forwarded to the stream function. */
  public thinkingBudgets?: ThinkingBudgets;
  /** Preferred transport forwarded to the stream function. */
  public transport: Transport;
  /** Optional cap for provider-requested retry delays. */
  public maxRetryDelayMs?: number;
  /** Tool execution strategy for assistant messages that contain multiple tool calls. */
  public toolExecution: ToolExecutionMode;

  constructor(options: AgentOptions = {}) {
    this.mutableState = createMutableAgentState(options.initialState);
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = options.transformContext;
    this.runtime = options.runtime;
    this.streamFn = resolveAgentCoreStreamFn(options.runtime, options.streamFn);
    this.getApiKey = options.getApiKey;
    this.onPayload = options.onPayload;
    this.onResponse = options.onResponse;
    this.beforeToolCall = options.beforeToolCall;
    this.resolveDeferredTool = options.resolveDeferredTool;
    this.afterToolCall = options.afterToolCall;
    this.prepareNextTurn = options.prepareNextTurn;
    this.shouldStopAfterTurn = options.shouldStopAfterTurn;
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    this.sessionId = options.sessionId;
    this.thinkingBudgets = options.thinkingBudgets;
    this.transport = options.transport ?? "auto";
    this.maxRetryDelayMs = options.maxRetryDelayMs;
    this.toolExecution = options.toolExecution ?? "parallel";
  }

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state(): AgentState {
    return this.mutableState;
  }

  set steeringMode(mode: QueueMode) {
    this.steeringQueue.mode = mode;
  }

  get steeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  set followUpMode(mode: QueueMode) {
    this.followUpQueue.mode = mode;
  }

  get followUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  steerKeyed(key: string, message: AgentMessage): void {
    this.steeringQueue.replaceOrEnqueue(key, message);
  }

  removeSteeringKey(key: string): void {
    this.steeringQueue.removeKey(key);
  }

  /** Installs a lifecycle-owned tool inventory and restores it only if unchanged. */
  installToolInventory(tools: readonly AgentTool[]): Readonly<{ restore(): void }> {
    if (this.toolInventoryOwner) {
      throw new Error("Agent tool inventory already has an owner");
    }
    const token = Symbol("agent-tool-inventory");
    const installed = [...tools];
    const previous = [...this.mutableState.tools];
    this.mutableState.tools = installed;
    this.toolInventoryOwner = { token, installed, previous };
    let restored = false;
    return Object.freeze({
      restore: () => {
        if (restored) {
          return;
        }
        restored = true;
        const owner = this.toolInventoryOwner;
        const current = this.mutableState.tools;
        if (!owner || owner.token !== token) {
          return;
        }
        this.toolInventoryOwner = undefined;
        if (
          current.length === installed.length &&
          current.every((tool, index) => tool === installed[index])
        ) {
          this.mutableState.tools = [...previous];
        }
      },
    });
  }

  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  clearSteeringQueue(): void {
    this.steeringQueue.clear();
  }

  clearFollowUpQueue(): void {
    this.followUpQueue.clear();
  }

  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  abort(): void {
    this.activeRun?.abortController.abort();
  }

  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  reset(): void {
    this.mutableState.messages = [];
    this.mutableState.isStreaming = false;
    this.mutableState.streamingMessage = undefined;
    this.mutableState.pendingToolCalls = new Set<string>();
    this.mutableState.errorMessage = undefined;
    this.clearFollowUpQueue();
    this.clearSteeringQueue();
  }

  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    const messages = this.normalizePromptInput(input, images);
    await this.runPromptMessages(messages);
  }

  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const lastMessage = this.mutableState.messages[this.mutableState.messages.length - 1];
    if (!lastMessage) {
      throw new Error("No messages to continue from");
    }

    if (lastMessage.role === "assistant") {
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }

      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runPromptMessages(queuedFollowUps);
        return;
      }

      throw new TranscriptNotContinuableError(lastMessage.role);
    }

    await this.runContinuation();
  }

  private normalizePromptInput(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): AgentMessage[] {
    if (Array.isArray(input)) {
      return input;
    }

    if (typeof input !== "string") {
      return [input];
    }

    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) {
      content.push(...images);
    }
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  private async runPromptMessages(
    messages: AgentMessage[],
    options: { skipInitialSteeringPoll?: boolean } = {},
  ): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.createContextSnapshot(),
        this.createLoopConfig(options),
        (event) => this.processEvents(event),
        signal,
        this.streamFn,
      );
    });
  }

  private async runContinuation(): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event) => this.processEvents(event),
        signal,
        this.streamFn,
      );
    });
  }

  private createContextSnapshot(): AgentContext {
    return {
      systemPrompt: this.mutableState.systemPrompt,
      messages: this.mutableState.messages.slice(),
      tools: this.mutableState.tools.slice(),
    };
  }

  private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
    return {
      model: this.mutableState.model,
      thinkingLevel: this.mutableState.thinkingLevel,
      reasoning: resolveAgentReasoningOption(
        this.mutableState.model,
        this.mutableState.thinkingLevel,
      ),
      sessionId: this.sessionId,
      onPayload: this.onPayload,
      onResponse: this.onResponse,
      transport: this.transport,
      thinkingBudgets: this.thinkingBudgets,
      maxRetryDelayMs: this.maxRetryDelayMs,
      toolExecution: this.toolExecution,
      beforeToolCall: this.beforeToolCall,
      resolveDeferredTool: this.resolveDeferredTool,
      afterToolCall: this.afterToolCall,
      prepareNextTurn: this.prepareNextTurn
        ? async () => await this.prepareNextTurn?.(this.signal)
        : undefined,
      shouldStopAfterTurn: this.shouldStopAfterTurn
        ? async (context) => (await this.shouldStopAfterTurn?.(context)) === true
        : undefined,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: this.getApiKey,
      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.steeringQueue.drain();
      },
      getFollowUpMessages: async () => this.followUpQueue.drain(),
    };
  }

  private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing.");
    }

    const abortController = new AbortController();
    let resolvePromise = () => {};
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.activeRun = { promise, resolve: resolvePromise, abortController };

    this.mutableState.isStreaming = true;
    this.mutableState.streamingMessage = undefined;
    this.mutableState.errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const failureMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: this.mutableState.model.api,
      provider: this.mutableState.model.provider,
      model: this.mutableState.model.id,
      usage: EMPTY_USAGE,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    } satisfies AgentMessage;
    await this.processEvents({ type: "message_start", message: failureMessage });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  private finishRun(): void {
    this.mutableState.isStreaming = false;
    this.mutableState.streamingMessage = undefined;
    this.mutableState.pendingToolCalls = new Set<string>();
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
      case "tool_execution_update":
        break;

      case "message_start":
        this.mutableState.streamingMessage = event.message;
        break;

      case "message_update":
        this.mutableState.streamingMessage = event.message;
        break;

      case "message_end":
        this.mutableState.streamingMessage = undefined;
        this.mutableState.messages.push(event.message);
        break;

      case "tool_execution_start": {
        const pendingToolCalls = new Set(this.mutableState.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this.mutableState.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "tool_execution_end": {
        const pendingToolCalls = new Set(this.mutableState.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this.mutableState.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this.mutableState.errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this.mutableState.streamingMessage = undefined;
        break;
    }

    const signal = this.activeRun?.abortController.signal;
    if (!signal) {
      throw new Error("Agent listener invoked outside active run");
    }
    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }
}
