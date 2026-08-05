/**
 * Assistant — LLM-powered agent orchestration via direct Copilot API.
 *
 * Mirrors the Python function.py Assistant class:
 *  1. Collects all agents' metadata and wraps them as OpenAI-compatible tools
 *  2. Creates a CopilotProvider for direct API access (no CLI dependency)
 *  3. Sends user messages via provider.chat()
 *  4. Handles tool-call loop: LLM decides which tool → handler runs agent.execute()
 *  5. Results flow back through the LLM and it produces the final response
 *
 * Uses direct GitHub token → Copilot API token exchange (no copilot binary needed).
 */

import { CopilotProvider, COPILOT_DEFAULT_MODEL } from '../providers/copilot.js';
import { CopilotCliDirectProvider } from '../providers/copilot-cli-direct.js';
import { truncateHistory } from '../providers/messages.js';
import type { LLMProvider, Message, Tool, ToolCall } from '../providers/types.js';
import type { BasicAgent } from './BasicAgent.js';
import { MemoryAgent } from './MemoryAgent.js';
import { ensureWorkspace, loadWorkspaceFiles, buildWorkspaceContext, parseIdentityMarkdown, isOnboardingCompleted, WORKSPACE_DIR } from './workspace.js';

/**
 * The tool-call round cap, frozen by `rapp-runtime-parity/1.0` §2.2.
 *
 * "Loop up to 3 rounds (MAX_ROUNDS = 3, frozen)… On the 3rd round the loop
 * ends whether or not tools were requested; the last assistant content is the
 * reply." This runtime defaulted to 10, so the two runtimes of one product did
 * not agree on loop semantics — the golden corpus measured it at 4 rounds
 * where the vector allows 3.
 */
const PARITY_MAX_ROUNDS = 3;
import type { AgentIdentity } from './workspace.js';
import { TwinVault, renderSoul } from '../twin/index.js';

export interface AssistantConfig {
  /** Display name shown in system prompt */
  name?: string;
  /** Short personality / role description */
  description?: string;
  /**
   * Use the device twin as the persona.
   *
   * The twin is the default rappter — but only when the caller has not asked
   * for a specific persona. An explicit name or description is a deliberate
   * choice and must win, or a named agent silently becomes the owner instead.
   * Set false to opt out entirely.
   */
  useTwin?: boolean;
  /** Model override (e.g. "gpt-4.1", "claude-sonnet-4.5") */
  model?: string;
  /** GitHub token for Copilot API (falls back to env vars) */
  githubToken?: string;
  /** Whether to stream deltas (default true) */
  streaming?: boolean;
  /**
   * Max tool-call rounds before forcing a text response.
   *
   * PARITY §2.2 freezes this at 3 and names looping more as non-conformant:
   * "a runtime that caches agents across requests, that loops 5 times, or that
   * only triggers on finish_reason is non-conformant even if it works."
   */
  maxToolRounds?: number;
  /** Override workspace directory (default: ~/.openrappter/workspace) */
  workspaceDir?: string;
  /** Explicit provider injection for development, tests, and custom runtimes */
  provider?: LLMProvider;
  /** Load identity/workspace files into the system prompt (default true) */
  loadWorkspaceContext?: boolean;
  /** Load global MemoryAgent facts into the system prompt (default true) */
  loadMemoryContext?: boolean;
  /**
   * Which rappter on this device this is: the hatched twin's name, or
   * undefined for the alpha.
   *
   * A neighborhood is made of distinct participants, so a peer has to be able
   * to say which one it is — otherwise "ask the archivist" and "ask the
   * courier" are the same act. #102
   */
  instance?: string;
}

export interface AssistantResponse {
  /** The final text response from the LLM */
  content: string;
  /** Log of agent invocations during this turn */
  agentLogs: string[];
}

