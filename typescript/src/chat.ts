import chalk from 'chalk';
import { AgentRegistry, BasicAgent } from './agents/index.js';
import { hasCopilotAvailable, resolveGithubToken } from './copilot-check.js';

const NAME = 'openrappter';
const EMOJI = '🦖';

/** Singleton CopilotProvider for quick chat (non-daemon mode) */
let _chatProvider: import('./providers/copilot.js').CopilotProvider | null = null;

export async function getChatProvider(): Promise<import('./providers/copilot.js').CopilotProvider> {
  if (!_chatProvider) {
    const { CopilotProvider } = await import('./providers/copilot.js');
    const token = await resolveGithubToken();
    _chatProvider = new CopilotProvider(token ? { githubToken: token } : undefined);
  }
  return _chatProvider;
}

export async function chat(message: string, registry: AgentRegistry): Promise<string> {
  // First try to match an agent using keyword patterns (fallback mode)
  const agents = await registry.getAllAgents();
  const result = await matchAndExecuteAgent(message, agents);
  if (result) return result;

  // If no agent matched, use Copilot API if available
  const hasCopilot = await hasCopilotAvailable();

  if (!hasCopilot) {
    return JSON.stringify({
      status: 'info',
      response: 'No AI provider configured. Run \'openrappter onboard\' to connect GitHub Copilot.',
      hint: 'You can also set GITHUB_TOKEN in your environment.',
      agents: Array.from(agents.keys()),
    });
  }

  try {
    const provider = await getChatProvider();
    const response = await provider.chat([
      { role: 'system', content: `You are ${NAME}, a helpful local-first AI assistant.` },
      { role: 'user', content: message },
    ]);
    return response.content ?? `${EMOJI} ${NAME}: I processed your request but got no response.`;
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('timeout')) {
      return `${EMOJI} ${NAME}: Request timed out. Try a simpler question.`;
    }
    if (err.message.includes('404') || err.message.includes('401') || err.message.includes('403')) {
      return JSON.stringify({
        status: 'error',
        response: 'GitHub token found but Copilot access failed. Run \'openrappter onboard\' to re-authenticate.',
        hint: 'Your token may lack Copilot scopes. Device code login grants the correct permissions.',
      });
    }
    return `${EMOJI} ${NAME}: I couldn't process that. Error: ${err.message}`;
  }
}

/**
 * Match message to an agent and execute it (fallback keyword matching).
 * Mirrors the Python _fallback_response in openrappter.py
 */
export async function matchAndExecuteAgent(
  message: string,
  agents: Map<string, BasicAgent>
): Promise<string | null> {
  const msgLower = message.toLowerCase();

  // Keyword patterns for core agents
  const patterns: Record<string, string[]> = {
    Memory: ['remember', 'store', 'save', 'memorize', 'recall', 'what do you know', 'memory', 'remind me', 'forget'],
    Shell: ['run', 'execute', 'bash', 'ls', 'cat', 'read file', 'write file', 'list dir', 'command', '$'],
  };

  // Find best matching agent
  let bestMatch: string | null = null;
  let bestScore = 0;

  // Check patterns first
  for (const [agentName, keywords] of Object.entries(patterns)) {
    const score = keywords.filter(kw => msgLower.includes(kw)).length;
    if (score > bestScore && agents.has(agentName)) {
      bestScore = score;
      bestMatch = agentName;
    }
  }

  // Also check dynamically loaded agents by their descriptions
  for (const [agentName, agent] of agents) {
    if (agentName in patterns) continue; // Already checked

    const desc = agent.metadata?.description?.toLowerCase() ?? '';
    const nameLower = agentName.toLowerCase();
    const words = msgLower.split(/\s+/).filter(w => w.length > 2);
    const score = words.filter(w => desc.includes(w) || nameLower.includes(w)).length;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = agentName;
    }
  }

  // Execute matched agent
  if (bestMatch && bestScore > 0) {
    const agent = agents.get(bestMatch);
    if (agent) {
      try {
        return await agent.execute({ query: message });
      } catch (e) {
        return JSON.stringify({
          status: 'error',
          message: `Error executing ${bestMatch}: ${(e as Error).message}`,
        });
      }
    }
  }

  return null;
}

/**
 * Display result, parsing JSON if needed
 */
export function displayResult(result: string): void {
  try {
    const data = JSON.parse(result);
    if (data.response) {
      console.log(`\n${EMOJI} ${NAME}: ${data.response}\n`);
    } else if (data.message) {
      console.log(`\n${EMOJI} ${NAME}: ${data.message}\n`);
    } else if (data.output) {
      console.log(`\n${data.output}\n`);
    } else if (data.content) {
      console.log(`\n${data.content.slice(0, 1000)}${data.truncated ? '...' : ''}\n`);
    } else if (data.items) {
      // Directory listing
      console.log(`\n${data.path}:`);
      for (const item of data.items) {
        const icon = item.type === 'directory' ? '📁' : '📄';
        console.log(`  ${icon} ${item.name}`);
      }
      console.log();
    } else if (data.matches) {
      // Memory recall
      console.log(`\n${EMOJI} ${data.message || 'Memories'}:`);
      for (const match of data.matches) {
        console.log(`  • ${match.message}`);
      }
      console.log();
    } else {
      console.log(`\n${JSON.stringify(data, null, 2)}\n`);
    }
    // Show hint in dim text if present
    if (data.hint) {
      console.log(chalk.dim(`  hint: ${data.hint}\n`));
    }
  } catch {
    console.log(`\n${EMOJI} ${NAME}: ${result}\n`);
  }
}
