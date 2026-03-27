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
import { LispyVM, STRATEGIES } from './lispy.js';
import type { LispAction } from './lispy.js';

export interface TuiBarOptions {
  port?: number;
  token?: string;
}

interface TuiState {
  connected: boolean;
  agents: Array<{ id: string; type: string; description?: string }>;
  uptime: number;
  view: 'chat' | 'agents' | 'pong' | 'experimental' | 'status';
  chatHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  experimentalFeatures: Record<string, boolean>;
  pong: PongState | null;
}

const EMOJI = '🦖';
const VIEWS = ['chat', 'agents', 'pong', 'experimental', 'status'] as const;

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
  lines.push('  W/S       Move paddle (pong view)');
  lines.push('  q         Quit');
  return lines;
}

// ── Pong Mini-Game (inline, zero deps) ──────────────────────────────────────

const PONG = {
  PADDLE_H: 4,
  PADDLE_OFFSET: 1,
  BALL_SPEED: 0.5,
  BALL_MAX: 1.4,
  BALL_INC: 0.04,
  WIN_SCORE: 5,
} as const;

interface PongState {
  ball: { x: number; y: number; vx: number; vy: number };
  p1: { y: number; score: number };
  p2: { y: number; score: number };
  fieldW: number;
  fieldH: number;
  countdown: number;
  winner: null | 1 | 2;
  running: boolean;
  input: { up: boolean; down: boolean };
  aiVm: LispyVM;
}

function createPongState(fieldW: number, fieldH: number): PongState {
  const vm = new LispyVM();
  vm.setStrategy(STRATEGIES.predictor);
  return {
    ball: { x: fieldW / 2, y: fieldH / 2, vx: PONG.BALL_SPEED, vy: PONG.BALL_SPEED * 0.6 },
    p1: { y: fieldH / 2 - PONG.PADDLE_H / 2, score: 0 },
    p2: { y: fieldH / 2 - PONG.PADDLE_H / 2, score: 0 },
    fieldW,
    fieldH,
    countdown: 3,
    winner: null,
    running: true,
    input: { up: false, down: false },
    aiVm: vm,
  };
}

function pongTick(ps: PongState): void {
  if (!ps.running || ps.winner || ps.countdown > 0) return;

  const { PADDLE_H, PADDLE_OFFSET, BALL_INC, BALL_MAX, WIN_SCORE } = PONG;

  // Player paddle
  if (ps.input.up) ps.p1.y = Math.max(0, ps.p1.y - 1);
  if (ps.input.down) ps.p1.y = Math.min(ps.fieldH - PADDLE_H, ps.p1.y + 1);
  ps.input.up = false;
  ps.input.down = false;

  // AI paddle — driven by lispy VM
  const aiAction: LispAction = ps.aiVm.tick({
    'ball-x': ps.ball.x,
    'ball-y': ps.ball.y,
    'ball-vx': ps.ball.vx,
    'ball-vy': ps.ball.vy,
    'paddle-y': ps.p2.y,
    'paddle-center': ps.p2.y + PADDLE_H / 2,
    'paddle-x': ps.fieldW - PADDLE_OFFSET - 1,
    'opponent-y': ps.p1.y,
    'field-w': ps.fieldW,
    'field-h': ps.fieldH,
    'paddle-h': PADDLE_H,
  });
  if (aiAction.direction === 'up') {
    ps.p2.y = Math.max(0, ps.p2.y - aiAction.speed);
  } else if (aiAction.direction === 'down') {
    ps.p2.y = Math.min(ps.fieldH - PADDLE_H, ps.p2.y + aiAction.speed);
  }

  // Ball
  ps.ball.x += ps.ball.vx;
  ps.ball.y += ps.ball.vy;

  // Bounce top/bottom
  if (ps.ball.y <= 0) { ps.ball.y = 0; ps.ball.vy = Math.abs(ps.ball.vy); }
  if (ps.ball.y >= ps.fieldH - 1) { ps.ball.y = ps.fieldH - 1; ps.ball.vy = -Math.abs(ps.ball.vy); }

  // Left paddle hit
  if (
    ps.ball.x <= PADDLE_OFFSET + 1 && ps.ball.x >= PADDLE_OFFSET &&
    ps.ball.y >= ps.p1.y && ps.ball.y < ps.p1.y + PADDLE_H
  ) {
    ps.ball.vx = Math.abs(ps.ball.vx);
    ps.ball.vy = ((ps.ball.y - ps.p1.y) / PADDLE_H - 0.5) * 1.4;
    const sign = ps.ball.vx > 0 ? 1 : -1;
    ps.ball.vx = sign * Math.min(Math.abs(ps.ball.vx) + BALL_INC, BALL_MAX);
  }

  // Right paddle hit
  if (
    ps.ball.x >= ps.fieldW - PADDLE_OFFSET - 2 && ps.ball.x <= ps.fieldW - PADDLE_OFFSET - 1 &&
    ps.ball.y >= ps.p2.y && ps.ball.y < ps.p2.y + PADDLE_H
  ) {
    ps.ball.vx = -Math.abs(ps.ball.vx);
    ps.ball.vy = ((ps.ball.y - ps.p2.y) / PADDLE_H - 0.5) * 1.4;
    const sign = ps.ball.vx > 0 ? 1 : -1;
    ps.ball.vx = sign * Math.min(Math.abs(ps.ball.vx) + BALL_INC, BALL_MAX);
  }

  // Score
  if (ps.ball.x < 0) {
    ps.p2.score++;
    if (ps.p2.score >= WIN_SCORE) { ps.winner = 2; return; }
    ps.ball.x = ps.fieldW / 2; ps.ball.y = ps.fieldH / 2;
    ps.ball.vx = PONG.BALL_SPEED; ps.ball.vy = (Math.random() - 0.5) * PONG.BALL_SPEED;
  }
  if (ps.ball.x > ps.fieldW - 1) {
    ps.p1.score++;
    if (ps.p1.score >= WIN_SCORE) { ps.winner = 1; return; }
    ps.ball.x = ps.fieldW / 2; ps.ball.y = ps.fieldH / 2;
    ps.ball.vx = -PONG.BALL_SPEED; ps.ball.vy = (Math.random() - 0.5) * PONG.BALL_SPEED;
  }
}

