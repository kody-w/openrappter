/**
 * Sentinel — the first-class front door.
 *
 * You give it a situation and boundaries. It decides what to do, including
 * deciding to do nothing. There is deliberately no field here for a task: the
 * whole value of the pattern comes from the system being able to disagree with
 * you about what should happen, and a system handed a procedure cannot.
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface Watcher {
  slug: string; role: string; frames: number;
  chain_ok: boolean; chain_detail: string;
  age_minutes: number | null; alive: boolean;
  truncated?: boolean; revised?: boolean;
}
interface Direction {
  situation: string; boundaries: string[]; cares_about: string[];
  freedom: number; budgets: { repair_per_day: number; evolve_per_day: number };
  updated_at?: string;
}
interface Status {
  installed: boolean; home: string | null;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  summary: string;
  checks: Array<{ id: string; ok: boolean; severity: string; detail: string }>;
  watchers: Watcher[]; direction: Direction | null;
  integrity: 'verified' | 'revised' | 'truncated' | 'unknown';
  last_tick: string | null;
  verdict_at: string | null;
  verdict_age_minutes: number | null;
}
interface Frame {
  watcher: string; kind: string; seq: number; utc: string;
  payload: Record<string, unknown>; frame_hash: string;
}

const FREEDOM = [
  ['Observe', 'Watches and records. Never spends a model, never changes anything.'],
  ['Alert', 'Tells you when something breaks. Still changes nothing.'],
  ['Diagnose', 'Investigates a failure and explains the cause. Proposes, does not apply.'],
  ['Repair', 'Fixes what broke, then re-probes to prove the fix actually landed.'],
  ['Evolve', 'When nothing is broken, acts on its own initiative. Declining is a valid outcome.'],
];

@customElement('openrappter-sentinel')
export class OpenRappterSentinel extends LitElement {
  static styles = css`
    :host { display: block; padding: 1.5rem 2rem 4rem; max-width: 1100px; }
    h2 { font-size: 1.5rem; margin: 0 0 .25rem; }
    .lede { color: var(--text-secondary); margin: 0 0 1.75rem; max-width: 62ch; line-height: 1.5; }
    .card {
      background: var(--bg-secondary); border: 1px solid var(--border);
      border-radius: 10px; padding: 1.25rem; margin-bottom: 1.25rem;
    }
    .card h3 { margin: 0 0 .35rem; font-size: .95rem; letter-spacing: .02em; }
    .hint { color: var(--text-secondary); font-size: .82rem; margin: 0 0 .9rem; line-height: 1.5; }
    textarea, input {
      width: 100%; box-sizing: border-box; background: var(--bg-primary);
      color: var(--text-primary); border: 1px solid var(--border);
      border-radius: 7px; padding: .7rem .8rem; font: inherit; font-size: .9rem;
      line-height: 1.55; resize: vertical;
    }
    textarea:focus, input:focus { outline: none; border-color: var(--accent); }
    .banner {
      border-radius: 9px; padding: .85rem 1rem; margin-bottom: 1.25rem;
      font-size: .88rem; line-height: 1.5; border: 1px solid;
    }
    .banner.ok   { background: rgba(46,160,67,.10); border-color: rgba(46,160,67,.45); }
    .banner.bad  { background: rgba(248,81,73,.10); border-color: rgba(248,81,73,.5); }
    .banner.warn { background: rgba(210,153,34,.10); border-color: rgba(210,153,34,.45); }
    .banner .sub { color: var(--text-secondary); font-size: .8rem; display: block; margin-top: .35rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: .8rem; }
    .watcher { background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: .8rem .9rem; }
    .watcher .slug { font-weight: 600; font-size: .9rem; }
    .watcher .role { color: var(--text-secondary); font-size: .78rem; margin: .2rem 0 .5rem; line-height: 1.4; }
    .watcher .meta { font-size: .75rem; color: var(--text-secondary); font-family: ui-monospace, monospace; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: .4rem; }
    .dot.up { background: var(--accent); } .dot.down { background: var(--error); }
    .ladder { display: flex; flex-direction: column; gap: .4rem; margin: .3rem 0 0; }
    .rung {
      display: flex; gap: .7rem; align-items: flex-start; padding: .55rem .7rem;
      border: 1px solid var(--border); border-radius: 7px; cursor: pointer; background: var(--bg-primary);
    }
    .rung[aria-checked="true"] { border-color: var(--accent); background: rgba(46,160,67,.07); }
    .rung .n { font-family: ui-monospace, monospace; font-size: .78rem; color: var(--text-secondary); padding-top: .1rem; }
    .rung .lbl { font-weight: 600; font-size: .86rem; }
    .rung .desc { color: var(--text-secondary); font-size: .78rem; line-height: 1.45; }
    button {
      background: var(--accent); color: #fff; border: 0; border-radius: 7px;
      padding: .6rem 1.1rem; font: inherit; font-weight: 600; font-size: .87rem; cursor: pointer;
    }
    button.ghost { background: transparent; color: var(--text-primary); border: 1px solid var(--border); }
    button:disabled { opacity: .5; cursor: default; }
    .row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
    .feed { display: flex; flex-direction: column; gap: .1rem; max-height: 460px; overflow: auto; }
    .ev { display: grid; grid-template-columns: 74px 118px 1fr; gap: .7rem; padding: .45rem .2rem;
          border-bottom: 1px solid var(--border); font-size: .81rem; align-items: baseline; }
    .ev time { color: var(--text-secondary); font-family: ui-monospace, monospace; font-size: .76rem; }
    .ev .who { color: var(--text-secondary); font-family: ui-monospace, monospace; font-size: .76rem; }
    .ev .what { line-height: 1.45; word-break: break-word; }
    .tag { font-size: .68rem; padding: .1rem .4rem; border-radius: 4px; font-weight: 600;
           text-transform: uppercase; letter-spacing: .04em; margin-right: .45rem; }
    .tag.declined { background: rgba(210,153,34,.2); color: #d29922; }
    .tag.acted { background: rgba(46,160,67,.18); color: var(--accent); }
    .tag.crit { background: rgba(248,81,73,.18); color: var(--error); }
    .empty { color: var(--text-secondary); font-size: .86rem; padding: 1.5rem 0; text-align: center; }
    ul.b { margin: .3rem 0 0; padding-left: 1.1rem; }
    ul.b li { font-size: .84rem; line-height: 1.6; color: var(--text-secondary); }
    code { font-family: ui-monospace, monospace; font-size: .82em; }
  `;

  @state() private st: Status | null = null;
  @state() private frames: Frame[] = [];
  @state() private busy = false;
  @state() private draft: Direction | null = null;
  /** Never swallowed. A view that hides its own failure behind a spinner is the
   *  exact defect this whole surface exists to make visible. */
  @state() private error: string | null = null;
  @state() private tries = 0;
  @state() private waiting = true;

  connectedCallback() {
    super.connectedCallback();
    // The gateway handshake may not have finished when this mounts, so poll
    // briefly at first rather than sitting on a stale spinner for 20 seconds.
    this.refresh();
    this.fast = window.setInterval(() => {
      if (this.st || (!this.waiting && this.tries > 12)) {
        window.clearInterval(this.fast);
        this.fast = undefined;
        return;
      }
      this.refresh();
    }, 1200);
    this.timer = window.setInterval(() => this.refresh(), 20_000);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer) window.clearInterval(this.timer);
    if (this.fast) window.clearInterval(this.fast);
  }
  private timer?: number;
  private fast?: number;

  private async refresh() {
    // The app owns the gateway handshake and the single onStatusChange slot,
    // so poll the connection rather than clobbering its handler. A call issued
    // before the socket is up fails with "Not connected", which is a fact about
    // this component's timing, not about the sentinel.
    if (!gateway.isConnected) {
      this.error = null;
      this.waiting = true;
      return;
    }
    this.waiting = false;
    this.tries += 1;
    try {
      const st = (await gateway.call('sentinel.status')) as Status;
      this.st = st;
      this.error = null;
      if (!this.draft) this.draft = st.direction ?? null;
      const f = (await gateway.call('sentinel.frames', { limit: 60 })) as { frames: Frame[] };
      this.frames = f.frames ?? [];
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async save() {
    if (!this.draft) return;
    this.busy = true;
    try {
      await gateway.call('sentinel.direction.set', { ...this.draft });
      await this.refresh();
    } finally { this.busy = false; }
  }

  /** A live health run makes real network calls and takes ~10s, so it is opt-in
   *  and the cached verdict says how old it is rather than pretending to be now. */
  private async check() {
    this.busy = true;
    try { await gateway.call('sentinel.check'); await this.refresh(); }
    finally { this.busy = false; }
  }

  private async tick() {
    this.busy = true;
    try { await gateway.call('sentinel.tick'); await this.refresh(); }
    finally { this.busy = false; }
  }

  private async install() {
    this.busy = true;
    try { await gateway.call('sentinel.install'); await this.refresh(); }
    finally { this.busy = false; }
  }

  private edit(patch: Partial<Direction>) {
    this.draft = { ...(this.draft as Direction), ...patch };
  }

  private renderIntegrity() {
    const st = this.st!;
    if (st.integrity === 'verified') {
      return html`<div class="banner ok"><strong>Record verified.</strong>
        Every chain re-verifies from genesis, and every frame — not just the head —
        still reproduces the digests an external witness recorded earlier.
        <span class="sub">Chain self-verification alone would not license that. It proves
        the writer was deterministic, not that history is unchanged.</span></div>`;
    }
    if (st.integrity === 'revised') {
      return html`<div class="banner bad"><strong>Record revised.</strong>
        A chain still verifies, but no longer reproduces a digest witnessed earlier.
        An interior frame was rewritten after the fact.
        <span class="sub">Treat everything below as suspect until you know who changed it.</span></div>`;
    }
    if (st.integrity === 'truncated') {
      return html`<div class="banner bad"><strong>Record truncated.</strong>
        Frames that were witnessed are no longer present.</div>`;
    }
    return html`<div class="banner warn"><strong>Integrity unknown.</strong>
      Not enough history yet to say anything either way.</div>`;
  }

  private renderFrame(f: Frame) {
    const p = f.payload ?? {};
    const outcome = String((p as any).outcome ?? '');
    const declined = /^DECLINED/i.test(outcome);
    const status = String((p as any).status ?? '');
    let tag = html``;
    if (declined) tag = html`<span class="tag declined">declined</span>`;
    else if (f.kind === 'neighbor.acted') tag = html`<span class="tag acted">acted</span>`;
    else if (status === 'critical') tag = html`<span class="tag crit">critical</span>`;
    const text = outcome || (p as any).detail || status ||
      (p as any).result || f.kind;
    return html`<div class="ev">
      <time>${f.utc?.slice(11, 19)}Z</time>
      <span class="who">${f.watcher}</span>
      <span class="what">${tag}${String(text).slice(0, 260)}</span>
    </div>`;
  }

  render() {
    const st = this.st;
    if (!st) {
      // Say which of the two it is. "Connecting…" forever is a lie by omission.
      if (this.error && this.tries > 3) {
        return html`<h2>Sentinel</h2>
          <div class="banner bad"><strong>The sentinel did not answer.</strong>
            <span class="sub">${this.error}</span>
            <span class="sub">The gateway connection is open, so this is the
              sentinel methods failing — not the socket. Tried ${this.tries} times.</span></div>
          <button class="ghost" @click=${() => this.refresh()}>Retry</button>`;
      }
      return html`<div class="empty">${this.waiting
        ? 'Waiting for the gateway connection…'
        : 'Loading sentinel…'}</div>`;
    }

    if (!st.installed) {
      return html`
        <h2>Sentinel</h2>
        <p class="lede">Nothing is watching anything yet.</p>
        <div class="card">
          <h3>Set up a neighborhood</h3>
          <p class="hint">Three watchers, each keeping its own tamper-evident record,
            each able to notice when another has gone quiet. You give them a situation
            and boundaries; they decide what to do about it.</p>
          <button ?disabled=${this.busy} @click=${this.install}>
            ${this.busy ? 'Setting up…' : 'Set up sentinel'}
          </button>
        </div>`;
    }

    const d = this.draft ?? st.direction;
    const dirty = JSON.stringify(d) !== JSON.stringify(st.direction);

    return html`
      <h2>Sentinel</h2>
      <p class="lede">You describe what matters and what is off limits.
        It decides what to do — including deciding that nothing needs doing.
        There is no field here for a task, on purpose.</p>

      ${this.renderIntegrity()}

      <div class="card">
        <h3>What matters</h3>
        <p class="hint">Describe the situation, not the work. What is true right now,
          what you care about, what would count as things going wrong. The more you
          describe the world and the less you describe the steps, the more it can
          find things you did not think of.</p>
        <textarea rows="5" .value=${d?.situation ?? ''}
          @input=${(e: Event) => this.edit({ situation: (e.target as HTMLTextAreaElement).value })}
          placeholder="e.g. Two public sites run off GitHub Actions. Both have gone silently stale before while every dashboard stayed green. I am asleep between midnight and eight."></textarea>
      </div>

      <div class="card">
        <h3>What it must never do</h3>
        <p class="hint">Hard limits, one per line. These are the only absolutes —
          everything else is its judgement.</p>
        <textarea rows="4" .value=${(d?.boundaries ?? []).join('\n')}
          @input=${(e: Event) => this.edit({ boundaries: (e.target as HTMLTextAreaElement).value.split('\n').filter(Boolean) })}
        ></textarea>
      </div>

      <div class="card">
        <h3>How much rope</h3>
        <p class="hint">What it may do without asking you first.</p>
        <div class="ladder">
          ${FREEDOM.map(([label, desc], i) => html`
            <div class="rung" role="radio" aria-checked=${d?.freedom === i}
                 @click=${() => this.edit({ freedom: i })}>
              <span class="n">${i}</span>
              <span>
                <span class="lbl">${label}</span>
                <div class="desc">${desc}</div>
              </span>
            </div>`)}
        </div>
      </div>

      <div class="card">
        <div class="row">
          <button ?disabled=${this.busy || !dirty} @click=${this.save}>
            ${dirty ? 'Save direction' : 'Saved'}
          </button>
          <button class="ghost" ?disabled=${this.busy} @click=${this.tick}>Run a cycle now</button>
          <button class="ghost" ?disabled=${this.busy} @click=${this.check}>Re-check now</button>
          <span class="hint" style="margin:0">
            ${st.summary}${st.verdict_age_minutes !== null
              ? html` · <strong>as of ${st.verdict_age_minutes}m ago</strong>`
              : ''} · last cycle ${st.last_tick ?? 'never'}
          </span>
        </div>
      </div>

      <div class="card">
        <h3>The neighborhood</h3>
        <p class="hint">Each watcher keeps its own record. None of them can read another's,
          which is why one going wrong does not quietly corrupt the rest.</p>
        <div class="grid">
          ${st.watchers.map((w) => html`
            <div class="watcher">
              <div class="slug"><span class="dot ${w.alive ? 'up' : 'down'}"></span>${w.slug}</div>
              <div class="role">${w.role}</div>
              <div class="meta">${w.frames} frames · ${w.chain_ok ? 'verified' : 'CHAIN BROKEN'}${
                w.revised ? ' · REVISED' : ''}${w.truncated ? ' · TRUNCATED' : ''}</div>
            </div>`)}
        </div>
      </div>

      <div class="card">
        <h3>What it has been doing</h3>
        <p class="hint">Append-only, oldest at the bottom. A <code>declined</code> is not a
          failure — it means it was asked to act, considered it, and judged that acting
          would be worse.</p>
        <div class="feed">
          ${this.frames.length
            ? this.frames.map((f) => this.renderFrame(f))
            : html`<div class="empty">No frames yet.</div>`}
        </div>
      </div>

      ${st.checks.length ? html`
      <div class="card">
        <h3>Checks</h3>
        <ul class="b">${st.checks.map((c) => html`
          <li><strong>${c.ok ? '✓' : '✗'}</strong> <code>${c.id}</code> — ${c.detail}</li>`)}
        </ul>
      </div>` : ''}
    `;
  }
}
