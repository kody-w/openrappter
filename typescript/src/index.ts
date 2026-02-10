import { program } from 'commander';
import { intro, outro, text, select, note, spinner } from '@clack/prompts';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { AgentRegistry, BasicAgent } from './agents/index.js';
import type { AgentInfo } from './agents/types.js';

const execAsync = promisify(exec);

const VERSION = '1.1.0';
const EMOJI = '🦖';
const NAME = 'openrappter';
const HOME_DIR = path.join(os.homedir(), '.openrappter');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');

// Initialize agent registry
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = new AgentRegistry(path.join(__dirname, 'agents'));

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

async function ensureHomeDir(): Promise<void> {
  await fs.mkdir(HOME_DIR, { recursive: true });
}

async function hasCopilotCLI(): Promise<boolean> {
  try {
    await execAsync('copilot --version');
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(): Promise<Record<string, unknown>> {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveConfig(config: Record<string, unknown>): Promise<void> {
  await ensureHomeDir();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════════
// COPILOT SDK INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

async function chat(message: string): Promise<string> {
  // First try to match an agent using keyword patterns (fallback mode)
  const agents = await registry.getAllAgents();
  const result = await matchAndExecuteAgent(message, agents);
  if (result) return result;

  // If no agent matched, use Copilot CLI if available
  const hasCopilot = await hasCopilotCLI();

  if (!hasCopilot) {
    return JSON.stringify({
      status: 'info',
      response: `I heard: "${message}". Use /help to see available commands.`,
      agents: Array.from(agents.keys()),
    });
  }

  try {
    // Use Copilot CLI directly
    const escapedMessage = message.replace(/'/g, "'\\''");
    const { stdout, stderr } = await execAsync(`copilot --message '${escapedMessage}'`, { timeout: 60000 });
    if (stdout.trim()) {
      return stdout.trim();
    }
    if (stderr.trim()) {
      return stderr.trim();
    }
    return `${EMOJI} ${NAME}: I processed your request but got no response.`;
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('timeout')) {
      return `${EMOJI} ${NAME}: Request timed out. Try a simpler question.`;
    }
    return `${EMOJI} ${NAME}: I couldn't process that. Error: ${err.message}`;
  }
}

/**
 * Match message to an agent and execute it (fallback keyword matching).
 * Mirrors the Python _fallback_response in openrappter.py
 */
async function matchAndExecuteAgent(
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

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

program
  .name('openrappter')
  .description(`${EMOJI} ${NAME} — Local-first AI agent powered by GitHub Copilot SDK`)
  .version(VERSION);

// Default command: interactive chat
program
  .argument('[message]', 'Message to send')
  .option('-t, --task <task>', 'Run a single task')
  .option('-e, --evolve <n>', 'Run N evolution ticks', parseInt)
  .option('-d, --daemon', 'Run as background daemon')
  .option('-s, --status', 'Show status')
  .option('-l, --list-agents', 'List available agents')
  .option('--exec <agent>', 'Execute a specific agent')
  .action(async (message, options) => {
    await ensureHomeDir();

    // Initialize agents
    await registry.discoverAgents();

    if (options.status) {
      await statusCommand();
      return;
    }

    if (options.listAgents) {
      const agents = await registry.listAgents();
      if (agents.length === 0) {
        console.log('No agents found');
        return;
      }
      console.log(`\n${EMOJI} Available Agents:\n`);
      for (const agent of agents) {
        console.log(`  • ${agent.name}`);
        console.log(`    ${agent.description.slice(0, 60)}...`);
        console.log();
      }
      return;
    }

    if (options.exec) {
      const agent = await registry.getAgent(options.exec);
      if (!agent) {
        console.log(`Agent '${options.exec}' not found`);
        return;
      }
      const query = message || '';
      const result = await agent.execute({ query });
      displayResult(result);
      return;
    }

    if (options.task) {
      const s = spinner();
      s.start('Processing...');
      const response = await chat(options.task);
      s.stop('Done');
      displayResult(response);
      return;
    }

    if (options.evolve) {
      console.log(`${EMOJI} Running ${options.evolve} evolution ticks...`);
      for (let i = 1; i <= options.evolve; i++) {
        console.log(`  [${i}] Tick completed`);
      }
      return;
    }

    if (options.daemon) {
      const { GatewayServer } = await import('./gateway/server.js');
      const { Assistant } = await import('./agents/Assistant.js');
      const port = parseInt(process.env.OPENRAPPTER_PORT ?? '18789', 10);
      const token = process.env.OPENRAPPTER_TOKEN || undefined;
      const server = new GatewayServer({
        port,
        bind: 'loopback',
        auth: token ? { mode: 'token', tokens: [token] } : { mode: 'none' },
      });

      // Create the Assistant powered by Copilot SDK
      const agents = await registry.getAllAgents();
      const assistant = new Assistant(agents, {
        name: NAME,
        description: 'a helpful local-first AI assistant with shell, memory, and skill agents',
        model: process.env.OPENRAPPTER_MODEL,
      });

      server.setAgentHandler(async (req, stream) => {
        const result = await assistant.getResponse(
          req.message,
          // Forward streaming deltas
          stream ? (delta) => stream({ chunk: delta, done: false }) : undefined,
        );
        return {
          sessionId: req.sessionId ?? 'default',
          content: result.content,
          finishReason: 'stop' as const,
        };
      });

      // Clean shutdown
      process.on('SIGINT', async () => {
        await assistant.stop();
        await server.stop();
        process.exit(0);
      });

      await server.start();
      console.log(`${EMOJI} ${NAME} gateway running on ws://127.0.0.1:${port}`);
      console.log(`${EMOJI} Assistant: Copilot SDK with ${agents.size} agents as tools`);
      console.log('Press Ctrl+C to stop\n');
      return;
    }

    if (message) {
      const response = await chat(message);
      displayResult(response);
      return;
    }

    // Interactive mode
    await interactiveMode();
  });

/**
 * Display result, parsing JSON if needed
 */
function displayResult(result: string): void {
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
  } catch {
    console.log(`\n${EMOJI} ${NAME}: ${result}\n`);
  }
}

// Onboard command
program
  .command('onboard')
  .description('Interactive setup wizard')
  .action(async () => {
    intro(`${EMOJI} Welcome to ${NAME}!`);

    const hasCopilot = await hasCopilotCLI();

    if (hasCopilot) {
      note(
        'GitHub Copilot CLI detected!\nNo API key configuration needed.',
        '✅ Ready to go'
      );
    } else {
      note(
        'GitHub Copilot CLI not found.\nInstall it for the best experience:\n\n  npm install -g @githubnext/github-copilot-cli\n  github-copilot-cli auth',
        '⚠️ Setup recommended'
      );
    }

    const config = await loadConfig();
    config.setupComplete = true;
    config.copilotAvailable = hasCopilot;
    await saveConfig(config);

    outro(`${EMOJI} Setup complete! Run 'openrappter' to start chatting.`);
  });

// Status command
async function statusCommand(): Promise<void> {
  const hasCopilot = await hasCopilotCLI();
  const config = await loadConfig();
  const agents = await registry.listAgents();

  console.log(`\n${EMOJI} ${NAME} Status\n`);
  console.log(`  Version: ${VERSION}`);
  console.log(`  Home: ${HOME_DIR}`);
  console.log(`  Copilot: ${hasCopilot ? chalk.green('✅ Available') : chalk.yellow('❌ Not found')}`);
  console.log(`  Setup: ${config.setupComplete ? chalk.green('✅ Complete') : chalk.yellow('Not run')}`);
  console.log(`  Agents: ${agents.length} loaded`);
  if (agents.length > 0) {
    console.log(`    ${agents.map((a: AgentInfo) => a.name).join(', ')}`);
  }
  console.log('');
}

// Interactive mode
async function interactiveMode(): Promise<void> {
  const hasCopilot = await hasCopilotCLI();
  const agents = await registry.listAgents();

  if (hasCopilot) {
    console.log(chalk.dim('Using GitHub Copilot SDK...\n'));
  }

  console.log(`${EMOJI} ${NAME} v${VERSION} Chat`);
  console.log('─'.repeat(40));
  console.log(`Copilot: ${hasCopilot ? '✅ Available' : '❌ Not found'}`);
  console.log(`Agents: ${agents.length} loaded`);
  console.log('Type /help for commands, /quit to exit\n');

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): void => {
    rl.question(`${EMOJI} You: `, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log(`\nGoodbye! ${EMOJI}\n`);
        rl.close();
        return;
      }

      if (trimmed === '/help') {
        console.log(`
${EMOJI} ${NAME} Commands:

  /help    - Show this help
  /status  - Show status
  /agents  - List available agents
  /quit    - Exit
`);
        prompt();
        return;
      }

      if (trimmed === '/status') {
        await statusCommand();
        prompt();
        return;
      }

      if (trimmed === '/agents') {
        const agentList = await registry.listAgents();
        for (const agent of agentList) {
          console.log(`  • ${agent.name}: ${agent.description.slice(0, 50)}...`);
        }
        console.log();
        prompt();
        return;
      }

      const s = spinner();
      s.start('Thinking...');

      try {
        const response = await chat(trimmed);
        s.stop('');
        displayResult(response);
      } catch (error) {
        s.stop('');
        console.log(`\n${EMOJI} ${NAME}: Sorry, I encountered an error.\n`);
      }

      prompt();
    });
  };

  prompt();
}

program.parse();
