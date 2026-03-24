/**
 * TUI-based OpenRappter Bar
 *
 * ⚠️  EXPERIMENTAL: Subject to change. Use at your own risk.
 *
 * A rich terminal UI for monitoring and interacting with OpenRappter.
 * Uses readline + ANSI escape codes (no heavy deps like ink/blessed).
 *
 * Features:
 * - Status bar (gateway connection, uptime, agent count)
 * - Agent list panel
 * - Chat interface
 * - Experimental features toggle
 * - Voice mode status
 */

import chalk from 'chalk';
import readline from 'readline';

export interface TuiBarOptions {
  port?: number;
  token?: string;
}

interface TuiState {
  connected: boolean;
  agents: Array<{ id: string; type: string; description?: string }>;
  uptime: number;
  view: 'chat' | 'agents' | 'experimental' | 'status';
  chatHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  experimentalFeatures: Record<string, boolean>;
}

const EMOJI = '🦖';
const VIEWS = ['chat', 'agents', 'experimental', 'status'] as const;

function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[H');
}

function moveCursor(row: number, col: number): void {
  process.stdout.write(`\x1B[${row};${col}H`);
}

function getTermSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

function renderBox(title: string, content: string[], width: number): string[] {
  const lines: string[] = [];
  const inner = width - 4;
  const titleStr = ` ${title} `;
  const topPad = Math.max(0, Math.floor((inner - titleStr.length) / 2));

  lines.push(chalk.dim('┌' + '─'.repeat(topPad) + chalk.bold.white(titleStr) + '─'.repeat(Math.max(0, inner - topPad - titleStr.length)) + '──┐'));

  for (const line of content) {
    const stripped = line.replace(/\x1B\[[0-9;]*m/g, '');
    const pad = Math.max(0, inner - stripped.length);
    lines.push(chalk.dim('│ ') + line + ' '.repeat(pad) + chalk.dim(' │'));
  }

  lines.push(chalk.dim('└' + '─'.repeat(inner + 2) + '┘'));
  return lines;
}

function renderStatusBar(state: TuiState, width: number): string {
  const status = state.connected
    ? chalk.green('● Connected')
    : chalk.red('○ Disconnected');

  const agents = chalk.cyan(`${state.agents.length} agents`);
  const uptimeStr = formatUptime(state.uptime);
  const view = chalk.yellow(`[${state.view}]`);

  const left = `${EMOJI} OpenRappter Bar  ${status}  ${agents}  ${uptimeStr}`;
  const right = `${view}  Tab:switch  q:quit`;

  const leftStripped = left.replace(/\x1B\[[0-9;]*m/g, '');
  const rightStripped = right.replace(/\x1B\[[0-9;]*m/g, '');
  const pad = Math.max(1, width - leftStripped.length - rightStripped.length);

  return chalk.bgBlue.white(left + ' '.repeat(pad) + right);
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function renderChatView(state: TuiState, width: number, height: number): string[] {
  const lines: string[] = [];
  const maxLines = height - 6; // Leave room for status bar, input, borders

  const history = state.chatHistory.slice(-maxLines);
  for (const msg of history) {
    if (msg.role === 'user') {
      lines.push(chalk.cyan('You: ') + msg.content);
    } else if (msg.role === 'assistant') {
      lines.push(chalk.green(`${EMOJI}: `) + msg.content);
    } else {
      lines.push(chalk.yellow('ℹ ') + chalk.dim(msg.content));
    }
  }

  // Pad to fill space
  while (lines.length < maxLines) {
    lines.push('');
  }

  return lines;
}

function renderAgentsView(state: TuiState, width: number): string[] {
  if (state.agents.length === 0) {
    return [chalk.dim('No agents loaded. Start the gateway first.')];
  }

  const lines: string[] = [];
  for (const agent of state.agents) {
    lines.push(
      chalk.bold.white(`  ${agent.id}`) +
      chalk.dim(` (${agent.type})`) +
      (agent.description ? '\n    ' + chalk.dim(agent.description.slice(0, width - 8)) : '')
    );
  }
  return lines;
}

function renderExperimentalView(state: TuiState, width: number): string[] {
  const lines: string[] = [];
  lines.push(chalk.yellow('⚠️  EXPERIMENTAL: Subject to change. Use at your own risk.'));
  lines.push('');

  const features: Array<{ key: string; name: string; desc: string }> = [
    { key: 'voiceMode', name: 'Local Voice Mode', desc: 'On-device speech-to-text (Whisper/Vosk)' },
    { key: 'tuiBar', name: 'TUI Bar', desc: 'This terminal dashboard (you\'re using it!)' },
    { key: 'repetitionDetection', name: 'Repetition Detection', desc: 'Detect when user repeats themselves' },
    { key: 'vipAnswer', name: 'VIP Answer Mode', desc: 'Enhanced responses for repeated questions' },
  ];

  for (const feat of features) {
    const enabled = state.experimentalFeatures[feat.key] ?? false;
    const toggle = enabled ? chalk.green('[ON] ') : chalk.red('[OFF]');
    lines.push(`  ${toggle} ${chalk.bold(feat.name)}`);
    lines.push(`       ${chalk.dim(feat.desc)}`);
    lines.push('');
  }

  lines.push(chalk.dim('  Press number key (1-4) to toggle features'));
  return lines;
}

function renderStatusView(state: TuiState, width: number): string[] {
  const lines: string[] = [];
  lines.push(chalk.bold('Gateway'));
  lines.push(`  Status:   ${state.connected ? chalk.green('Connected') : chalk.red('Disconnected')}`);
  lines.push(`  Uptime:   ${formatUptime(state.uptime)}`);
  lines.push(`  Agents:   ${state.agents.length}`);
  lines.push('');
  lines.push(chalk.bold('Experimental Features'));
  for (const [key, enabled] of Object.entries(state.experimentalFeatures)) {
    lines.push(`  ${enabled ? chalk.green('●') : chalk.red('○')} ${key}`);
  }
  lines.push('');
  lines.push(chalk.bold('Keyboard Shortcuts'));
  lines.push('  Tab       Switch view');
  lines.push('  Enter     Send message (chat view)');
  lines.push('  1-4       Toggle feature (experimental view)');
  lines.push('  q         Quit');
  return lines;
}

function render(state: TuiState): void {
  const { rows, cols } = getTermSize();
  clearScreen();

  // Status bar
  moveCursor(1, 1);
  process.stdout.write(renderStatusBar(state, cols));

  // Main content
  let content: string[];
  const contentHeight = rows - 4;

  switch (state.view) {
    case 'chat':
      content = renderChatView(state, cols, contentHeight);
      break;
    case 'agents':
      content = renderAgentsView(state, cols);
      break;
    case 'experimental':
      content = renderExperimentalView(state, cols);
      break;
    case 'status':
      content = renderStatusView(state, cols);
      break;
  }

  // Render content in a box
  const boxLines = renderBox(state.view.toUpperCase(), content.slice(0, contentHeight), cols);
  for (let i = 0; i < boxLines.length && i + 2 < rows - 1; i++) {
    moveCursor(i + 2, 1);
    process.stdout.write(boxLines[i]);
  }

  // Input line
  moveCursor(rows, 1);
  if (state.view === 'chat') {
    process.stdout.write(chalk.cyan('> '));
  } else {
    process.stdout.write(chalk.dim(`[${state.view}] Press Tab to switch, q to quit`));
  }
}

export async function startTuiBar(options: TuiBarOptions = {}): Promise<void> {
  const port = options.port ?? 18790;

  const state: TuiState = {
    connected: false,
    agents: [],
    uptime: 0,
    view: 'status',
    chatHistory: [
      { role: 'system', content: `OpenRappter TUI Bar — connecting to ws://127.0.0.1:${port}…` },
    ],
    experimentalFeatures: {
      voiceMode: false,
      tuiBar: true,
      repetitionDetection: false,
      vipAnswer: false,
    },
  };

  // Try to connect to gateway
  let client: any = null;
  try {
    const { TuiGatewayClient } = await import('./gateway-client.js');
    client = new TuiGatewayClient();
    await client.connect(`ws://127.0.0.1:${port}`, options.token);
    state.connected = true;
    state.chatHistory.push({ role: 'system', content: 'Connected to gateway.' });

    // Fetch agent list
    try {
      const agentList = await client.call('agents.list');
      if (Array.isArray(agentList)) {
        state.agents = agentList;
      }
    } catch { /* agents.list may not be available */ }

    // Subscribe to chat events
    await client.subscribe(['chat']);
    client.on('chat', (payload: any) => {
      if (payload.state === 'final' && payload.message) {
        const content = payload.message.content?.[0]?.text ?? payload.message.content ?? '';
        state.chatHistory.push({ role: 'assistant', content });
        render(state);
      }
    });
  } catch {
    state.chatHistory.push({ role: 'system', content: 'Could not connect. Start gateway: openrappter --daemon' });
  }

  // Set up raw mode for keyboard input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let inputBuffer = '';

  // Initial render
  render(state);

  // Uptime ticker
  const uptimeInterval = setInterval(() => {
    if (state.connected) state.uptime++;
  }, 1000);

  // Refresh display
  const renderInterval = setInterval(() => render(state), 2000);

  // Handle resize
  process.stdout.on('resize', () => render(state));

  // Handle keypress
  process.stdin.on('data', async (key: string) => {
    // Ctrl+C or q (outside chat input)
    if (key === '\u0003' || (key === 'q' && state.view !== 'chat')) {
      clearScreen();
      moveCursor(1, 1);
      console.log(`${EMOJI} OpenRappter TUI Bar closed.`);
      clearInterval(uptimeInterval);
      clearInterval(renderInterval);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      client?.disconnect();
      process.exit(0);
    }

    // Tab — switch views
    if (key === '\t') {
      const idx = VIEWS.indexOf(state.view);
      state.view = VIEWS[(idx + 1) % VIEWS.length];
      inputBuffer = '';
      render(state);
      return;
    }

    // Experimental view — number keys toggle features
    if (state.view === 'experimental') {
      const featureKeys = Object.keys(state.experimentalFeatures);
      const num = parseInt(key, 10);
      if (num >= 1 && num <= featureKeys.length) {
        const fk = featureKeys[num - 1];
        state.experimentalFeatures[fk] = !state.experimentalFeatures[fk];
        render(state);
      }
      return;
    }

    // Chat view — handle text input
    if (state.view === 'chat') {
      if (key === '\r' || key === '\n') {
        // Send message
        const msg = inputBuffer.trim();
        inputBuffer = '';
        if (msg) {
          state.chatHistory.push({ role: 'user', content: msg });
          render(state);
          if (client && state.connected) {
            try {
              await client.call('chat.send', { message: msg });
            } catch (err) {
              state.chatHistory.push({ role: 'system', content: `Error: ${(err as Error).message}` });
            }
          } else {
            state.chatHistory.push({ role: 'system', content: 'Not connected to gateway.' });
          }
          render(state);
        }
        return;
      }

      // Backspace
      if (key === '\x7f' || key === '\b') {
        inputBuffer = inputBuffer.slice(0, -1);
        render(state);
        // Rewrite input
        const { rows } = getTermSize();
        moveCursor(rows, 1);
        process.stdout.write(chalk.cyan('> ') + inputBuffer + '  ');
        moveCursor(rows, 3 + inputBuffer.length);
        return;
      }

      // Regular character
      if (key.length === 1 && key >= ' ') {
        inputBuffer += key;
        const { rows } = getTermSize();
        moveCursor(rows, 1);
        process.stdout.write(chalk.cyan('> ') + inputBuffer);
        return;
      }
    }
  });
}
