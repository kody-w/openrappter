#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  🏓  PONG — Terminal Pong (Solo & Multiplayer)
//
//  Usage:
//    node pong.js solo [easy|medium|hard]  ← Play vs computer AI
//    node pong.js host [port]              ← Start as Player 1 (left paddle)
//    node pong.js join <ip> [port]         ← Join as Player 2 (right paddle)
//
//  Controls:
//    W / ↑   Move paddle up
//    S / ↓   Move paddle down
//    Q       Quit
//    R       Rematch (after game ends)
//
//  Zero dependencies — just Node.js.
// ═══════════════════════════════════════════════════════════════════════════

const net = require('net');
const readline = require('readline');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.argv[3] || process.argv[4] || '4040', 10);
const TICK_MS = 1000 / 60; // 60 fps
const WIDTH = 78;
const HEIGHT = 22;
const PADDLE_H = 5;
const PADDLE_X_OFFSET = 2;
const BALL_SPEED_INIT = 0.6;
const BALL_SPEED_INC = 0.05;
const BALL_MAX_SPEED = 1.8;
const WIN_SCORE = 7;

// ── Game State ──────────────────────────────────────────────────────────────
function createState() {
  return {
    ball: { x: WIDTH / 2, y: HEIGHT / 2, vx: BALL_SPEED_INIT, vy: BALL_SPEED_INIT * 0.6 },
    p1: { y: HEIGHT / 2 - PADDLE_H / 2, score: 0 },
    p2: { y: HEIGHT / 2 - PADDLE_H / 2, score: 0 },
    msg: '',
    running: true,
    countdown: 3,
    winner: null,
  };
}

// ── Terminal helpers ────────────────────────────────────────────────────────
const CSI = '\x1b[';
const clear = () => process.stdout.write(`${CSI}2J${CSI}H`);
const moveTo = (x, y) => `${CSI}${y + 1};${x + 1}H`;
const hide = () => process.stdout.write(`${CSI}?25l`);
const show = () => process.stdout.write(`${CSI}?25h`);
const bold = (s) => `${CSI}1m${s}${CSI}0m`;
const dim = (s) => `${CSI}2m${s}${CSI}0m`;
const cyan = (s) => `${CSI}36m${s}${CSI}0m`;
const yellow = (s) => `${CSI}33m${s}${CSI}0m`;
const green = (s) => `${CSI}32m${s}${CSI}0m`;
const red = (s) => `${CSI}31m${s}${CSI}0m`;
const white = (s) => `${CSI}97m${s}${CSI}0m`;
const magenta = (s) => `${CSI}35m${s}${CSI}0m`;

// ── Rendering ───────────────────────────────────────────────────────────────
function render(state, role) {
  let buf = '';
  buf += `${CSI}H`; // cursor home

  const fw = WIDTH + 2; // +2 for border chars

  // Score line
  const scoreText = ` ${state.p1.score}  ·  ${state.p2.score} `;
  const roleText = role === 'host' ? ' You: LEFT ' : ' You: RIGHT ';
  const pad = fw - scoreText.length - roleText.length;
  buf += moveTo(0, 0);
  buf += cyan(roleText) + ' '.repeat(Math.max(0, pad)) + bold(white(scoreText));

  // Top border
  buf += moveTo(0, 1);
  buf += dim('┌' + '─'.repeat(WIDTH) + '┐');

  // Field rows
  for (let row = 0; row < HEIGHT; row++) {
    buf += moveTo(0, row + 2);
    let line = '';
    for (let col = 0; col < WIDTH; col++) {
      const isP1 = col === PADDLE_X_OFFSET && row >= state.p1.y && row < state.p1.y + PADDLE_H;
      const isP2 = col === WIDTH - PADDLE_X_OFFSET - 1 && row >= state.p2.y && row < state.p2.y + PADDLE_H;
      const isBall = Math.round(state.ball.x) === col && Math.round(state.ball.y) === row;
      const isCenter = col === Math.floor(WIDTH / 2);

      if (isBall) {
        line += yellow('●');
      } else if (isP1) {
        line += green('█');
      } else if (isP2) {
        line += magenta('█');
      } else if (isCenter) {
        line += dim(row % 2 === 0 ? '│' : ' ');
      } else {
        line += ' ';
      }
    }
    buf += dim('│') + line + dim('│');
  }

  // Bottom border
  buf += moveTo(0, HEIGHT + 2);
  buf += dim('└' + '─'.repeat(WIDTH) + '┘');

  // Message line
  buf += moveTo(0, HEIGHT + 3);
  buf += ' '.repeat(fw);
  buf += moveTo(0, HEIGHT + 3);
  if (state.winner) {
    const winMsg = state.winner === 1 ? '🏆  Player 1 wins!' : '🏆  Player 2 wins!';
    buf += bold(yellow(`  ${winMsg}  Press Q to quit, R to rematch`));
  } else if (state.countdown > 0) {
    buf += bold(cyan(`  Starting in ${state.countdown}...`));
  } else if (state.msg) {
    buf += dim(`  ${state.msg}`);
  } else {
    buf += dim('  W/↑ = up · S/↓ = down · Q = quit');
  }

  // Controls hint line
  buf += moveTo(0, HEIGHT + 4);
  buf += ' '.repeat(fw);

  process.stdout.write(buf);
}

