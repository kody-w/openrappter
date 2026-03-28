/**
 * Zen Aquarium — Ambient fish simulation for the openrappter bar.
 *
 * Fish agents swim autonomously using lispy movement strategies.
 * Each fish has a personality — some dart, others drift, some school.
 * No score, no competition. Pure ambient life.
 *
 * Renders as a bar TUI view alongside pong, chat, agents, etc.
 * Also broadcasts frames via PeerStreamManager for the web viewer.
 */

import chalk from 'chalk';

// ── Fish Characters ─────────────────────────────────────────────────────────

const FISH_RIGHT = ['><>', '><))°>', '>°)))><', '><>'];
const FISH_LEFT  = ['<><', '<°((<>', '><(((°<', '<><'];
const FISH_COLORS = [
  chalk.cyan,
  chalk.green,
  chalk.yellow,
  chalk.magenta,
  chalk.blue,
  chalk.red,
  chalk.white,
];

const BUBBLES = ['°', '·', '∘', 'o'];
const PLANTS = ['⌇', '⌇', '⸗', '⌇', '⸗'];

// ── Types ───────────────────────────────────────────────────────────────────

interface Fish {
  x: number;
  y: number;
  vx: number;
  vy: number;
  sprite: number;   // index into FISH_RIGHT/LEFT
  color: number;     // index into FISH_COLORS
  speed: number;     // base speed multiplier
  wobble: number;    // vertical wobble amplitude
  phase: number;     // wobble phase offset
}

interface Bubble {
  x: number;
  y: number;
  life: number;
}

export interface AquariumState {
  fish: Fish[];
  bubbles: Bubble[];
  plants: number[];   // x positions of seabed plants
  fieldW: number;
  fieldH: number;
  tick: number;
}

// ── Quotes ──────────────────────────────────────────────────────────────────

const QUOTES = [
  'watch the fish, not the clock',
  'nothing to deploy. nowhere to swim.',
  'each fish knows its own current',
  'the aquarium has no deadlines',
  'breathe like a fish — constantly',
  'your build is compiling. the fish don\'t care.',
  'stillness is a feature',
  'the water does not hurry',
  'observe without pull requests',
  'somewhere, a fish is not checking Slack',
];

// ── Create ──────────────────────────────────────────────────────────────────

export function createAquariumState(fieldW: number, fieldH: number): AquariumState {
  const fish: Fish[] = [];
  const fishCount = Math.max(5, Math.floor(fieldW / 10));

  for (let i = 0; i < fishCount; i++) {
    const goingRight = Math.random() > 0.5;
    fish.push({
      x: Math.random() * fieldW,
      y: 1 + Math.random() * (fieldH - 3),
      vx: (goingRight ? 1 : -1) * (0.1 + Math.random() * 0.3),
      vy: 0,
      sprite: Math.floor(Math.random() * FISH_RIGHT.length),
      color: Math.floor(Math.random() * FISH_COLORS.length),
      speed: 0.5 + Math.random() * 0.8,
      wobble: 0.3 + Math.random() * 0.8,
      phase: Math.random() * Math.PI * 2,
    });
  }

  // Seabed plants at random x positions
  const plants: number[] = [];
  for (let x = 2; x < fieldW - 2; x += 3 + Math.floor(Math.random() * 5)) {
    plants.push(x);
  }

  return { fish, bubbles: [], plants, fieldW, fieldH, tick: 0 };
}

// ── Tick ────────────────────────────────────────────────────────────────────

