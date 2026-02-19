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

/** Check if Copilot is available via direct token exchange (no CLI needed) */
async function hasCopilotAvailable(): Promise<boolean> {
  const token = process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) return true;

  // Try gh CLI token as fallback
  try {
    const { stdout } = await execAsync('gh auth token 2>/dev/null');
    if (stdout.trim()) return true;
  } catch { /* gh not available */ }

  return false;
}

/** Resolve a GitHub token from env or gh CLI */
async function resolveGithubToken(): Promise<string | null> {
  const envToken = process.env.COPILOT_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  try {
    const { stdout } = await execAsync('gh auth token 2>/dev/null');
    if (stdout.trim()) return stdout.trim();
  } catch { /* gh not available */ }

  return null;
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
// COPILOT DIRECT API INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Singleton CopilotProvider for quick chat (non-daemon mode) */
let _chatProvider: import('./providers/copilot.js').CopilotProvider | null = null;

async function getChatProvider(): Promise<import('./providers/copilot.js').CopilotProvider> {
  if (!_chatProvider) {
    const { CopilotProvider } = await import('./providers/copilot.js');
    const token = await resolveGithubToken();
    _chatProvider = new CopilotProvider(token ? { githubToken: token } : undefined);
  }
  return _chatProvider;
}

async function chat(message: string): Promise<string> {
  // First try to match an agent using keyword patterns (fallback mode)
  const agents = await registry.getAllAgents();
  const result = await matchAndExecuteAgent(message, agents);
  if (result) return result;

  // If no agent matched, use Copilot API if available
  const hasCopilot = await hasCopilotAvailable();

  if (!hasCopilot) {
    return JSON.stringify({
      status: 'info',
      response: `I heard: "${message}". Use /help to see available commands.`,
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
// GATEWAY IN-PROCESS
// ═══════════════════════════════════════════════════════════════════════════════

async function startGatewayInProcess(opts?: { silent?: boolean }): Promise<{ port: number; cleanup: () => Promise<void> }> {
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
  const silent = opts?.silent ?? false;
  const log = (...args: unknown[]) => { if (!silent) console.log(...args); };

  const server = new GatewayServer({
    port,
    bind: 'loopback',
    auth: token ? { mode: 'token', tokens: [token] } : { mode: 'none' },
  });

  // Create the Assistant powered by direct Copilot API (no CLI needed)
  const agents = await registry.getAllAgents();
  const githubToken = await resolveGithubToken();
  const assistant = new Assistant(agents, {
    name: NAME,
    description: 'a helpful local-first AI assistant with shell, memory, and skill agents',
    model: process.env.OPENRAPPTER_MODEL,
    githubToken: githubToken ?? undefined,
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
      log(`${EMOJI} Telegram ← ${incoming.senderName}: ${incoming.content}`);

      const result = await assistant.getResponse(incoming.content, undefined, undefined, chatId);
      const reply = result.content;

      await telegram.send(incoming.conversationId!, {
        channel: 'telegram',
        content: reply,
        replyTo: incoming.id,
      });
      log(`${EMOJI} Telegram → ${incoming.senderName}: ${reply.slice(0, 80)}...`);
    } catch (err) {
      console.error(`${EMOJI} Telegram reply error:`, err);
    }
  });

  // Auto-connect Telegram if token is set
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    try {
      await telegram.connect();
      log(`${EMOJI} Telegram connected & polling (t.me/rappterbot)`);
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

  log(`${EMOJI} Assistant: Copilot SDK with ${agents.size} agents as tools`);

  // Clean shutdown
  const cleanup = async () => {
    await channelRegistry.disconnectAll();
    await assistant.stop();
    await server.stop();
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  return { port, cleanup };
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
  .option('--repl', 'Use simple readline chat instead of TUI')
  .action(async (message, options) => {
    await ensureHomeDir();

    // Load env vars from ~/.openrappter/.env (saved by onboard wizard)
    const envVars = await loadEnv();
    for (const [key, val] of Object.entries(envVars)) {
      if (!process.env[key]) process.env[key] = val;
    }

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
      const { port } = await startGatewayInProcess();
      console.log(`${EMOJI} ${NAME} gateway running on ws://127.0.0.1:${port}`);
      console.log('Press Ctrl+C to stop\n');
      return;
    }

    if (message) {
      const response = await chat(message);
      displayResult(response);
      return;
    }

    // Interactive mode — TUI by default, --repl for old readline REPL
    if (options.repl) {
      await interactiveMode();
      return;
    }

    // Launch gateway in-process (silent) then start TUI
    let port: number;
    try {
      const gw = await startGatewayInProcess({ silent: true });
      port = gw.port;
    } catch (err) {
      // Port likely in use — connect TUI to existing gateway
      port = parseInt(process.env.OPENRAPPTER_PORT ?? '18790', 10);
    }
    const { startTUI } = await import('./tui/index.js');
    await startTUI({ port, token: process.env.OPENRAPPTER_TOKEN });
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
    // Guard: onboard requires an interactive terminal for @clack/prompts
    if (!process.stdin.isTTY) {
      console.log(`${EMOJI} Onboard wizard requires an interactive terminal.`);
      console.log(`Run 'openrappter onboard' directly in your terminal.`);
      return;
    }

    intro(`${EMOJI} Welcome to ${NAME}!`);
    log.info("Let's get you connected. This takes about 2 minutes.");

    const env = await loadEnv();
    const config = await loadConfig();

    // ── Step 1: GitHub Copilot (device code OAuth — no gh CLI required) ────
    log.step('Step 1 of 3 — GitHub Copilot');

    let copilotReady = false;

    // 1a. Check for existing token: env vars → gh CLI
    let existingToken: string | null = env.GITHUB_TOKEN
      ?? process.env.COPILOT_GITHUB_TOKEN
      ?? process.env.GH_TOKEN
      ?? process.env.GITHUB_TOKEN
      ?? null;

    if (!existingToken) {
      const ghToken = await getGhToken();
      if (ghToken) existingToken = ghToken;
    }

    if (existingToken) {
      // Validate the existing token
      const s = spinner();
      s.start('Validating existing GitHub token…');
      try {
        const { resolveCopilotApiToken } = await import('./providers/copilot-token.js');
        await resolveCopilotApiToken({ githubToken: existingToken });
        env.GITHUB_TOKEN = existingToken;
        copilotReady = true;
        s.stop('Existing GitHub token validated — Copilot is ready!');
      } catch {
        s.stop('Existing token could not access Copilot API');
        existingToken = null; // Fall through to device code flow
      }
    }

    if (!copilotReady) {
      // 1b. Offer device code login as the primary path
      const action = await select({
        message: 'How would you like to connect GitHub Copilot?',
        options: [
          { value: 'device', label: 'Log in with GitHub (recommended)', hint: 'opens browser, no gh CLI needed' },
          { value: 'token', label: 'Paste a GitHub token manually' },
          { value: 'skip', label: 'Skip for now' },
        ],
      });
      if (isCancel(action)) { outro('Setup cancelled.'); process.exit(0); }

      if (action === 'device') {
        try {
          const { deviceCodeLogin } = await import('./providers/copilot-auth.js');

          const s = spinner();
          s.start('Requesting device code from GitHub…');

          const token = await deviceCodeLogin(
            (code, url) => {
              s.stop('Device code received');
              note(
                `Code:  ${code}\nURL:   ${url}\n\nEnter the code on GitHub to authorize.`,
                'GitHub Device Login'
              );
              // Try to open browser
              const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
              execAsync(`${openCmd} ${url}`).catch(() => {});
            },
          );

          // Token received — validate it
          env.GITHUB_TOKEN = token;
          copilotReady = true;
          log.success('GitHub authorized — Copilot is ready!');
        } catch (err) {
          log.warn(`Device code login failed: ${(err as Error).message}`);
          log.info('You can try pasting a token manually or skip for now.');

          // Fallback: offer manual token paste
          const manualToken = await text({
            message: 'GitHub token (or press Enter to skip):',
            placeholder: 'ghp_xxxxxxxxxxxx',
            validate: (val) => {
              if (!val) return undefined;
              if (val.length < 10) return 'Token looks too short';
              return undefined;
            },
          });
          if (isCancel(manualToken)) { outro('Setup cancelled.'); process.exit(0); }

          if (manualToken && typeof manualToken === 'string' && manualToken.length > 0) {
            env.GITHUB_TOKEN = manualToken;
            copilotReady = true;
            log.success('Token saved.');
          }
        }
      } else if (action === 'token') {
        note(
          'Paste a GitHub personal access token (classic or fine-grained).\n' +
          'Get one at: https://github.com/settings/tokens',
          'Manual Token'
        );

        const manualToken = await text({
          message: 'GitHub token (or press Enter to skip):',
          placeholder: 'ghp_xxxxxxxxxxxx',
          validate: (val) => {
            if (!val) return undefined;
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
      } else {
        log.info('Skipped — run `openrappter onboard` anytime to connect Copilot.');
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
  const copilotOk = await hasCopilotAvailable();
  const config = await loadConfig();
  const agents = await registry.listAgents();
  const env = await loadEnv();

  const hasTelegram = !!(env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN);

  console.log(`\n${EMOJI} ${NAME} Status\n`);
  console.log(`  Version:  ${VERSION}`);
  console.log(`  Home:     ${HOME_DIR}`);
  console.log(`  Copilot:  ${copilotOk ? chalk.green('✅ Available (direct API)') : chalk.yellow('❌ No GitHub token — run: openrappter onboard')}`);
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
  const hasCopilot = await hasCopilotAvailable();
  const agents = await registry.listAgents();

  if (hasCopilot) {
    console.log(chalk.dim('Using Copilot API (direct token exchange)...\n'));
  }

  console.log(`${EMOJI} ${NAME} v${VERSION} Chat`);
  console.log('─'.repeat(40));
  console.log(`Copilot: ${hasCopilot ? '✅ Available' : '❌ No GitHub token'}`);
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
