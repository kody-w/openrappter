import { program } from 'commander';
import { intro, outro, text, select, note, spinner } from '@clack/prompts';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

const VERSION = '1.0.0';
const EMOJI = '🦖';
const NAME = 'openRAPPter';
const HOME_DIR = path.join(os.homedir(), '.openrappter');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');

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
  const hasCopilot = await hasCopilotCLI();

  if (!hasCopilot) {
    return `${EMOJI} ${NAME}: I heard "${message}". For full AI responses, install GitHub Copilot CLI.`;
  }

  try {
    // Use Copilot SDK
    const { createSession } = await import('@github/copilot-sdk');
    const session = await createSession({
      systemMessage: `You are ${NAME} ${EMOJI}, a friendly AI assistant that runs locally. Be helpful and concise.`,
    });

    const response = await session.sendAndWait(message);
    await session.close();
    return response;
  } catch (error) {
    // Fallback to CLI
    try {
      const { stdout } = await execAsync(`copilot --message "${message.replace(/"/g, '\\"')}"`);
      return stdout.trim();
    } catch {
      return `${EMOJI} ${NAME}: I couldn't process that. Check your Copilot CLI installation.`;
    }
  }
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
  .action(async (message, options) => {
    await ensureHomeDir();

    if (options.status) {
      await statusCommand();
      return;
    }

    if (options.task) {
      const s = spinner();
      s.start('Processing...');
      const response = await chat(options.task);
      s.stop('Done');
      console.log(`\n${EMOJI} ${NAME}: ${response}\n`);
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
      console.log(`${EMOJI} ${NAME} daemon started`);
      console.log('Press Ctrl+C to stop\n');
      setInterval(() => {
        console.log(`[${new Date().toISOString()}] Daemon tick`);
      }, 60000);
      return;
    }

    if (message) {
      const response = await chat(message);
      console.log(`\n${EMOJI} ${NAME}: ${response}\n`);
      return;
    }

    // Interactive mode
    await interactiveMode();
  });

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

  console.log(`\n${EMOJI} ${NAME} Status\n`);
  console.log(`  Version: ${VERSION}`);
  console.log(`  Home: ${HOME_DIR}`);
  console.log(`  Copilot: ${hasCopilot ? chalk.green('✅ Available') : chalk.yellow('❌ Not found')}`);
  console.log(`  Setup: ${config.setupComplete ? chalk.green('✅ Complete') : chalk.yellow('Not run')}`);
  console.log('');
}

// Interactive mode
async function interactiveMode(): Promise<void> {
  const hasCopilot = await hasCopilotCLI();

  if (hasCopilot) {
    console.log(chalk.dim('Using GitHub Copilot SDK...\n'));
  }

  console.log(`${EMOJI} ${NAME} Chat`);
  console.log('─'.repeat(40));
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

      const s = spinner();
      s.start('Thinking...');

      try {
        const response = await chat(trimmed);
        s.stop('');
        console.log(`\n${EMOJI} ${NAME}: ${response}\n`);
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
