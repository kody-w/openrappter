/**
 * Assistant — Copilot SDK-powered agent orchestration.
 *
 * Mirrors the Python function.py Assistant class:
 *  1. Collects all agents' metadata and wraps them as Copilot SDK tools (defineTool)
 *  2. Creates a CopilotClient session with those tools + a system prompt
 *  3. Sends user messages via session.sendAndWait()
 *  4. The SDK/LLM decides which tool to call → handler runs agent.execute()
 *  5. Results flow back through the SDK and the LLM produces the final response
 *
 * Falls back to keyword-matching chat() when the Copilot CLI is not available.
 */

import {
  CopilotClient,
  defineTool,
  type CopilotClientOptions,
  type SessionConfig,
  type Tool as CopilotTool,
} from '@github/copilot-sdk';
import type { BasicAgent } from './BasicAgent.js';

export interface AssistantConfig {
  /** Display name shown in system prompt */
  name?: string;
  /** Short personality / role description */
  description?: string;
  /** Model override (e.g. "gpt-4.1", "claude-sonnet-4.5") */
  model?: string;
  /** CopilotClient options (cliPath, cliUrl, githubToken, etc.) */
  clientOptions?: CopilotClientOptions;
  /** Whether to stream deltas (default true) */
  streaming?: boolean;
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
  private client: CopilotClient | null = null;
  private agentLogs: string[] = [];

  constructor(
    agents: Map<string, BasicAgent>,
    config?: AssistantConfig,
  ) {
    this.agents = agents;
    this.config = {
      name: config?.name ?? 'openrappter',
      description: config?.description ?? 'a helpful local-first AI assistant',
      model: config?.model,
      clientOptions: config?.clientOptions,
      streaming: config?.streaming ?? true,
    };
  }

  /** Reload agents (e.g. after hot-load) */
  setAgents(agents: Map<string, BasicAgent>): void {
    this.agents = agents;
  }

  /**
   * Main entry point — send a message and get a response.
   *
   * Creates a Copilot SDK session with all agents exposed as tools,
   * sends the message, and collects the final response.
   *
   * @param message      Current user message
   * @param onDelta      Optional callback for streaming text deltas
   * @param memoryContext Extra context to inject into the system prompt
   */
  async getResponse(
    message: string,
    onDelta?: (text: string) => void,
    memoryContext?: string,
  ): Promise<AssistantResponse> {
    this.agentLogs = [];

    // Build Copilot SDK tools from agent metadata
    const tools = this.buildCopilotTools();

    // Build system prompt
    const systemContent = this.buildSystemPrompt(memoryContext);

    // Create client if needed
    if (!this.client) {
      this.client = new CopilotClient(this.config.clientOptions);
    }

    // Create a session with tools and system message
    const sessionConfig: SessionConfig = {
      model: this.config.model,
      streaming: this.config.streaming,
      tools,
      systemMessage: {
        mode: 'append',
        content: systemContent,
      },
    };

    const session = await this.client.createSession(sessionConfig);

    // Collect the full response text
    let fullContent = '';

    if (this.config.streaming) {
      session.on('assistant.message_delta', (event) => {
        const delta = (event as { data?: { deltaContent?: string } }).data?.deltaContent ?? '';
        fullContent += delta;
        onDelta?.(delta);
      });
    }

    // Send the message and wait for the full response (SDK handles tool-call loop)
    const response = await session.sendAndWait({ prompt: message });

    // If not streaming, get content from the final response
    if (!this.config.streaming && response) {
      const data = response.data as { content?: string } | undefined;
      fullContent = data?.content ?? '';
    }

    return {
      content: fullContent,
      agentLogs: [...this.agentLogs],
    };
  }

  /** Gracefully shut down the Copilot CLI process */
  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /** Convert agent metadata into Copilot SDK tool definitions */
  private buildCopilotTools(): CopilotTool[] {
    const tools: CopilotTool[] = [];

    for (const agent of this.agents.values()) {
      if (!agent.metadata) continue;

      const agentName = agent.metadata.name;
      const agentRef = agent;
      const logs = this.agentLogs;

      tools.push(
        defineTool(agentName, {
          description: agent.metadata.description,
          parameters: agent.metadata.parameters as unknown as Record<string, unknown>,
          handler: async (args: unknown) => {
            const params = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
            try {
              const result = await agentRef.execute(params);
              const resultStr = result == null ? 'Agent completed successfully' : String(result);
              logs.push(`Performed ${agentName} → ${truncate(resultStr, 200)}`);
              return resultStr;
            } catch (err) {
              const errMsg = `Error: ${(err as Error).message}`;
              logs.push(`Performed ${agentName} → ${errMsg}`);
              return errMsg;
            }
          },
        }),
      );
    }

    return tools;
  }

  /** Build the system prompt content (appended to SDK defaults) */
  private buildSystemPrompt(memoryContext?: string): string {
    const agentList = Array.from(this.agents.values())
      .map((a) => `- **${a.metadata.name}**: ${a.metadata.description}`)
      .join('\n');

    const memoryBlock = memoryContext
      ? `\n<memory_context>\n${memoryContext}\n</memory_context>\n`
      : '';

    return `<identity>
You are ${this.config.name}, ${this.config.description}.
</identity>
${memoryBlock}
<available_agents>
${agentList}
</available_agents>

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