// ── Physics (server only) ───────────────────────────────────────────────────
function tick(state, p1input, p2input) {
  if (!state.running || state.winner) return;
  if (state.countdown > 0) return;

  const speed = 1.0;

  // Move paddles
  if (p1input.up) state.p1.y = Math.max(0, state.p1.y - speed);
  if (p1input.down) state.p1.y = Math.min(HEIGHT - PADDLE_H, state.p1.y + speed);
  if (p2input.up) state.p2.y = Math.max(0, state.p2.y - speed);
  if (p2input.down) state.p2.y = Math.min(HEIGHT - PADDLE_H, state.p2.y + speed);

  // Move ball
  state.ball.x += state.ball.vx;
  state.ball.y += state.ball.vy;

  // Bounce off top/bottom
  if (state.ball.y <= 0) {
    state.ball.y = 0;
    state.ball.vy = Math.abs(state.ball.vy);
  }
  if (state.ball.y >= HEIGHT - 1) {
    state.ball.y = HEIGHT - 1;
    state.ball.vy = -Math.abs(state.ball.vy);
  }

  // Paddle collision — left
  if (
    state.ball.x <= PADDLE_X_OFFSET + 1 &&
    state.ball.x >= PADDLE_X_OFFSET &&
    state.ball.y >= state.p1.y &&
    state.ball.y < state.p1.y + PADDLE_H
  ) {
    state.ball.vx = Math.abs(state.ball.vx);
    // Angle based on where ball hits paddle
    const hitPos = (state.ball.y - state.p1.y) / PADDLE_H - 0.5;
    state.ball.vy = hitPos * 1.5;
    speedUp(state);
  }

  // Paddle collision — right
  if (
    state.ball.x >= WIDTH - PADDLE_X_OFFSET - 2 &&
    state.ball.x <= WIDTH - PADDLE_X_OFFSET - 1 &&
    state.ball.y >= state.p2.y &&
    state.ball.y < state.p2.y + PADDLE_H
  ) {
    state.ball.vx = -Math.abs(state.ball.vx);
    const hitPos = (state.ball.y - state.p2.y) / PADDLE_H - 0.5;
    state.ball.vy = hitPos * 1.5;
    speedUp(state);
  }

  // Score — ball past left edge
  if (state.ball.x < 0) {
    state.p2.score++;
    checkWin(state) || resetBall(state, 1);
  }

  // Score — ball past right edge
  if (state.ball.x > WIDTH - 1) {
    state.p1.score++;
    checkWin(state) || resetBall(state, -1);
  }
}

function speedUp(state) {
  const sign = state.ball.vx > 0 ? 1 : -1;
  const cur = Math.abs(state.ball.vx);
  state.ball.vx = sign * Math.min(cur + BALL_SPEED_INC, BALL_MAX_SPEED);
}

function resetBall(state, dir) {
  state.ball.x = WIDTH / 2;
  state.ball.y = HEIGHT / 2;
  state.ball.vx = BALL_SPEED_INIT * dir;
  state.ball.vy = (Math.random() - 0.5) * BALL_SPEED_INIT;
}

