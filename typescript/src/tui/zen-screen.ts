/**
 * ZenScreen — The opinionated base class for ambient terminal experiences.
 *
 * Steve Jobs design principle: users shouldn't configure anything.
 * The screen knows its layout, manages its lifecycle, and gets out of the way.
 *
 * Layout (fixed, non-negotiable):
 *   ┌──────────────────────────────────────────┐
 *   │  HEADER — title, status, branding        │
 *   ├──────────────────────────────────────────┤
 *   │                                          │
 *   │  CONTENT — the visual experience         │
 *   │                                          │
 *   ├──────────────────────────────────────────┤
 *   │  FOOTER — contextual message / zen quote │
 *   │  HINT   — minimal controls (dim)         │
 *   └──────────────────────────────────────────┘
 *
 * Subclasses implement 5 methods. That's it.
 *
 * Usage:
 *   class MyScreen extends ZenScreen<MyState> {
 *     createState() { return { ... }; }
 *     update(state) { // mutate state each tick }
 *     renderHeader(state) { return 'title'; }
 *     renderContent(state) { return ['line1', 'line2']; }
 *     renderFooter(state) { return 'zen quote'; }
 *   }
 *   new MyScreen({ fps: 60 }).start();
 *
 * PeerJS integration:
 *   screen.onFrame(callback) to capture each rendered frame for streaming.
 */

// ── ANSI Primitives ─────────────────────────────────────────────────────────
// These are the atoms. No chalk, no blessed, no dependencies.

const CSI = '\x1b[';

export const ansi = {
  home:       `${CSI}H`,
  clear:      `${CSI}2J${CSI}H`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  moveTo: (x: number, y: number) => `${CSI}${y + 1};${x + 1}H`,

  // Style
  bold:    (s: string) => `${CSI}1m${s}${CSI}0m`,
  dim:     (s: string) => `${CSI}2m${s}${CSI}0m`,
  italic:  (s: string) => `${CSI}3m${s}${CSI}0m`,

  // Palette — intentionally small. Constraint breeds coherence.
  green:   (s: string) => `${CSI}32m${s}${CSI}0m`,
  cyan:    (s: string) => `${CSI}36m${s}${CSI}0m`,
  yellow:  (s: string) => `${CSI}33m${s}${CSI}0m`,
  red:     (s: string) => `${CSI}31m${s}${CSI}0m`,
  magenta: (s: string) => `${CSI}35m${s}${CSI}0m`,
  white:   (s: string) => `${CSI}97m${s}${CSI}0m`,
} as const;

