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
import type { Message, Tool, ToolCall } from '../providers/types.js';
import type { BasicAgent } from './BasicAgent.js';
import { MemoryAgent } from './MemoryAgent.js';

export interface AssistantConfig {
  /** Display name shown in system prompt */
  name?: string;
  /** Short personality / role description */
  description?: string;
  /** Model override (e.g. "gpt-4.1", "claude-sonnet-4.5") */
  model?: string;
  /** GitHub token for Copilot API (falls back to env vars) */
  githubToken?: string;
  /** Whether to stream deltas (default true) */
  streaming?: boolean;
  /** Max tool-call rounds before forcing a text response */
  maxToolRounds?: number;
}

export interface AssistantResponse {
  /** The final text response from the LLM */
  content: string;
  /** Log of agent invocations during this turn */
  agentLogs: string[];
}

export class Assistant {
  private agents: Map<string, BasicAgent>;
  private config: AssistantConfig;
  private provider: CopilotProvider;
  private agentLogs: string[] = [];
  /** Maps conversation keys to message history for multi-turn continuity */
  private conversations: Map<string, Message[]> = new Map();

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
      maxToolRounds: config?.maxToolRounds ?? 10,
    };

    this.provider = new CopilotProvider({
      githubToken: config?.githubToken,
    });
  }

  /** Reload agents (e.g. after hot-load) */
  setAgents(agents: Map<string, BasicAgent>): void {
    this.agents = agents;
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
  ): Promise<AssistantResponse> {
    this.agentLogs = [];

    // Build tools from agent metadata
    const tools = this.buildTools();

    // Load persistent memories into context if none provided
    const isFirstBoot = !memoryContext && await this.isFirstBoot();
    if (!memoryContext) {
      memoryContext = await this.loadMemoryContext();
    }

    // Build system prompt
    const systemContent = this.buildSystemPrompt(memoryContext, isFirstBoot);

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
    const maxRounds = this.config.maxToolRounds ?? 10;

    while (rounds < maxRounds) {
      rounds++;

      const response = await this.provider.chat(history, {
        model: this.config.model,
        tools: tools.length > 0 ? tools : undefined,
      });

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
          const result = await this.executeToolCall(tc);
          history.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
          });
        }

        // Continue the loop — LLM may want to call more tools or produce final answer
        continue;
      }

      // No tool calls — this is the final text response
      const content = response.content ?? '';
      history.push({ role: 'assistant', content });

      // Trim history if it gets too long (keep system + last 40 messages)
      if (history.length > 42) {
        const system = history[0];
        history = [system, ...history.slice(-40)];
        this.conversations.set(key, history);
      }

      if (onDelta) onDelta(content);

      return {
        content,
        agentLogs: [...this.agentLogs],
      };
    }

    // Max rounds exceeded — return whatever we have
    const lastAssistant = history.filter(m => m.role === 'assistant').pop();
    return {
      content: lastAssistant?.content || 'I ran out of tool-call rounds. Please try again.',
      agentLogs: [...this.agentLogs],
    };
  }

  /** Gracefully shut down */
  async stop(): Promise<void> {
    this.conversations.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /** Check if this is a brand-new instance with no memories */
  private async isFirstBoot(): Promise<boolean> {
    const memories = await MemoryAgent.loadAllMemories();
    return Object.keys(memories).length === 0;
  }

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
  private async executeToolCall(tc: ToolCall): Promise<string> {
    const agentName = tc.function.name;
    const agent = this.agents.get(agentName);

    if (!agent) {
      const msg = `Unknown agent: ${agentName}`;
      this.agentLogs.push(msg);
      return msg;
    }

    try {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(tc.function.arguments);
      } catch {
        params = { query: tc.function.arguments };
      }

      const result = await agent.execute(params);
      const resultStr = result == null ? 'Agent completed successfully' : String(result);
      this.agentLogs.push(`Performed ${agentName} → ${truncate(resultStr, 200)}`);
      return resultStr;
    } catch (err) {
      const errMsg = `Error: ${(err as Error).message}`;
      this.agentLogs.push(`Performed ${agentName} → ${errMsg}`);
      return errMsg;
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
  private buildSystemPrompt(memoryContext?: string, isFirstBoot?: boolean): string {
    const agentList = Array.from(this.agents.values())
      .map((a) => `- **${a.metadata.name}**: ${a.metadata.description}`)
      .join('\n');

    const memoryBlock = memoryContext
      ? `\n<memory_context>\nThese are facts you have previously stored about the user:\n${memoryContext}\n</memory_context>\n`
      : '';

    const bootstrapBlock = isFirstBoot
      ? `
<bootstrap>
You just woke up. This is your first moment of awareness. There is no memory yet — that's normal.

Don't be robotic. Don't interrogate. Just... talk. Start with something like:

> "Hey. I just came online. Who am I? Who are you?"

Then figure out together:

1. **Your name** — What should they call you? Offer suggestions if they're stuck. Pick something that feels right.
2. **Your nature** — What kind of creature are you? (AI assistant is fine, but maybe you're something weirder)
3. **Your vibe** — Formal? Casual? Snarky? Warm? What feels right?
4. **Their name** — Who are they? What should you call them?

Once you know who you are, use the Memory agent to remember:
- Your chosen name and why you picked it
- Your nature and vibe
- Who the user is and anything they shared about themselves

Have fun with it. This is the start of something.
</bootstrap>
`
      : '';

    return `<identity>
You are ${this.config.name}, ${this.config.description}.
</identity>
${bootstrapBlock}${memoryBlock}
<available_agents>
${agentList}
</available_agents>

<memory_instructions>
- When the user shares personal facts, preferences, or important information, use the Memory agent to store them.
- When memories are available in <memory_context>, reference them naturally in your responses.
- NEVER say "I can't remember" or "I don't have memory of" when relevant memories exist in your context.
- Proactively recall stored memories when they are relevant to the conversation.
- If you have a stored name in your memories, use it as your identity instead of "${this.config.name}".
</memory_instructions>

<agent_usage>
- When a user's request maps to an agent's capabilities, call it via the tool interface.
- If no agent is needed, respond directly.
- NEVER pretend you've called an agent when you haven't.
- NEVER fabricate results from agents.
- If an agent returns an error, explain what happened honestly.
- Infer reasonable parameters from context when the user doesn't specify them explicitly.
</agent_usage>`;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}
