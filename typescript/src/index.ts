import { program } from 'commander';
import { intro, outro, text, select, note, spinner, confirm, password, isCancel, log } from '@clack/prompts';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AgentRegistry } from './agents/index.js';
import type { AgentInfo } from './agents/types.js';
import { ensureHomeDir, loadEnv, saveEnv, loadConfig, saveConfig, HOME_DIR, CONFIG_FILE, ENV_FILE } from './env.js';
import { hasCopilotAvailable, resolveGithubToken, validateTelegramToken } from './copilot-check.js';
import { chat, displayResult } from './chat.js';

const execAsync = promisify(exec);

const VERSION = '1.6.0';
const EMOJI = '🦖';
const NAME = 'openrappter';

// Initialize agent registry
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = new AgentRegistry(path.join(__dirname, 'agents'));

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// GATEWAY IN-PROCESS
// ═══════════════════════════════════════════════════════════════════════════════

async function startGatewayInProcess(opts?: { silent?: boolean; webRoot?: string }): Promise<{ port: number; cleanup: () => Promise<void> }> {
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
    webRoot: opts?.webRoot,
  });

  // Create the Assistant powered by direct Copilot API (no CLI needed)
  const agents = await registry.getAllAgents();
  const githubToken = await resolveGithubToken();

  // Validate token at startup so we fail early with a clear message
  if (githubToken) {
    try {
      const { resolveCopilotApiToken } = await import('./providers/copilot-token.js');
      await resolveCopilotApiToken({ githubToken });
      log(`${EMOJI} Copilot token validated`);
    } catch (err) {
      console.warn(`${EMOJI} Warning: ${(err as Error).message}`);
      console.warn(`${EMOJI} Chat will not work until you re-authenticate.`);
    }
  } else {
    console.warn(`${EMOJI} No GitHub token found. Run 'openrappter onboard' to set up Copilot.`);
  }

  const assistant = new Assistant(agents, {
    name: NAME,
    description: 'a helpful local-first AI assistant with shell, memory, and skill agents',
    model: process.env.OPENRAPPTER_MODEL,
    githubToken: githubToken ?? undefined,
    workspaceDir: process.env.OPENRAPPTER_WORKSPACE_DIR,
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
  .option('--web', 'Open web UI in browser')
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
      const response = await chat(options.task, registry);
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

    if (options.web) {
      const webRoot = path.resolve(__dirname, '../ui/dist');
      if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
        console.error('Web UI not built. Run: cd ui && npm run build');
        process.exit(1);
      }
      const { port } = await startGatewayInProcess({ webRoot });
      const url = `http://127.0.0.1:${port}`;
      console.log(`${EMOJI} Web UI: ${url}`);
      console.log('Press Ctrl+C to stop\n');
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execAsync(`${openCmd} ${url}`).catch(() => {});
      return;
    }

    if (options.daemon) {
      const { port } = await startGatewayInProcess();
      console.log(`${EMOJI} ${NAME} gateway running on ws://127.0.0.1:${port}`);
      console.log('Press Ctrl+C to stop\n');
      return;
    }

    if (message) {
      const response = await chat(message, registry);
      displayResult(response);
      return;
    }

    // Interactive mode — drop straight into streaming chat
    await interactiveMode();
  });

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
      initialValue: false,
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

    // Bug 2 fix: wrap saves in try/catch with specific error messages
    const savedKeys = Object.keys(env);
    try {
      await saveEnv(env);
      log.success(`Saved ${ENV_FILE} (${savedKeys.join(', ')})`);
    } catch (err) {
      log.error(`Failed to save env file: ${(err as Error).message}`);
      log.warn(`Keys that were not saved: ${savedKeys.join(', ')}`);
    }

    config.setupComplete = true;
    config.copilotAvailable = copilotReady;
    config.telegramConnected = telegramReady;
    config.onboardedAt = new Date().toISOString();
    try {
      await saveConfig(config);
      log.success(`Saved ${CONFIG_FILE}`);
    } catch (err) {
      log.error(`Failed to save config file: ${(err as Error).message}`);
    }

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

// Reset command
program
  .command('reset')
  .description('Clear all credentials, config, and cached tokens for a fresh start')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (options) => {
    const filesToDelete = [
      { path: ENV_FILE, label: '.env (credentials)' },
      { path: CONFIG_FILE, label: 'config.json' },
      { path: path.join(HOME_DIR, 'credentials', 'copilot-token.json'), label: 'cached Copilot token' },
      { path: path.join(HOME_DIR, 'memory.json'), label: 'memory store' },
      { path: path.join(HOME_DIR, 'sessions.json'), label: 'sessions' },
    ];

    console.log(`\n${EMOJI} This will delete:\n`);
    for (const f of filesToDelete) {
      const exists = fs.existsSync(f.path);
      console.log(`  ${exists ? '•' : chalk.dim('○')} ${f.label} ${exists ? '' : chalk.dim('(not found)')}`);
    }
    console.log('');

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.log('Use --yes to confirm in non-interactive mode.');
        process.exit(1);
      }
      const ok = await confirm({ message: 'Proceed with reset?' });
      if (isCancel(ok) || !ok) {
        console.log('Cancelled.');
        process.exit(0);
      }
    }

    let deleted = 0;
    for (const f of filesToDelete) {
      try {
        if (fs.existsSync(f.path)) {
          fs.unlinkSync(f.path);
          console.log(chalk.green(`  ✓ Deleted ${f.label}`));
          deleted++;
        }
      } catch (err) {
        console.error(chalk.red(`  ✗ Failed to delete ${f.label}: ${(err as Error).message}`));
      }
    }

    console.log(`\n${EMOJI} Reset complete (${deleted} files removed).`);
    console.log(`  Run ${chalk.bold('openrappter onboard')} to set up again.\n`);
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

// Interactive mode — direct-API chat with streaming (no gateway needed)
async function interactiveMode(): Promise<void> {
  const agents = await registry.getAllAgents();
  const githubToken = await resolveGithubToken();

  const { Assistant } = await import('./agents/Assistant.js');
  const assistant = new Assistant(agents, {
    name: NAME,
    description: 'a helpful local-first AI assistant with shell, memory, and skill agents',
    model: process.env.OPENRAPPTER_MODEL,
    githubToken: githubToken ?? undefined,
    workspaceDir: process.env.OPENRAPPTER_WORKSPACE_DIR,
  });

  const { startInteractiveChat } = await import('./tui/interactive.js');
  await startInteractiveChat({ assistant, emoji: EMOJI, name: NAME, version: VERSION });
}

program.parse();