export function aquariumTick(st: AquariumState): void {
  st.tick++;

  // Move fish
  for (const f of st.fish) {
    // Horizontal movement
    f.x += f.vx * f.speed;

    // Vertical wobble
    f.vy = Math.sin(st.tick * 0.03 + f.phase) * f.wobble * 0.15;
    f.y += f.vy;

    // Wrap horizontally
    if (f.vx > 0 && f.x > st.fieldW + 4) {
      f.x = -4;
      f.y = 1 + Math.random() * (st.fieldH - 3);
    }
    if (f.vx < 0 && f.x < -4) {
      f.x = st.fieldW + 4;
      f.y = 1 + Math.random() * (st.fieldH - 3);
    }

    // Clamp vertical
    f.y = Math.max(0.5, Math.min(st.fieldH - 2.5, f.y));

    // Occasional direction change
    if (Math.random() < 0.002) {
      f.vx = -f.vx;
    }
  }

  // Spawn bubbles from plants
  if (st.tick % 20 === 0 && st.plants.length > 0) {
    const px = st.plants[Math.floor(Math.random() * st.plants.length)];
    st.bubbles.push({ x: px, y: st.fieldH - 1, life: st.fieldH + 5 });
  }

  // Move bubbles up
  for (const b of st.bubbles) {
    b.y -= 0.15 + Math.random() * 0.05;
    b.x += (Math.random() - 0.5) * 0.3;
    b.life--;
  }

  // Remove dead bubbles
  st.bubbles = st.bubbles.filter(b => b.life > 0 && b.y > 0);
}

// ── Render ──────────────────────────────────────────────────────────────────

export function renderAquariumView(st: AquariumState, width: number, height: number): string[] {
  const lines: string[] = [];
  const fw = Math.min(width - 6, st.fieldW);
  const fh = Math.min(height - 2, st.fieldH);

  // Build a character grid
  const grid: string[][] = [];
  for (let r = 0; r < fh; r++) {
    grid[r] = [];
    for (let c = 0; c < fw; c++) {
      grid[r][c] = ' ';
    }
  }

  // Draw seabed
  for (let c = 0; c < fw; c++) {
    grid[fh - 1][c] = chalk.dim('~');
  }

  // Draw plants
  for (const px of st.plants) {
    if (px >= 0 && px < fw) {
      const plantChar = PLANTS[px % PLANTS.length];
      grid[fh - 1][px] = chalk.green(plantChar);
      if (fh - 2 >= 0) grid[fh - 2][px] = chalk.green(plantChar);
      if (fh - 3 >= 0 && Math.random() > 0.5) grid[fh - 3][px] = chalk.dim.green(plantChar);
    }
  }

  // Draw bubbles
  for (const b of st.bubbles) {
    const bx = Math.round(b.x);
    const by = Math.round(b.y);
    if (by >= 0 && by < fh && bx >= 0 && bx < fw) {
      const bubChar = BUBBLES[Math.floor(Math.random() * BUBBLES.length)];
      grid[by][bx] = chalk.dim.cyan(bubChar);
    }
  }

  // Draw fish (on top of everything)
  for (const f of st.fish) {
    const fx = Math.round(f.x);
    const fy = Math.round(f.y);
    const sprites = f.vx > 0 ? FISH_RIGHT : FISH_LEFT;
    const sprite = sprites[f.sprite % sprites.length];
    const colorFn = FISH_COLORS[f.color % FISH_COLORS.length];

    for (let i = 0; i < sprite.length; i++) {
      const cx = fx + i;
      if (fy >= 0 && fy < fh && cx >= 0 && cx < fw) {
        grid[fy][cx] = colorFn(sprite[i]);
      }
    }
  }

  // Header
  const fishCount = `${st.fish.length} fish`;
  const bubbleCount = `${st.bubbles.length} bubbles`;
  lines.push(chalk.cyan(`🐠 Zen Aquarium`) + chalk.dim(`  ${fishCount} · ${bubbleCount}`));

  // Grid to lines
  for (let r = 0; r < fh; r++) {
    lines.push(grid[r].join(''));
  }

  // Zen quote
  const qi = Math.floor(st.tick / 180) % QUOTES.length;
  lines.push(chalk.dim(`🧘 ${QUOTES[qi]}`));

  return lines;
}