function renderPongView(ps: PongState, width: number, height: number): string[] {
  const lines: string[] = [];
  const fw = Math.min(width - 6, ps.fieldW);
  const fh = Math.min(height - 2, ps.fieldH);

  // Score header
  const scoreLeft = `${EMOJI} You: ${ps.p1.score}`;
  const scoreRight = `AI: ${ps.p2.score} 🤖`;
  const scorePad = Math.max(1, fw - scoreLeft.length - scoreRight.length - 2);
  lines.push(chalk.green(scoreLeft) + ' '.repeat(scorePad) + chalk.red(scoreRight));

  // Field
  for (let row = 0; row < fh; row++) {
    let line = '';
    for (let col = 0; col < fw; col++) {
      const isP1 = col === PONG.PADDLE_OFFSET && row >= Math.round(ps.p1.y) && row < Math.round(ps.p1.y) + PONG.PADDLE_H;
      const isP2 = col === fw - PONG.PADDLE_OFFSET - 1 && row >= Math.round(ps.p2.y) && row < Math.round(ps.p2.y) + PONG.PADDLE_H;
      const isBall = Math.round(ps.ball.x) === col && Math.round(ps.ball.y) === row;
      const isNet = col === Math.floor(fw / 2);

      if (isBall) {
        line += chalk.yellow('●');
      } else if (isP1) {
        line += chalk.green('█');
      } else if (isP2) {
        line += chalk.red('█');
      } else if (isNet) {
        line += row % 2 === 0 ? chalk.dim('│') : ' ';
      } else {
        line += ' ';
      }
    }
    lines.push(line);
  }

  // Status message
  if (ps.winner) {
    const msg = ps.winner === 1 ? '🏆 You win!' : '🤖 AI wins!';
    lines.push(chalk.bold.yellow(`${msg}  Press R to rematch`));
  } else if (ps.countdown > 0) {
    lines.push(chalk.bold.cyan(`Starting in ${ps.countdown}...`));
  } else {
    lines.push(chalk.dim('W/↑ up · S/↓ down · 🧘 breathe between rallies'));
  }

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
    case 'pong':
      if (state.pong) {
        content = renderPongView(state.pong, cols, contentHeight);
      } else {
        content = [chalk.dim('Initializing pong...')];
      }
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
    pong: null,
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

  // Pong game tick (60fps when active)
  const pongInterval = setInterval(() => {
    if (state.view === 'pong' && state.pong) {
      pongTick(state.pong);
      render(state);
    }
  }, 1000 / 30); // 30fps — smooth enough inside the bar

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
      clearInterval(pongInterval);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      client?.disconnect();
      process.exit(0);
    }

    // Tab — switch views
    if (key === '\t') {
      const idx = VIEWS.indexOf(state.view);
      state.view = VIEWS[(idx + 1) % VIEWS.length];
      inputBuffer = '';

      // Initialize pong when entering the view
      if (state.view === 'pong' && !state.pong) {
        const { cols } = getTermSize();
        const fw = Math.min(cols - 8, 70);
        const fh = 16;
        state.pong = createPongState(fw, fh);
        // Countdown timer
        let cd = 3;
        const cdTimer = setInterval(() => {
          cd--;
          if (state.pong) state.pong.countdown = cd;
          if (cd <= 0) clearInterval(cdTimer);
        }, 1000);
      }

      render(state);
      return;
    }

    // Pong view — game controls
    if (state.view === 'pong' && state.pong) {
      if ((key === 'w' || key === 'W') || key === '\x1b[A') {
        state.pong.input.up = true;
        return;
      }
      if ((key === 's' || key === 'S') || key === '\x1b[B') {
        state.pong.input.down = true;
        return;
      }
      if (key === 'r' || key === 'R') {
        if (state.pong.winner) {
          const { cols } = getTermSize();
          const fw = Math.min(cols - 8, 70);
          state.pong = createPongState(fw, 16);
          state.pong.countdown = 0; // instant rematch
        }
        return;
      }
      return; // swallow other keys in pong view
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
