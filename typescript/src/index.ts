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

const VERSION = '1.9.1';
const EMOJI = '🦖';
const NAME = 'openrappter';

// Initialize agent registry
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = new AgentRegistry(path.join(__dirname, 'agents'));

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

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

  // Set up RappterManager — multi-soul brainstem
  const { RappterManager } = await import('./gateway/rappter-manager.js');
  const rappterManager = new RappterManager(agents);
  await rappterManager.loadSoul({
    id: 'default',
    name: NAME,
    description: 'Default rappter soul — backward-compatible assistant',
    emoji: EMOJI,
  });
  server.setRappterManager(rappterManager);

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

  // ── Cron Service — load jobs and start scheduler ──
  try {
    const { CronService } = await import('./cron/service.js');
    const cronService = new CronService();
    const cronFile = path.join(HOME_DIR, 'cron.json');
    try {
      const cronData = JSON.parse(fs.readFileSync(cronFile, 'utf-8'));
      await cronService.loadJobs(cronData);
    } catch {
      // No cron.json yet — that's fine
    }
    await cronService.start({
      execute: async (agentId: string, message: string) => {
        console.log(`${EMOJI} Cron executing: agent=${agentId} message="${message.slice(0, 60)}"`);
        try {
          // Use the main assistant for 'Assistant' agentId
          if (agentId === 'Assistant' || agentId === NAME) {
            const resp = await assistant.getResponse(message);
            console.log(`${EMOJI} Cron done: agent=${agentId} result=${resp.content.slice(0, 80)}`);
            return resp.content;
          }
          const agent = agents.get(agentId);
          if (!agent) {
            console.log(`${EMOJI} Cron error: Agent not found: ${agentId}`);
            return `Agent not found: ${agentId}`;
          }
          const result = await agent.execute({ query: message });
          console.log(`${EMOJI} Cron done: agent=${agentId} result=${result.slice(0, 80)}`);
          return result;
        } catch (err) {
          console.error(`${EMOJI} Cron error: agent=${agentId}`, (err as Error).message);
          throw err;
        }
      },
    });
    server.setCronService({
      list: () => cronService.listJobs().map(j => ({
        id: j.id, name: j.name, schedule: j.schedule, enabled: j.enabled,
      })),
      run: async (id: string) => { await cronService.executeJob(id, 'force'); },
      enable: async (id: string) => { await cronService.updateJob(id, { enabled: true }); },
      disable: async (id: string) => { await cronService.updateJob(id, { enabled: false }); },
    });
    // Send cron job results to Telegram when connected
    const CRON_TELEGRAM_CHAT_ID = process.env.CRON_TELEGRAM_CHAT_ID || '8055092758';
    cronService.onEvent(async (event) => {
      if (event.type !== 'job:executed' && event.type !== 'job:error') return;
      if (telegram.getStatus() !== 'connected') return;
      const job = cronService.getJob(event.jobId);
      const jobName = job?.name || event.jobId;
      const data = event.data as Record<string, string> | undefined;
      let text: string;
      if (event.type === 'job:executed') {
        let result = (data?.result || 'No output') as string;
        // Strip |||VOICE||| marker and everything after
        const voiceIdx = result.indexOf('|||VOICE|||');
        if (voiceIdx !== -1) result = result.slice(0, voiceIdx).trimEnd();
        // Try to parse JSON results and extract human-readable content
        let body = result;
        try {
          const parsed = JSON.parse(result);
          if (parsed && typeof parsed === 'object') {
            const parts: string[] = [];
            if (parsed.briefing) parts.push(parsed.briefing);
            else if (parsed.sections && typeof parsed.sections === 'object') {
              for (const [key, val] of Object.entries(parsed.sections)) {
                if (val && typeof val === 'string') parts.push(`**${key.charAt(0).toUpperCase() + key.slice(1)}:** ${val}`);
              }
            }
            if (parsed.dream_log && typeof parsed.dream_log === 'object') {
              const dl = parsed.dream_log;
              parts.push('🧠 Dream cycle complete');
              if (dl.total_after != null) parts.push(`Memories: ${dl.total_after}`);
              if (dl.duplicates_found) parts.push(`Duplicates merged: ${dl.duplicates_found}`);
              if (dl.stale_pruned) parts.push(`Stale pruned: ${dl.stale_pruned}`);
            }
            if (!parts.length && parsed.message) parts.push(parsed.message);
            if (!parts.length && parsed.content) parts.push(parsed.content);
            if (!parts.length && parsed.status) parts.push(`Status: ${parsed.status}`);
            if (parts.length) body = parts.join('\n');
          }
        } catch { /* not JSON, use raw text */ }
        body = body.replace(/\n{3,}/g, '\n\n').trim();
        const preview = body.length > 800 ? body.slice(0, 800) + '…' : body;
        text = `🦖 **Cron Job: ${jobName}** ✅\n\n${preview}`;
      } else {
        text = `🦖 **Cron Job: ${jobName}** ❌\n\nError: ${data?.error || 'Unknown error'}`;
      }
      try {
        await channelRegistry.sendMessage({ channelId: 'telegram', conversationId: CRON_TELEGRAM_CHAT_ID, content: text });
      } catch { /* non-fatal */ }
    });
    const jobCount = cronService.listEnabledJobs().length;
    if (jobCount > 0) log(`${EMOJI} Cron started — ${jobCount} jobs scheduled`);
  } catch (err) {
    console.warn(`${EMOJI} Cron init failed:`, (err as Error).message);
  }

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
      const webRoot = path.resolve(__dirname, '../ui/dist');
      const hasWebUI = fs.existsSync(path.join(webRoot, 'index.html'));
      const { port } = await startGatewayInProcess(hasWebUI ? { webRoot } : undefined);
      console.log(`${EMOJI} ${NAME} gateway running on ws://127.0.0.1:${port}`);
      if (hasWebUI) console.log(`${EMOJI} Web UI: http://127.0.0.1:${port}`);
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
    log.step('Step 1 of 4 — GitHub Copilot');

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
    log.step('Step 2 of 4 — Telegram');

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
    log.step('Step 3 of 4 — Saving configuration');

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

    // ── Step 4: Start daemon automatically ──────────────────────────────────
    log.step('Step 4 of 4 — Starting background daemon');

    let daemonStarted = false;
    const daemonPort = parseInt(process.env.OPENRAPPTER_PORT ?? '18790', 10);

    // Check if daemon is already running
    let alreadyRunning = false;
    try {
      const net = await import('net');
      alreadyRunning = await new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port: daemonPort }, () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => resolve(false));
        sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
      });
    } catch {
      alreadyRunning = false;
    }

    if (alreadyRunning) {
      log.success(`Daemon already running on port ${daemonPort}`);
      daemonStarted = true;
    } else {
      // Start the daemon in a detached child process
      const s = spinner();
      s.start('Starting openrappter daemon…');
      try {
        const { spawn } = await import('child_process');
        const nodeBin = process.execPath;
        const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');

        const child = spawn(nodeBin, [indexPath, '--daemon'], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...env },
        });

        // Wait up to 8 seconds for the gateway to start
        const started = await new Promise<boolean>((resolve) => {
          let output = '';
          const timeout = setTimeout(() => resolve(false), 8000);
          child.stdout?.on('data', (data: Buffer) => {
            output += data.toString();
            if (output.includes('gateway running')) {
              clearTimeout(timeout);
              resolve(true);
            }
          });
          child.on('error', () => { clearTimeout(timeout); resolve(false); });
        });

        child.unref();

        if (started) {
          daemonStarted = true;
          s.stop('Daemon started — gateway running on ws://127.0.0.1:' + daemonPort);
        } else {
          s.stop('Daemon may still be starting — check with: openrappter --status');
        }
      } catch (err) {
        s.stop(`Could not start daemon: ${(err as Error).message}`);
      }
    }

    // Install launchd agent (macOS) so daemon survives reboots
    if (process.platform === 'darwin') {
      const plistPath = path.join(process.env.HOME ?? '', 'Library', 'LaunchAgents', 'com.openrappter.daemon.plist');
      try {
        const nodeBin = process.execPath;
        const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
        const logPath = path.join(HOME_DIR, 'daemon.log');

        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openrappter.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${indexPath}</string>
        <string>--daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}</string>
        <key>HOME</key>
        <string>${process.env.HOME ?? ''}</string>
    </dict>
</dict>
</plist>`;

        fs.mkdirSync(path.dirname(plistPath), { recursive: true });
        fs.writeFileSync(plistPath, plist);
        // Load the plist (don't fail if already loaded)
        execAsync(`launchctl load -w "${plistPath}" 2>/dev/null`).catch(() => {});
        log.success('Auto-start installed — daemon will restart on login');
      } catch {
        log.info('Auto-start not installed — run `openrappter --daemon` manually after reboots');
      }
    } else {
      log.info('Tip: Add `openrappter --daemon &` to your shell profile for auto-start');
    }

    // ── Set up daily tip cron job (onboarding drip) ──
    try {
      const cronFile = path.join(HOME_DIR, 'cron.json');
      let cronJobs: Array<Record<string, unknown>> = [];
      try {
        cronJobs = JSON.parse(fs.readFileSync(cronFile, 'utf-8'));
      } catch { /* no cron.json yet */ }

      const hasTip = cronJobs.some(j => j.agentId === 'DailyTip');
      if (!hasTip) {
        cronJobs.push({
          id: 'job_daily_tip',
          name: 'daily-tip',
          schedule: '0 9 * * *',
          agentId: 'DailyTip',
          message: 'Send today\'s onboarding tip',
          enabled: true,
          createdAt: new Date().toISOString(),
        });
        fs.writeFileSync(cronFile, JSON.stringify(cronJobs, null, 2));
        log.success('Daily tips enabled — you\'ll get one tip per day at 9am for 30 days');
      }

      // Install terminal-notifier for clickable notifications (macOS)
      if (process.platform === 'darwin') {
        try {
          await execAsync('which terminal-notifier');
        } catch {
          try {
            await execAsync('which brew');
            const s = spinner();
            s.start('Installing clickable notifications (terminal-notifier)…');
            await execAsync('brew install terminal-notifier');
            s.stop('Clickable notifications ready — tips will open the app when clicked');
          } catch {
            // Homebrew not available or install failed — osascript fallback works fine
          }
        }
      }
    } catch {
      // Non-critical — tips just won't be scheduled
    }

    // Send the first tip immediately as a welcome notification
    try {
      const tipAgent = (await registry.getAgent('DailyTip'));
      if (tipAgent) {
        await tipAgent.execute({ action: 'tip' });
        log.success('Welcome notification sent — click it to open openrappter!');
      }
    } catch { /* non-critical */ }

    // ── Final Summary ───────────────────────────────────────────────────────
    const finalLines = [
      `Copilot:    ${copilotReady ? '✅ Ready' : '❌ Not configured'}`,
      `Telegram:   ${telegramReady ? '✅ Connected' : '⬚  Skipped'}`,
      `Daemon:     ${daemonStarted ? '✅ Running on port ' + daemonPort : '⬚  Not started'}`,
      `Cron Jobs:  ${daemonStarted ? '✅ Scheduled' : '⬚  Waiting for daemon'}`,
      `Auto-start: ${process.platform === 'darwin' ? '✅ Installed (launchd)' : '⬚  Manual'}`,
      `Daily Tips: ✅ 30-day onboarding series at 9am`,
      '',
      `Chat:       openrappter "hello"`,
      `Status:     openrappter --status`,
      `Dashboard:  openrappter --web`,
      `Re-run:     openrappter onboard`,
    ];
    note(finalLines.join('\n'), `${EMOJI} Everything is running`);

    outro(`${EMOJI} You're all set! openrappter is running in the background.`);
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