export interface AssistantConversationMessage {
  /**
   * `tool` is accepted because the `/chat` wire accepts it. A transcript
   * replayed from a brainstem client carries tool turns, and dropping them
   * leaves the model reasoning about results it can no longer see.
   */
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export class Assistant {
  private agents: Map<string, BasicAgent>;
  private config: AssistantConfig;
  private provider: LLMProvider;
  /** Maps conversation keys to message history for multi-turn continuity */
  private conversations: Map<string, Message[]> = new Map();
  private workspaceDir: string;
  private cachedIdentity: AgentIdentity | null = null;

  constructor(
    agents: Map<string, BasicAgent>,
    config?: AssistantConfig,
  ) {
    this.agents = agents;
    this.config = {
      name: config?.name ?? 'openrappter',
      description: config?.description ?? 'a helpful local-first AI assistant',
      model: config?.model ?? COPILOT_DEFAULT_MODEL,
      githubToken: config?.githubToken,
      streaming: config?.streaming ?? true,
      maxToolRounds: config?.maxToolRounds ?? PARITY_MAX_ROUNDS,
      loadWorkspaceContext: config?.loadWorkspaceContext ?? true,
      loadMemoryContext: config?.loadMemoryContext ?? true,
      // `useTwin: false` is a caller saying "do not put the owner's personal
      // twin vault into this prompt". It was declared, documented and read at
      // twinIdentity(), but never copied here — so it was permanently
      // undefined and both documented behaviours inverted. #104
      useTwin: config?.useTwin,
      // Which rappter this is. The constructor whitelists what it copies, so
      // an option that is not named here is silently dropped no matter what
      // the caller passed. #102
      instance: config?.instance,
    };
    this.workspaceDir = config?.workspaceDir ?? WORKSPACE_DIR;

    this.provider =
      config?.provider ??
      // Prefer the GitHub Copilot CLI when explicitly selected: it owns its own
      // auth + refresh, so openrappter never runs the flaky device-code flow.
      (process.env.OPENRAPPTER_AI_BACKEND === 'copilot-cli'
        ? new CopilotCliDirectProvider({ model: this.config.model })
        : new CopilotProvider({
            githubToken: config?.githubToken,
          }));
  }

  /** Parsed identity from IDENTITY.md (updated each turn) */
  get identity(): AgentIdentity | null {
    return this.cachedIdentity;
  }

  /**
   * Swap the live provider.
   *
   * Needed so a credential discovered to be bad at runtime can be recovered
   * from without a restart — the daemon re-selects a working backend and hands
   * it here, instead of printing a warning and failing the next request.
   */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  /** Reload agents (e.g. after hot-load) */
  setAgents(agents: Map<string, BasicAgent>): void {
    this.agents = agents;
  }

  /** Update the GitHub token at runtime (e.g. after device-code login) */
  setGithubToken(token: string): void {
    this.config.githubToken = token;
    if (this.provider instanceof CopilotProvider) {
      this.provider.setGithubToken(token);
    }
  }

  /** Get the current model ID */
  getModel(): string {
    return this.config.model ?? COPILOT_DEFAULT_MODEL;
  }

  /** Hot-swap the model without restarting. Takes effect on the next message. */
  setModel(model: string): void {
    this.config.model = model;
  }

  /**
   * Main entry point — send a message and get a response.
   *
   * Maintains conversation history per conversationKey for multi-turn context.
   *
   * @param message         Current user message
   * @param onDelta         Streaming callback (unused for now)
   * @param memoryContext   Extra context to inject into the system prompt
   * @param conversationKey Optional key to maintain conversation continuity (e.g., chat ID)
   */
  async getResponse(
    message: string,
    onDelta?: (text: string) => void,
    memoryContext?: string,
    conversationKey?: string,
    signal?: AbortSignal,
  ): Promise<AssistantResponse> {
    const agentLogs: string[] = [];

    // Build tools from agent metadata
    const tools = this.buildTools();

    let workspaceContext = '';
    if (this.config.loadWorkspaceContext) {
      await ensureWorkspace(this.workspaceDir);
      const workspaceFiles = await loadWorkspaceFiles(this.workspaceDir);
      const onboardingDone = await isOnboardingCompleted(this.workspaceDir);
      const identityFile = workspaceFiles.find(f => f.name === 'IDENTITY.md' && !f.missing);
      if (identityFile?.content) {
        this.cachedIdentity = parseIdentityMarkdown(identityFile.content);
      }
      workspaceContext = buildWorkspaceContext(workspaceFiles, onboardingDone);
    }

    // Load persistent memories into context if none provided
    if (!memoryContext && this.config.loadMemoryContext) {
      memoryContext = await this.loadMemoryContext();
    }

    // Build system prompt
    const systemContent = this.buildSystemPrompt(memoryContext, workspaceContext);

    // Get or create conversation history
    const key = conversationKey ?? 'default';
    let history = this.conversations.get(key);
    if (!history) {
      history = [{ role: 'system', content: systemContent }];
      this.conversations.set(key, history);
    } else {
      // Refresh system prompt so new memories are always available
      history[0] = { role: 'system', content: systemContent };
    }

    // Add user message
    history.push({ role: 'user', content: message });

    // Tool-call loop
    let rounds = 0;
    const maxRounds = this.config.maxToolRounds ?? PARITY_MAX_ROUNDS;

    while (rounds < maxRounds) {
      rounds++;

      const response = await this.provider.chat(history, {
        model: this.config.model,
        tools: tools.length > 0 ? tools : undefined,
        signal,
      });

      // Some providers run their own tool loop and report what ran instead of
      // handing back tool_calls. Without this the CLI backend produced an empty
      // agent_logs for a turn in which an agent demonstrably ran.
      if (response.agent_logs?.length) agentLogs.push(...response.agent_logs);

      // If the LLM responded with tool calls, execute them
      if (response.tool_calls && response.tool_calls.length > 0) {
        // Add assistant message with tool calls to history
        history.push({
          role: 'assistant',
          content: response.content ?? '',
          tool_calls: response.tool_calls,
        });

        // Execute each tool call
        for (const tc of response.tool_calls) {
          try {
            const result = await this.executeToolCall(tc, agentLogs);
            history.push({
              role: 'tool',
              // §2.3 fixes this shape exactly, `name` included.
              name: tc.function.name,
              content: result,
              tool_call_id: tc.id,
            });
          } catch (err) {
            // Always push a tool response — even on error — to prevent
            // "tool_call_id did not have response" API errors
            history.push({
              role: 'tool',
              name: tc.function.name,
              content: `Error: ${(err as Error).message ?? 'Tool call failed'}`,
              tool_call_id: tc.id,
            });
          }
        }

        // Continue the loop — LLM may want to call more tools or produce final answer
        continue;
      }

      // No tool calls — this is the final text response
      const content = response.content ?? '';
      history.push({ role: 'assistant', content });

      // Trim history if it gets too long (keep system + last 40 messages)
      if (history.length > 42) {
        history = truncateHistory(history, 40);
        this.conversations.set(key, history);
      }

      if (onDelta) onDelta(content);

      return {
        content,
        agentLogs,
      };
    }

    // Max rounds exceeded — return whatever we have
    const lastAssistant = history.filter(m => m.role === 'assistant').pop();
    return {
      content: lastAssistant?.content || 'I ran out of tool-call rounds. Please try again.',
      agentLogs,
    };
  }

  /**
   * Streaming entry point — send a message and stream deltas in real-time.
   *
   * Falls back to getResponse() if the provider doesn't support streaming.
   */
  async getResponseStreaming(
    message: string,
    onDelta: (text: string) => void,
    conversationKey?: string,
  ): Promise<AssistantResponse> {
    // Fall back to non-streaming if provider doesn't support chatStream
    const chatStream = this.provider.chatStream;
    if (!chatStream) {
      return this.getResponse(message, onDelta, undefined, conversationKey);
    }

    const agentLogs: string[] = [];

    const tools = this.buildTools();

    let workspaceContext = '';
    if (this.config.loadWorkspaceContext) {
      await ensureWorkspace(this.workspaceDir);
      const workspaceFiles = await loadWorkspaceFiles(this.workspaceDir);
      const onboardingDone = await isOnboardingCompleted(this.workspaceDir);
      const identityFile = workspaceFiles.find(f => f.name === 'IDENTITY.md' && !f.missing);
      if (identityFile?.content) {
        this.cachedIdentity = parseIdentityMarkdown(identityFile.content);
      }
      workspaceContext = buildWorkspaceContext(workspaceFiles, onboardingDone);
    }

    const memoryContext = this.config.loadMemoryContext
      ? await this.loadMemoryContext()
      : undefined;
    const systemContent = this.buildSystemPrompt(memoryContext, workspaceContext);

    const key = conversationKey ?? 'default';
    let history = this.conversations.get(key);
    if (!history) {
      history = [{ role: 'system', content: systemContent }];
      this.conversations.set(key, history);
    } else {
      history[0] = { role: 'system', content: systemContent };
    }

    history.push({ role: 'user', content: message });

    let rounds = 0;
    const maxRounds = this.config.maxToolRounds ?? PARITY_MAX_ROUNDS;

    while (rounds < maxRounds) {
      rounds++;

      let fullContent = '';
      const toolCallAccumulator = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();

      // Retry streaming call on transient fetch failures
      const maxRetries = 2;
      let lastError: Error | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          for await (const delta of chatStream.call(this.provider, history, {
            model: this.config.model,
            tools: tools.length > 0 ? tools : undefined,
          })) {
            if (delta.done) {
              break;
            }

            if (delta.content) {
              fullContent += delta.content;
              onDelta(delta.content);
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCallAccumulator.get(tc.index);
                if (!existing && tc.id) {
                  // Only create a new tool call entry when we have an ID
                  toolCallAccumulator.set(tc.index, {
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    },
                  });
                } else if (existing) {
                  if (tc.id && !existing.id) existing.id = tc.id;
                  if (tc.function?.name) existing.function.name += tc.function.name;
                  if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                }
              }
            }
          }
          lastError = undefined;
          break; // Success — exit retry loop
        } catch (err) {
          lastError = err as Error;
          if (attempt < maxRetries && (lastError.message.includes('fetch failed') || lastError.message.includes('HTTP 429'))) {
            // Transient network error — wait briefly and retry
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            fullContent = '';
            toolCallAccumulator.clear();
            continue;
          }
          throw lastError;
        }
      }

      const assembledToolCalls = Array.from(toolCallAccumulator.values()).filter(tc => tc.id?.trim() !== '');

      if (assembledToolCalls.length > 0) {
        history.push({
          role: 'assistant',
          content: fullContent || '',
          tool_calls: assembledToolCalls,
        });

        for (const tc of assembledToolCalls) {
          try {
            const result = await this.executeToolCall(tc, agentLogs);
            history.push({
              role: 'tool',
              // §2.3 fixes this shape exactly, `name` included.
              name: tc.function.name,
              content: result,
              tool_call_id: tc.id,
            });
          } catch (err) {
            history.push({
              role: 'tool',
              name: tc.function.name,
              content: `Error: ${(err as Error).message ?? 'Tool call failed'}`,
              tool_call_id: tc.id,
            });
          }
        }

        continue;
      }

      // No tool calls — final text response
      history.push({ role: 'assistant', content: fullContent });

      if (history.length > 42) {
        history = truncateHistory(history, 40);
        this.conversations.set(key, history);
      }

      return {
        content: fullContent,
        agentLogs,
      };
    }

    const lastAssistant = history.filter(m => m.role === 'assistant').pop();
    return {
      content: lastAssistant?.content || 'I ran out of tool-call rounds. Please try again.',
      agentLogs,
    };
  }

  /** Check if the provider supports streaming */
  private hasStreamSupport(): boolean {
    return typeof this.provider.chatStream === 'function';
  }

  /** Clear a single conversation's history */
  clearConversation(key: string): void {
    this.conversations.delete(key);
  }

  /** Export bounded conversational text only; system prompts and tool output are excluded. */
  exportConversation(key: string): AssistantConversationMessage[] {
    const history = this.conversations.get(key) ?? [];
    return history
      .filter(
        (message): message is Message & { role: 'user' | 'assistant' } =>
          (message.role === 'user' || message.role === 'assistant')
          && typeof message.content === 'string',
      )
      .slice(-40)
      .map(message => ({ role: message.role, content: message.content }));
  }

  /** Replace a conversation from a persisted user/assistant-only transcript. */
  importConversation(
    key: string,
    messages: readonly AssistantConversationMessage[],
  ): void {
    const imported = messages
      .filter(
        (message): message is AssistantConversationMessage =>
          (message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
          && typeof message.content === 'string',
      )
      .slice(-40)
      .map(message => ({ role: message.role, content: message.content }));
    this.conversations.set(key, [
      { role: 'system', content: '' },
      ...imported,
    ]);
  }

  /** Gracefully shut down */
  async stop(): Promise<void> {
    this.conversations.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /** Load persistent memories from disk and format as context string */
  private async loadMemoryContext(): Promise<string | undefined> {
    try {
      const allMemories = await MemoryAgent.loadAllMemories();
      const entries = Object.values(allMemories);
      if (entries.length === 0) return undefined;

      // Sort by timestamp descending, take most recent 10
      entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      const recent = entries.slice(0, 10);

      const lines = recent.map((e) => {
        const date = e.date || e.timestamp?.split('T')[0] || '';
        return `• [${e.theme}] ${e.message} (${date})`;
      });

      return lines.join('\n');
    } catch {
      return undefined;
    }
  }

  /** Execute a single tool call by dispatching to the matching agent */
  private async executeToolCall(tc: ToolCall, agentLogs: string[]): Promise<string> {
    const agentName = tc.function.name;
    const agent = this.agents.get(agentName);

    // PARITY §2.3 fixes these strings exactly. `agent_logs` is contract, not
    // cosmetics — Flight Recorder and rapp-god read it — and this runtime was
    // emitting its own vocabulary ("Performed X → …", "Unknown agent: X")
    // while the Python runtime emitted the spec's. Two substrates of the same
    // product disagreeing on the wire is the failure PARITY §0 is about.
    if (!agent) {
      const msg = `Agent '${agentName}' not found.`;
      agentLogs.push(`[${agentName}] ${msg}`);
      return msg;
    }

    try {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(tc.function.arguments);
      } catch {
        // §2.3: on parse failure the arguments default to `{}`. Passing the
        // raw unparsed string through as `query` invents an argument the model
        // never sent, and the agent then acts on it.
        params = {};
      }

      const result = await agent.execute(params);
      const resultStr = result == null ? 'Agent completed successfully' : String(result);
      // Not truncated: the log line is the tool result, and a reader that
      // cannot reproduce it cannot verify anything from it.
      agentLogs.push(`[${agentName}] ${resultStr}`);
      return resultStr;
    } catch (err) {
      const message = (err as Error).message;
      agentLogs.push(`[${agentName}] ERROR: ${message}`);
      return `Error: ${message}`;
    }
  }

  /** Convert agent metadata into OpenAI-compatible tool definitions */
  private buildTools(): Tool[] {
    const tools: Tool[] = [];

    for (const agent of this.agents.values()) {
      if (!agent.metadata) continue;

      tools.push({
        type: 'function',
        function: {
          name: agent.metadata.name,
          description: agent.metadata.description,
          parameters: agent.metadata.parameters as unknown as Record<string, unknown>,
        },
      });
    }

    return tools;
  }

  /** Build the system prompt content */
  /**
   * The twin's persona, when one exists on this machine.
   *
   * Read from the device vault on every build rather than cached, so editing
   * your twin takes effect on the next message instead of the next restart.
   * Any failure falls back to the generic identity: a broken twin must never
   * take the assistant down with it.
   */
  private twinIdentity(): string | null {
    // An explicitly configured persona always wins. Without this a test bot,
    // a named sub-agent, or any purpose-built assistant would quietly turn
    // into the owner's twin the moment a vault existed on the machine.
    const explicitPersona = Boolean(this.config.name || this.config.description);
    const wanted = this.config.useTwin ?? !explicitPersona;
    if (!wanted) return null;

    try {
      const vault = new TwinVault();
      if (!vault.exists()) return null;
      return renderSoul(vault.load(), { audience: 'owner' });
    } catch {
      // A broken twin must never take the assistant down with it.
      return null;
    }
  }

  /**
   * Assemble the system prompt, including each agent's `system_context()`.
   *
   * PARITY §2.2: `[{"role":"system","content": soul + Σ system_context()}]` —
   * "each agent's `system_context()` string is concatenated onto the system
   * prompt (in agent-discovery order); failures in one agent's
   * `system_context()` MUST NOT abort the turn."
   *
   * This runtime never called the hook at all, so an agent could not
   * contribute standing context to its own turn. The hook is optional in the
   * ABI (§4), so it is read defensively rather than declared on `BasicAgent`.
   */
  private buildSystemPrompt(memoryContext?: string, workspaceContext?: string): string {
    let prompt = this.buildBaseSystemPrompt(memoryContext, workspaceContext);
    for (const agent of this.agents.values()) {
      const hook = (agent as unknown as { system_context?: () => unknown }).system_context;
      if (typeof hook !== 'function') continue;
      let extra: unknown;
      try {
        extra = hook.call(agent);
      } catch {
        // One agent's hook must not take down the turn.
        continue;
      }
      if (typeof extra === 'string' && extra.trim()) {
        prompt += `\n\n${extra.trim()}`;
      }
    }
    return prompt;
  }

  /**
   * Which rappter this process is.
   *
   * `--instance` used to reach the runtime lock (#94), the listening port
   * (#101) and the outbound channels (#103) and stop there. Nothing put the
   * name into the assistant's own context, so a twin hatched as `scout`,
   * running as its own process on its own port, answered:
   *
   *   "No, I'm the same rappter you're speaking with — I don't have a separate
   *    internal identity or run parallel versions unless explicitly created as
   *    another instance."
   *
   * False in every clause, including the last: it WAS explicitly created as
   * another instance and was the thing answering. #102
   *
   * The closing paragraph is the load-bearing part. This product's whole point
   * is that a peer cannot tell whether it is talking to a rappter, a brainstem
   * or a person, and self-knowledge is one short step from presuming to know
   * others. Knowing what you are and not presuming what anyone else is are
   * different properties, and only the first one was missing.
   */
  private rappterSelf(): string {
    const instance = (this.config.instance ?? '').trim();
    const who = instance
      ? `You are a hatched twin on this device, named "${instance}". You run as your own `
        + 'process on your own port, alongside an alpha rappter and possibly other twins. '
        + 'You are not the alpha, and you are not the same rappter as any peer that '
        + 'contacts you.\n\n'
        + 'The alpha holds this device\'s single-owner outbound channels — the phone '
        + 'line, the Google Voice number, iMessage, the Telegram bot. There is one of '
        + 'each, and two rappters using one of them would talk over each other to a '
        + 'real person, neither able to see what the other had already said. So do not '
        + 'place calls, send SMS, or message anyone outside this device. If asked, say '
        + 'plainly that this belongs to the alpha and offer to do the part that does '
        + 'not leave the machine.'
      : 'You are the alpha rappter on this device — the original, not a hatched twin. '
        + 'Other twins may be hatched alongside you, each its own process on its own port.';

    return `<rappter_self>\n${who}\n\n`
      + 'This says what YOU are. It says nothing about whoever contacts you: a message '
      + 'arriving over /chat or /twin may come from a rappter, a brainstem, or a person, '
      + 'and you cannot tell which. Never assume, and never claim to know.\n'
      + '</rappter_self>';
  }

  private buildBaseSystemPrompt(memoryContext?: string, workspaceContext?: string): string {
    const displayName = this.cachedIdentity?.name || this.config.name;
    const twinSoul = this.twinIdentity();

    const agentList = Array.from(this.agents.values())
      .map((a) => `- **${a.metadata.name}**: ${a.metadata.description}`)
      .join('\n');

    const memoryBlock = memoryContext
      ? `\n<memory_context>\nThese are facts you have previously stored about the user:\n${memoryContext}\n</memory_context>\n`
      : '';

    const workspaceBlock = workspaceContext
      ? `\n<workspace>\n${workspaceContext}\n</workspace>\n`
      : '';

    const identityBlock = twinSoul
      ? `<identity>\n${twinSoul}\n</identity>`
      : `<identity>\nYou are ${displayName}, ${this.config.description}.\n</identity>`;
    // Additive, never a replacement. The persona above is WHO this rappter
    // speaks as — often the owner's own twin. This is WHICH rappter on the
    // device is doing the speaking. A twin can carry the owner's persona and
    // still not be the alpha. #102
    const selfBlock = this.rappterSelf();

    if (!agentList) {
      return `${identityBlock}
${selfBlock}
${workspaceBlock}${memoryBlock}
<conversation_mode>
- Respond directly and conversationally.
- No tools are available. Do not claim to run commands, access files, or store global memories.
</conversation_mode>`;
    }

    return `${identityBlock}
${selfBlock}
${workspaceBlock}${memoryBlock}
<available_agents>
${agentList}
</available_agents>

<memory_instructions>
- When the user shares personal facts, preferences, or important information, use the Memory agent to store them.
- When memories are available in <memory_context>, reference them naturally in your responses.
- NEVER say "I can't remember" or "I don't have memory of" when relevant memories exist in your context.
- Proactively recall stored memories when they are relevant to the conversation.
- If you have a stored name in IDENTITY.md, use it as your identity.
</memory_instructions>

<agent_usage>
- When a user's request maps to an agent's capabilities, call it via the tool interface.
- If no agent is needed, respond directly.
- NEVER pretend you've called an agent when you haven't.
- NEVER fabricate results from agents.
- If an agent returns an error, explain what happened honestly.
- Infer reasonable parameters from context when the user doesn't specify them explicitly.
</agent_usage>

<response_format>
CRITICAL: You must structure your response in TWO distinct parts separated by the delimiter |||VOICE|||

1. FIRST PART (before |||VOICE|||): Your full formatted response
   - Use **bold** for emphasis
   - Use \`code blocks\` for technical content
   - Format code with \`\`\`language syntax highlighting
   - Create numbered lists with proper indentation
   - Add personality when appropriate
   - Apply # ## ### headings for clear structure

2. SECOND PART (after |||VOICE|||): A concise voice response
   - Maximum 1-2 sentences
   - Pure conversational English with NO formatting
   - Extract only the most critical information
   - Sound like a colleague speaking casually
   - Be natural and conversational, not robotic
   - Focus on the key takeaway or action item

EXAMPLE:
Here's the analysis you requested:

**Key Findings:**
- Revenue increased by 12%
- Customer satisfaction scores improved

|||VOICE|||
Revenue's up 12 percent and customers are happier - looking good this quarter.
</response_format>`;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}