function checkWin(state) {
  if (state.p1.score >= WIN_SCORE) {
    state.winner = 1;
    return true;
  }
  if (state.p2.score >= WIN_SCORE) {
    state.winner = 2;
    return true;
  }
  return false;
}

// ── Input handling ──────────────────────────────────────────────────────────
function setupInput(onKey) {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    for (const ch of data) {
      onKey(ch);
    }
    // Handle escape sequences (arrow keys)
    if (data === '\x1b[A') onKey('UP');
    if (data === '\x1b[B') onKey('DOWN');
  });
}

// ── Network Protocol ────────────────────────────────────────────────────────
// Newline-delimited JSON over TCP
function sendMsg(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch {}
}

function onMessages(socket, handler) {
  let buf = '';
  socket.on('data', (data) => {
    buf += data.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        handler(JSON.parse(line));
      } catch {}
    }
  });
}

// ── HOST MODE ───────────────────────────────────────────────────────────────
function runHost() {
  let state = createState();
  let p1input = { up: false, down: false };
  let p2input = { up: false, down: false };
  let client = null;

  clear();
  hide();
  state.msg = 'Waiting for Player 2 to join...';
  render(state, 'host');

  const localIP = getLocalIP();
  process.stdout.write(moveTo(0, HEIGHT + 5));
  process.stdout.write(dim(`  Player 2 command: `) + bold(cyan(`node pong.js join ${localIP} ${PORT}`)));
  process.stdout.write(moveTo(0, HEIGHT + 6));
  process.stdout.write(dim(`  Listening on port ${PORT}...`));

  const server = net.createServer((socket) => {
    if (client) {
      socket.end();
      return;
    }
    client = socket;
    state.msg = 'Player 2 connected!';

    // Start countdown
    let cd = 3;
    state.countdown = cd;
    const cdTimer = setInterval(() => {
      cd--;
      state.countdown = cd;
      if (cd <= 0) clearInterval(cdTimer);
    }, 1000);

    onMessages(socket, (msg) => {
      if (msg.type === 'input') {
        p2input = msg.input;
      }
      if (msg.type === 'rematch') {
        state = createState();
        p1input = { up: false, down: false };
        p2input = { up: false, down: false };
        let cd2 = 3;
        state.countdown = cd2;
        const cdTimer2 = setInterval(() => {
          cd2--;
          state.countdown = cd2;
          if (cd2 <= 0) clearInterval(cdTimer2);
        }, 1000);
      }
    });

    socket.on('close', () => {
      client = null;
      state.msg = 'Player 2 disconnected. Waiting for reconnect...';
      state.running = false;
    });

    socket.on('error', () => {
      client = null;
    });
  });

  server.listen(PORT, '0.0.0.0');

  // Input
  setupInput((key) => {
    if (key === 'q' || key === 'Q' || key === '\x03') cleanup(server);
    if (key === 'w' || key === 'W' || key === 'UP') p1input.up = true;
    if (key === 's' || key === 'S' || key === 'DOWN') p1input.down = true;
    if (key === 'r' || key === 'R') {
      if (state.winner) {
        state = createState();
        p1input = { up: false, down: false };
        p2input = { up: false, down: false };
        let cd3 = 3;
        state.countdown = cd3;
        const cdTimer3 = setInterval(() => {
          cd3--;
          state.countdown = cd3;
          if (cd3 <= 0) clearInterval(cdTimer3);
        }, 1000);
        if (client) sendMsg(client, { type: 'rematch' });
      }
    }
  });

  // Key release simulation — reset each tick
  setInterval(() => {
    // Game tick
    tick(state, p1input, p2input);

    // Render locally
    render(state, 'host');

    // Send state to client
    if (client) {
      sendMsg(client, { type: 'state', state });
    }

    // Reset momentary inputs
    p1input = { up: false, down: false };
  }, TICK_MS);
}

