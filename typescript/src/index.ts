import { program } from 'commander';
import { intro, outro, text, select, note, spinner, confirm, password, isCancel, log } from '@clack/prompts';
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
// ONBOARDING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const ENV_FILE = path.join(HOME_DIR, '.env');

async function loadEnv(): Promise<Record<string, string>> {
  try {
    const data = await fs.readFile(ENV_FILE, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    }
    return env;
  } catch {
    return {};
  }
}

async function saveEnv(env: Record<string, string>): Promise<void> {
  await ensureHomeDir();
  const lines = ['# openrappter environment — managed by `openrappter onboard`', ''];
  for (const [key, val] of Object.entries(env)) {
    lines.push(`${key}="${val}"`);
  }
  lines.push('');
  await fs.writeFile(ENV_FILE, lines.join('\n'));
}

async function hasGhCLI(): Promise<boolean> {
  try {
    await execAsync('gh --version');
    return true;
  } catch {
    return false;
  }
}

async function isGhAuthenticated(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('gh auth status 2>&1');
    return stdout.includes('Logged in');
  } catch {
    return false;
  }
}

async function getGhToken(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('gh auth token');
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function validateTelegramToken(token: string): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await resp.json() as { ok: boolean; result?: { username?: string }; description?: string };
    if (data.ok && data.result) {
      return { valid: true, username: data.result.username };
    }
    return { valid: false, error: data.description || 'Invalid token' };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Network error' };
  }
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
      // Load env vars from ~/.openrappter/.env (saved by onboard wizard)
      const envVars = await loadEnv();
      for (const [key, val] of Object.entries(envVars)) {
        if (!process.env[key]) process.env[key] = val;
      }

      const { GatewayServer } = await import('./gateway/server.js');
      const { Assistant } = await import('./agents/Assistant.js');
      const { ChannelRegistry } = await import('./channels/registry.js');
      const { TelegramChannel } = await import('./channels/telegram.js');
      const { DiscordChannel } = await import('./channels/discord.js');
      const { WhatsAppChannel } = await import('./channels/whatsapp.js');
      const { SlackChannel } = await import('./channels/slack.js');
      const { CLIChannel } = await import('./channels/cli.js');
      const { listBundledSkills } = await import('./skills/bundled.js');
      const port = parseInt(process.env.OPENRAPPTER_PORT ?? '18790', 10);
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

      // Set up channel registry — register all channels so they appear in the UI
      const channelRegistry = new ChannelRegistry();

      // Register all supported channels (they show as Offline until configured/connected)
      const telegram = new TelegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN || '' });
      channelRegistry.register(telegram);
      channelRegistry.register(new DiscordChannel({ botToken: process.env.DISCORD_BOT_TOKEN || '' }));
      channelRegistry.register(new SlackChannel('slack', 'slack', { botToken: process.env.SLACK_BOT_TOKEN || '', appToken: process.env.SLACK_APP_TOKEN || '' }));
      channelRegistry.register(new WhatsAppChannel({}));
      channelRegistry.register(new CLIChannel());

      // Wire incoming messages → Assistant → reply for all message channels
      telegram.onMessage(async (incoming) => {
        try {
          const chatId = `telegram_${incoming.conversationId || 'default'}`;
          console.log(`${EMOJI} Telegram ← ${incoming.senderName}: ${incoming.content}`);

          const result = await assistant.getResponse(incoming.content, undefined, undefined, chatId);
          const reply = result.content;

          await telegram.send(incoming.conversationId!, {
            channel: 'telegram',
            content: reply,
            replyTo: incoming.id,
          });
          console.log(`${EMOJI} Telegram → ${incoming.senderName}: ${reply.slice(0, 80)}...`);
        } catch (err) {
          console.error(`${EMOJI} Telegram reply error:`, err);
        }
      });

      // Auto-connect Telegram if token is set
      const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
      if (telegramToken) {
        try {
          await telegram.connect();
          console.log(`${EMOJI} Telegram connected & polling (t.me/rappterbot)`);
        } catch (err) {
          console.error(`${EMOJI} Telegram connect failed:`, err);
        }
      }

      server.setChannelRegistry(channelRegistry);

      // Expose agents to UI
      server.setAgentList(() => {
        const list: { id: string; type: string; description?: string }[] = [];
        for (const [id, agent] of agents) {
          list.push({
            id,
            type: agent.constructor?.name?.replace(/Agent$/, '').toLowerCase() ?? 'basic',
            description: agent.metadata?.description,
          });
        }
        return list;
      });

      server.setAgentHandler(async (req, stream) => {
        const conversationKey = req.sessionId || req.conversationId || 'default';
        const result = await assistant.getResponse(
          req.message,
          // Forward streaming deltas
          stream ? (delta) => stream({ id: '', streaming: true, chunk: delta, done: false }) : undefined,
          undefined,
          conversationKey,
        );
        return {
          sessionId: req.sessionId ?? 'default',
          content: result.content,
          finishReason: 'stop' as const,
        };
      });

      // Clean shutdown
      process.on('SIGINT', async () => {
        await channelRegistry.disconnectAll();
        await assistant.stop();
        await server.stop();
        process.exit(0);
      });

      await server.start();

      // Override channels.list to include EventEmitter-based channels not in registry
      const extraChannels = [
        { id: 'signal', type: 'signal' },
        { id: 'imessage', type: 'imessage' },
        { id: 'matrix', type: 'matrix' },
        { id: 'teams', type: 'teams' },
        { id: 'googlechat', type: 'googlechat' },
      ];
      server.registerMethod('channels.list', async () => {
        const live = channelRegistry.getStatusList();
        const extras = extraChannels.map(ch => ({
          id: ch.id, type: ch.type, connected: false, configured: false,
          running: false, messageCount: 0,
        }));
        return [...live, ...extras];
      });

      // Register skills.list RPC method
      server.registerMethod('skills.list', async () => {
        const skills = await listBundledSkills();
        return skills.map(s => ({
          name: s.name,
          description: s.description,
          category: s.category,
          enabled: s.eligibility.eligible === 'eligible',
          version: '1.0.0',
        }));
      });

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
    log.info("Let's get you connected. This takes about 2 minutes.");

    const env = await loadEnv();
    const config = await loadConfig();

    // ── Step 1: GitHub Copilot ──────────────────────────────────────────────
    log.step('Step 1 of 3 — GitHub Copilot');

    const hasGh = await hasGhCLI();
    let copilotReady = false;

    if (hasGh) {
      const authenticated = await isGhAuthenticated();
      if (authenticated) {
        const token = await getGhToken();
        if (token) {
          env.GITHUB_TOKEN = token;
          copilotReady = true;
          log.success('GitHub CLI authenticated — Copilot is ready!');
        }
      } else {
        log.warn('GitHub CLI found but not authenticated.');
        const shouldLogin = await confirm({
          message: 'Open GitHub login now?',
          initialValue: true,
        });
        if (isCancel(shouldLogin)) { outro('Setup cancelled.'); process.exit(0); }

        if (shouldLogin) {
          const s = spinner();
          s.start('Opening GitHub login…');
          try {
            await execAsync('gh auth login --web --scopes read:org,repo');
            s.stop('Authenticated!');
            const token = await getGhToken();
            if (token) {
              env.GITHUB_TOKEN = token;
              copilotReady = true;
            }
          } catch {
            s.stop('Login failed — you can retry later with `gh auth login`');
          }
        }
      }
    } else {
      // No gh CLI — ask for a manual GITHUB_TOKEN
      log.warn('GitHub CLI (gh) not found.');
      note(
        'Install it for the best experience:\n' +
        '  brew install gh          (macOS)\n' +
        '  sudo apt install gh      (Linux)\n' +
        '  https://cli.github.com   (other)\n\n' +
        'Or paste a GitHub personal access token below.',
        'GitHub CLI'
      );

      const manualToken = await text({
        message: 'GitHub token (or press Enter to skip):',
        placeholder: 'ghp_xxxxxxxxxxxx',
        validate: (val) => {
          if (!val) return undefined; // allow skip
          if (val.length < 10) return 'Token looks too short';
          return undefined;
        },
      });
      if (isCancel(manualToken)) { outro('Setup cancelled.'); process.exit(0); }

      if (manualToken && typeof manualToken === 'string' && manualToken.length > 0) {
        env.GITHUB_TOKEN = manualToken;
        copilotReady = true;
        log.success('Token saved.');
      } else {
        log.info('Skipped — you can set GITHUB_TOKEN later.');
      }
    }

    // ── Step 2: Telegram ────────────────────────────────────────────────────
    log.step('Step 2 of 3 — Telegram');

    const connectTelegram = await confirm({
      message: 'Connect a Telegram bot?',
      initialValue: true,
    });
    if (isCancel(connectTelegram)) { outro('Setup cancelled.'); process.exit(0); }

    let telegramReady = false;
    if (connectTelegram) {
      note(
        'To connect Telegram you need a bot token from @BotFather:\n' +
        '  1. Open Telegram → search @BotFather\n' +
        '  2. Send /newbot and follow the prompts\n' +
        '  3. Copy the token (looks like 123456:ABC-DEF…)',
        'Telegram Bot'
      );

      const botToken = await password({
        message: 'Paste your Telegram bot token:',
        validate: (val) => {
          if (!val) return 'Token is required';
          if (!val.match(/^\d+:.+$/)) return 'Token should look like 123456:ABC-DEF…';
          return undefined;
        },
      });
      if (isCancel(botToken)) { outro('Setup cancelled.'); process.exit(0); }

      if (botToken && typeof botToken === 'string') {
        const s = spinner();
        s.start('Validating token…');
        const result = await validateTelegramToken(botToken);
        if (result.valid) {
          env.TELEGRAM_BOT_TOKEN = botToken;
          telegramReady = true;
          s.stop(`Connected! Bot: @${result.username}`);
        } else {
          s.stop(`Validation failed: ${result.error}`);
          log.warn('Token saved anyway — you can fix it later in ~/.openrappter/.env');
          env.TELEGRAM_BOT_TOKEN = botToken;
        }
      }
    } else {
      log.info('Skipped — run `openrappter onboard` anytime to add Telegram.');
    }

    // ── Step 3: Save & Verify ───────────────────────────────────────────────
    log.step('Step 3 of 3 — Saving configuration');

    await saveEnv(env);
    log.success(`Saved ${ENV_FILE}`);

    config.setupComplete = true;
    config.copilotAvailable = copilotReady;
    config.telegramConnected = telegramReady;
    config.onboardedAt = new Date().toISOString();
    await saveConfig(config);
    log.success(`Saved ${CONFIG_FILE}`);

    // ── Summary ─────────────────────────────────────────────────────────────
    const summaryLines = [
      `Copilot:  ${copilotReady ? '✅ Connected' : '❌ Not configured'}`,
      `Telegram: ${telegramReady ? '✅ Connected' : '⬚  Not configured'}`,
      '',
      `Config:   ${CONFIG_FILE}`,
      `Env:      ${ENV_FILE}`,
    ];
    note(summaryLines.join('\n'), '📋 Setup Summary');

    note(
      `Start the daemon:    openrappter --daemon\n` +
      `Check status:        openrappter --status\n` +
      `Chat:                openrappter "hello"\n` +
      `Re-run setup:        openrappter onboard`,
      "What's next"
    );

    outro(`${EMOJI} You're all set! Happy hacking.`);
  });

// Status command
async function statusCommand(): Promise<void> {
  const hasCopilot = await hasCopilotCLI();
  const config = await loadConfig();
  const agents = await registry.listAgents();
  const env = await loadEnv();

  const hasTelegram = !!(env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN);
  const hasToken = !!(env.GITHUB_TOKEN || process.env.GITHUB_TOKEN);

  console.log(`\n${EMOJI} ${NAME} Status\n`);
  console.log(`  Version:  ${VERSION}`);
  console.log(`  Home:     ${HOME_DIR}`);
  console.log(`  Copilot:  ${(hasCopilot || hasToken) ? chalk.green('✅ Available') : chalk.yellow('❌ Not found')}`);
  console.log(`  Telegram: ${hasTelegram ? chalk.green('✅ Connected') : chalk.dim('⬚  Not configured')}`);
  console.log(`  Setup:    ${config.setupComplete ? chalk.green('✅ Complete') : chalk.yellow('Not run — try: openrappter onboard')}`);
  console.log(`  Agents:   ${agents.length} loaded`);
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