// Strip ANSI codes for length calculation
export function visibleLength(s: string): number {
  return s.replace(/\x1B\[[0-9;]*m/g, '').length;
}

// Pad a styled string to a visible width
export function padEnd(s: string, width: number): string {
  const vl = visibleLength(s);
  return vl >= width ? s : s + ' '.repeat(width - vl);
}

// ── Box Drawing ─────────────────────────────────────────────────────────────
// One box style. Consistent everywhere.

export function box(lines: string[], width: number): string {
  const inner = width - 2;
  let buf = '';
  buf += ansi.dim('┌' + '─'.repeat(inner) + '┐') + '\n';
  for (const line of lines) {
    buf += ansi.dim('│') + padEnd(line, inner) + ansi.dim('│') + '\n';
  }
  buf += ansi.dim('└' + '─'.repeat(inner) + '┘');
  return buf;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ZenScreenConfig {
  fps?: number;        // Default: 60 (games) or 2 (dashboards)
  width?: number;      // Default: 80 (auto-detects terminal)
  height?: number;     // Default: 24 (auto-detects terminal)
  hint?: string;       // Bottom hint text. Default: 'Q = quit'
  interactive?: boolean; // Accept keyboard input beyond Q. Default: false
}

export type FrameCallback = (frame: string) => void;

// ── ZenScreen ───────────────────────────────────────────────────────────────

export abstract class ZenScreen<T extends Record<string, unknown>> {
  protected config: Required<ZenScreenConfig>;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private frameListeners: FrameCallback[] = [];
  private running = false;

  constructor(config: ZenScreenConfig = {}) {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    this.config = {
      fps: config.fps ?? 60,
      width: config.width ?? Math.min(cols, 80),
      height: config.height ?? Math.min(rows - 6, 22), // leave room for header/footer
      hint: config.hint ?? 'Q = quit',
      interactive: config.interactive ?? false,
    };
  }

  // ── Subclass contract (implement these 5, get everything else free) ─────

  /** Create initial state. Called once on start(). */
  abstract createState(): T;

  /** Mutate state each tick. This is your game loop / update cycle. */
  abstract update(state: T): void;

  /** Return styled header string (one line). */
  abstract renderHeader(state: T): string;

  /** Return styled content lines (fills the box). */
  abstract renderContent(state: T): string[];

  /** Return styled footer string (one line — zen quote, status, etc). */
  abstract renderFooter(state: T): string;

  // ── Optional overrides ──────────────────────────────────────────────────

  /** Handle a keypress. Only called if config.interactive = true. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected handleInput(_key: string, _state: T): void {}

  /** Called once before first render. Setup animations, timers, etc. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected onStart(_state: T): void {}

  /** Called once on cleanup. Tear down anything you set up. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected onStop(_state: T): void {}

  // ── PeerJS frame hook ─────────────────────────────────────────────────

  /** Register a callback to receive every rendered frame (for PeerJS streaming). */
  onFrame(callback: FrameCallback): () => void {
    this.frameListeners.push(callback);
    return () => {
      this.frameListeners = this.frameListeners.filter(cb => cb !== callback);
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): T {
    const state = this.createState();
    this.running = true;

    // Terminal setup
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdout.write(ansi.clear);
    process.stdout.write(ansi.hideCursor);

    // Input routing
    process.stdin.on('data', (data: string) => {
      if (data === 'q' || data === 'Q' || data === '\x03') {
        this.stop(state);
        return;
      }
      if (this.config.interactive) {
        // Decode arrow keys
        if (data === '\x1b[A') { this.handleInput('UP', state); return; }
        if (data === '\x1b[B') { this.handleInput('DOWN', state); return; }
        if (data === '\x1b[C') { this.handleInput('RIGHT', state); return; }
        if (data === '\x1b[D') { this.handleInput('LEFT', state); return; }
        for (const ch of data) {
          this.handleInput(ch, state);
        }
      }
    });

    // Resize
    process.stdout.on('resize', () => {
      this.config.width = Math.min(process.stdout.columns || 80, 80);
      this.config.height = Math.min((process.stdout.rows || 24) - 6, 22);
    });

    this.onStart(state);
    this.render(state); // first frame

    // Tick loop
    const tickMs = 1000 / this.config.fps;
    this.tickInterval = setInterval(() => {
      if (!this.running) return;
      this.update(state);
      this.render(state);
    }, tickMs);

    return state;
  }

  stop(state: T): void {
    this.running = false;
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.onStop(state);

    // Terminal cleanup
    process.stdout.write(ansi.showCursor);
    process.stdout.write(ansi.clear);
    process.stdout.write(ansi.moveTo(0, 0));
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    console.log(ansi.dim('  Thanks for watching! 🧘'));
  }

  // ── Render pipeline ───────────────────────────────────────────────────

  private render(state: T): void {
    const w = this.config.width;
    let buf = ansi.home;

    // Header
    const header = this.renderHeader(state);
    buf += ansi.moveTo(0, 0) + padEnd(header, w) + '\n';

    // Content box
    const content = this.renderContent(state);
    buf += box(content, w);
    buf += '\n';

    // Footer
    const footer = this.renderFooter(state);
    buf += ansi.moveTo(0, this.config.height + 3);
    buf += padEnd(' '.repeat(w), w);
    buf += ansi.moveTo(0, this.config.height + 3);
    buf += padEnd(footer, w);

    // Hint
    buf += ansi.moveTo(0, this.config.height + 4);
    buf += padEnd(' '.repeat(w), w);
    buf += ansi.moveTo(0, this.config.height + 4);
    buf += ansi.dim(`  ${this.config.hint}`);

    // Flush to terminal
    process.stdout.write(buf);

    // Broadcast frame to PeerJS listeners
    for (const listener of this.frameListeners) {
      listener(buf);
    }
  }
}