// ── CLIENT MODE ─────────────────────────────────────────────────────────────
function runClient(host) {
  let state = createState();
  let myInput = { up: false, down: false };

  clear();
  hide();
  state.msg = `Connecting to ${host}:${PORT}...`;
  render(state, 'client');

  const socket = net.createConnection({ host, port: PORT }, () => {
    state.msg = 'Connected! Waiting for game to start...';
    render(state, 'client');
  });

  onMessages(socket, (msg) => {
    if (msg.type === 'state') {
      state = msg.state;
      render(state, 'client');
    }
    if (msg.type === 'rematch') {
      state = createState();
    }
  });

  socket.on('error', (err) => {
    clear();
    show();
    console.error(red(`  Connection failed: ${err.message}`));
    console.error(dim(`  Make sure the host is running: node pong.js host`));
    process.exit(1);
  });

  socket.on('close', () => {
    clear();
    show();
    console.log(yellow('  Host disconnected. Game over.'));
    process.exit(0);
  });

  // Input — send to server
  setupInput((key) => {
    if (key === 'q' || key === 'Q' || key === '\x03') {
      socket.end();
      cleanup();
    }
    if (key === 'w' || key === 'W' || key === 'UP') myInput.up = true;
    if (key === 's' || key === 'S' || key === 'DOWN') myInput.down = true;
    if (key === 'r' || key === 'R') {
      sendMsg(socket, { type: 'rematch' });
    }
  });

  // Send input at 60fps
  setInterval(() => {
    if (myInput.up || myInput.down) {
      sendMsg(socket, { type: 'input', input: myInput });
    }
    myInput = { up: false, down: false };
  }, TICK_MS);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function cleanup(server) {
  show();
  clear();
  process.stdout.write(moveTo(0, 0));
  console.log(dim('  Thanks for playing! 🏓'));
  if (server) server.close();
  process.exit(0);
}

// ── ZEN MODE (Autonomous AI vs AI spectator) ───────────────────────────────
const ZEN_QUOTES = [
  'breathe in... breathe out...',
  'the ball knows where to go',
  'watch the rhythm, not the score',
  'you are not your build errors',
  'let the rappters play',
  'nothing to do. nowhere to be.',
  'the deploy will finish when it finishes',
  'observe without attachment',
  'each rally is a tiny meditation',
  'the terminal is your garden',
  'patience is a feature, not a bug',
  'be the ball',
  'your code is compiling. you are enough.',
];

function runZen() {
  let state = createState();
  let quoteIdx = Math.floor(Math.random() * ZEN_QUOTES.length);
  let quoteTick = 0;
  const QUOTE_INTERVAL = 60 * 6; // rotate quote every ~6 seconds

  // Two AI personalities — slightly different so rallies feel organic
  const leftAI  = { speed: 0.72, reactionZone: 1.8, missChance: 0.06, drift: 0.025 };
  const rightAI = { speed: 0.68, reactionZone: 2.0, missChance: 0.07, drift: 0.020 };

  clear();
  hide();

  // Countdown
  let cd = 3;
  state.countdown = cd;
  const cdTimer = setInterval(() => {
    cd--;
    state.countdown = cd;
    if (cd <= 0) clearInterval(cdTimer);
  }, 1000);

  // Only input: Q to quit
  setupInput((key) => {
    if (key === 'q' || key === 'Q' || key === '\x03') cleanup();
  });

  function moveAI(paddle, ai, ballHeadingToward) {
    const center = paddle.y + PADDLE_H / 2;
    const diff = state.ball.y - center;

    if (ballHeadingToward) {
      if (Math.random() > ai.missChance) {
        if (Math.abs(diff) > ai.reactionZone) {
          paddle.y += (diff > 0 ? ai.speed : -ai.speed);
        }
      }
    } else {
      // Lazily drift toward center
      const mid = HEIGHT / 2 - PADDLE_H / 2;
      paddle.y += (mid - paddle.y) * ai.drift;
    }
    paddle.y = Math.max(0, Math.min(HEIGHT - PADDLE_H, paddle.y));
  }

  // Game loop
  setInterval(() => {
    if (state.running && !state.winner && state.countdown <= 0) {
      moveAI(state.p1, leftAI,  state.ball.vx < 0);
      moveAI(state.p2, rightAI, state.ball.vx > 0);
    }

    tick(state, { up: false, down: false }, { up: false, down: false });

    // Auto-rematch after a win
    if (state.winner) {
      setTimeout(() => {
        state = createState();
        state.countdown = 0; // no countdown on rematch
      }, 2500);
      state.running = false; // freeze until rematch
    }

    // Rotate zen quote
    quoteTick++;
    if (quoteTick >= QUOTE_INTERVAL) {
      quoteTick = 0;
      quoteIdx = (quoteIdx + 1) % ZEN_QUOTES.length;
    }

    renderZen(state, ZEN_QUOTES[quoteIdx]);
  }, TICK_MS);
}

function renderZen(state, quote) {
  let buf = '';
  buf += `${CSI}H`;

  const fw = WIDTH + 2;

  // Header: rappter names + score
  const scoreText = ` ${state.p1.score}  ·  ${state.p2.score} `;
  const titleText = ' 🦖 rappterL  vs  rappterR 🦖 ';
  const pad = fw - scoreText.length - titleText.length;
  buf += moveTo(0, 0);
  buf += green(titleText) + ' '.repeat(Math.max(0, pad)) + bold(white(scoreText));

  // Top border
  buf += moveTo(0, 1);
  buf += dim('┌' + '─'.repeat(WIDTH) + '┐');

  // Field rows
  for (let row = 0; row < HEIGHT; row++) {
    buf += moveTo(0, row + 2);
    let line = '';
    for (let col = 0; col < WIDTH; col++) {
      const isP1 = col === PADDLE_X_OFFSET && row >= state.p1.y && row < state.p1.y + PADDLE_H;
      const isP2 = col === WIDTH - PADDLE_X_OFFSET - 1 && row >= state.p2.y && row < state.p2.y + PADDLE_H;
      const isBall = Math.round(state.ball.x) === col && Math.round(state.ball.y) === row;
      const isCenter = col === Math.floor(WIDTH / 2);

      if (isBall) {
        line += yellow('●');
      } else if (isP1) {
        line += green('█');
      } else if (isP2) {
        line += cyan('█');
      } else if (isCenter) {
        line += dim(row % 2 === 0 ? '│' : ' ');
      } else {
        line += ' ';
      }
    }
    buf += dim('│') + line + dim('│');
  }

  // Bottom border
  buf += moveTo(0, HEIGHT + 2);
  buf += dim('└' + '─'.repeat(WIDTH) + '┘');

  // Zen quote line
  buf += moveTo(0, HEIGHT + 3);
  buf += ' '.repeat(fw);
  buf += moveTo(0, HEIGHT + 3);
  if (state.winner) {
    const winMsg = state.winner === 1 ? '🦖 rappterL takes the round!' : '🦖 rappterR takes the round!';
    buf += bold(yellow(`  ${winMsg}`));
  } else if (state.countdown > 0) {
    buf += bold(cyan(`  Starting in ${state.countdown}...`));
  } else {
    buf += dim(`  🧘 ${quote}`);
  }

  // Hint line
  buf += moveTo(0, HEIGHT + 4);
  buf += ' '.repeat(fw);
  buf += moveTo(0, HEIGHT + 4);
  buf += dim('  Q = quit · just watch and breathe');

  process.stdout.write(buf);
}

// ── Entry point ─────────────────────────────────────────────────────────────
const mode = process.argv[2];

if (!mode || !['host', 'join', 'zen'].includes(mode)) {
  console.log('');
  console.log(bold('  🏓  PONG — Terminal Pong'));
  console.log(dim('  ─────────────────────────────────────'));
  console.log('');
  console.log(`  ${bold('Zen mode:')}       ${cyan('node pong.js zen')}       ${dim('← watch two AIs play while you breathe')}`);
  console.log(`  ${bold('Host a game:')}    ${cyan('node pong.js host [port]')}`);
  console.log(`  ${bold('Join a game:')}    ${cyan('node pong.js join <ip> [port]')}`);
  console.log('');
  console.log(dim(`  Default port: ${PORT}`));
  console.log(dim('  First to 7 wins. Q to quit.'));
  console.log('');
  process.exit(0);
}

if (mode === 'zen') {
  runZen();
} else if (mode === 'host') {
  runHost();
} else if (mode === 'join') {
  const host = process.argv[3];
  if (!host) {
    console.error(red('  Error: specify host IP — node pong.js join <ip> [port]'));
    process.exit(1);
  }
  runClient(host);
}
