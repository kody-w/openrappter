/**
 * Cron Jobs View Component
 * Manage scheduled tasks with create form, scheduler status, and run history.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

type CronSessionTarget = 'main' | 'isolated';
type CronWakeMode = 'next-heartbeat' | 'now';
type CronDeliveryMode = 'none' | 'announce';
type CronPayloadKind = 'systemEvent' | 'agentTurn';

interface CronDelivery {
  mode: CronDeliveryMode;
  channel?: string;
  to?: string;
}

type CronPayload =
  | { kind: 'systemEvent'; text: string }
  | { kind: 'agentTurn'; message: string; timeoutSeconds?: number };

interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  lastError?: string;
}

interface CronJob {
  id: string;
  name: string;
  description?: string;
  agentId?: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  delivery?: CronDelivery;
  state: CronJobState;
}

interface CronStatus {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs: number | null;
}

interface CronListResponse {
  status: CronStatus;
  jobs: CronJob[];
}

interface CronRunLogEntry {
  ts: number;
  status?: string;
  summary?: string;
  durationMs?: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatMs(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) {
    const abs = Math.abs(diff);
    const sec = Math.round(abs / 1000);
    if (sec < 60) return `in ${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `in ${min}m`;
    const hr = Math.round(min / 60);
    return `in ${hr}h`;
  }
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  const fixed = sec.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  return `${fixed}s`;
}

function formatNextRun(ms: number | null | undefined): string {
  if (!ms) return 'n/a';
  return `${formatMs(ms)} (${formatAgo(ms)})`;
}

function formatCronSchedule(job: CronJob): string {
  const s = job.schedule;
  if (s.kind === 'at') {
    const atMs = Date.parse(s.at);
    return Number.isFinite(atMs) ? `At ${formatMs(atMs)}` : `At ${s.at}`;
  }
  if (s.kind === 'every') return `Every ${formatDurationMs(s.everyMs)}`;
  return `Cron ${s.expr}${s.tz ? ` (${s.tz})` : ''}`;
}

function formatCronPayload(job: CronJob): string {
  const p = job.payload;
  if (p.kind === 'systemEvent') return `System: ${p.text}`;
  const base = `Agent: ${p.message}`;
  const d = job.delivery;
  if (d && d.mode !== 'none') {
    const target = d.channel || d.to
      ? ` (${d.channel ?? 'last'}${d.to ? ` -> ${d.to}` : ''})`
      : '';
    return `${base} · ${d.mode}${target}`;
  }
  return base;
}

function formatCronState(job: CronJob): string {
  const s = job.state ?? {};
  const next = s.nextRunAtMs ? formatMs(s.nextRunAtMs) : 'n/a';
  const last = s.lastRunAtMs ? formatMs(s.lastRunAtMs) : 'n/a';
  const status = s.lastStatus ?? 'n/a';
  return `${status} · next ${next} · last ${last}`;
}

function everyMsFromForm(amount: string, unit: string): number {
  const n = parseInt(amount, 10) || 1;
  const multipliers: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  return n * (multipliers[unit] ?? 60_000);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

@customElement('openrappter-cron')
export class OpenRappterCron extends LitElement {
  static styles = css`
    :host { display: block; padding: 1.5rem 2rem; }

    .page-header { margin-bottom: 1.25rem; }
    .page-header h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
    .page-header p { font-size: 0.875rem; color: var(--text-secondary); }

    /* ---- layout ---- */
    .grid-cols-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-bottom: 1.25rem;
    }

    /* ---- card ---- */
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
    }
    .card-title { font-size: 1rem; font-weight: 600; }
    .card-sub { font-size: 0.8125rem; color: var(--text-secondary); margin-top: 0.125rem; }

    /* ---- stat grid ---- */
    .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; }
    .stat-label { font-size: 0.75rem; color: var(--text-secondary); }
    .stat-value { font-size: 0.875rem; font-weight: 600; margin-top: 0.125rem; }

    /* ---- form ---- */
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .field span { font-size: 0.75rem; color: var(--text-secondary); }
    .field input, .field select, .field textarea {
      padding: 0.5rem 0.625rem;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.8125rem;
      font-family: inherit;
    }
    .field input:focus, .field select:focus, .field textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .field.checkbox { flex-direction: row; align-items: center; gap: 0.5rem; }
    .field.checkbox input { width: auto; }

    /* ---- buttons ---- */
    .btn {
      padding: 0.5rem 1rem;
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 0.8125rem;
      cursor: pointer;
    }
    .btn:hover { background: var(--border); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: white; }
    .btn.primary:hover { background: var(--accent-hover); }
    .btn.danger { border-color: var(--error); color: var(--error); }
    .btn.danger:hover { background: var(--error); color: white; }

    .row { display: flex; gap: 0.5rem; align-items: center; }
    .muted { font-size: 0.8125rem; color: var(--text-secondary); }

    /* ---- list ---- */
    .list { display: flex; flex-direction: column; gap: 0.5rem; }
    .list-item {
      display: flex;
      gap: 1rem;
      padding: 1rem 1.25rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
    }
    .list-item-clickable { cursor: pointer; }
    .list-item-clickable:hover { border-color: var(--accent); }
    .list-item-selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--bg-tertiary)); }
    .list-main { flex: 1; min-width: 0; }
    .list-title { font-weight: 600; margin-bottom: 0.125rem; }
    .list-sub { font-size: 0.8125rem; color: var(--text-secondary); }
    .list-meta { text-align: right; font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; }

    /* ---- chips ---- */
    .chip-row { display: flex; gap: 0.375rem; flex-wrap: wrap; }
    .chip {
      display: inline-block;
      padding: 0.125rem 0.5rem;
      font-size: 0.6875rem;
      border-radius: 9999px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }

    .empty-state { text-align: center; padding: 3rem; color: var(--text-secondary); }
  `;

  /* ---- scheduler state ---- */
  @state() private status: CronStatus | null = null;
  @state() private jobs: CronJob[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private busy = false;

  /* ---- form state ---- */
  @state() private formName = '';
  @state() private formDescription = '';
  @state() private formAgentId = '';
  @state() private formEnabled = true;
  @state() private formScheduleKind: 'every' | 'at' | 'cron' = 'every';
  @state() private formEveryAmount = '5';
  @state() private formEveryUnit = 'minutes';
  @state() private formScheduleAt = '';
  @state() private formCronExpr = '';
  @state() private formCronTz = '';
  @state() private formSessionTarget: CronSessionTarget = 'main';
  @state() private formWakeMode: CronWakeMode = 'next-heartbeat';
  @state() private formPayloadKind: CronPayloadKind = 'systemEvent';
  @state() private formPayloadText = '';
  @state() private formDeliveryMode: CronDeliveryMode = 'announce';
  @state() private formDeliveryChannel = 'last';
  @state() private formDeliveryTo = '';
  @state() private formTimeoutSeconds = '';

  /* ---- run history ---- */
  @state() private runsJobId: string | null = null;
  @state() private runs: CronRunLogEntry[] = [];

  /* ---- channels for delivery ---- */
  @state() private channels: string[] = [];

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
    this.loadChannels();
  }

  /* ---- data loading ---- */

  private async refresh() {
    this.loading = true;
    this.error = null;
    try {
      const res = await gateway.call<CronListResponse>('cron.list');
      this.status = res.status;
      this.jobs = res.jobs;
    } catch (e) {
      this.error = String(e);
      this.status = null;
      this.jobs = [];
    }
    this.loading = false;
  }

  private async loadChannels() {
    try {
      const res = await gateway.call<{ channels: string[] }>('channels.list');
      this.channels = res.channels ?? [];
    } catch { /* ignore */ }
  }

  private async loadRuns(jobId: string) {
    this.runsJobId = jobId;
    try {
      const res = await gateway.call<{ runs: CronRunLogEntry[] }>('cron.runs', { jobId });
      this.runs = res.runs ?? [];
    } catch {
      this.runs = [];
    }
  }

  /* ---- actions ---- */

  private async toggleJob(job: CronJob, enabled: boolean) {
    this.busy = true;
    try {
      await gateway.call('cron.enable', { jobId: job.id, enabled });
      await this.refresh();
    } catch (e) {
      console.error('Failed to toggle job:', e);
    }
    this.busy = false;
  }

  private async runJob(job: CronJob) {
    this.busy = true;
    try {
      await gateway.call('cron.run', { jobId: job.id });
      await this.refresh();
    } catch (e) {
      console.error('Failed to run job:', e);
    }
    this.busy = false;
  }

  private async removeJob(job: CronJob) {
    this.busy = true;
    try {
      await gateway.call('cron.remove', { jobId: job.id });
      if (this.runsJobId === job.id) {
        this.runsJobId = null;
        this.runs = [];
      }
      await this.refresh();
    } catch (e) {
      console.error('Failed to remove job:', e);
    }
    this.busy = false;
  }

  private buildSchedule(): CronSchedule {
    if (this.formScheduleKind === 'at') return { kind: 'at', at: this.formScheduleAt };
    if (this.formScheduleKind === 'every') return { kind: 'every', everyMs: everyMsFromForm(this.formEveryAmount, this.formEveryUnit) };
    const sched: CronSchedule = { kind: 'cron', expr: this.formCronExpr };
    if (this.formCronTz) (sched as { kind: 'cron'; expr: string; tz?: string }).tz = this.formCronTz;
    return sched;
  }

  private buildPayload(): CronPayload {
    if (this.formPayloadKind === 'systemEvent') return { kind: 'systemEvent', text: this.formPayloadText };
    const p: CronPayload = { kind: 'agentTurn', message: this.formPayloadText };
    const timeout = parseInt(this.formTimeoutSeconds, 10);
    if (timeout > 0) (p as { kind: 'agentTurn'; message: string; timeoutSeconds?: number }).timeoutSeconds = timeout;
    return p;
  }

  private buildDelivery(): CronDelivery | undefined {
    if (this.formPayloadKind !== 'agentTurn') return undefined;
    const d: CronDelivery = { mode: this.formDeliveryMode };
    if (this.formDeliveryMode === 'announce') {
      if (this.formDeliveryChannel) d.channel = this.formDeliveryChannel;
      if (this.formDeliveryTo) d.to = this.formDeliveryTo;
    }
    return d;
  }

  private async addJob() {
    if (!this.formName.trim()) return;
    this.busy = true;
    try {
      await gateway.call('cron.add', {
        name: this.formName,
        description: this.formDescription || undefined,
        agentId: this.formAgentId || undefined,
        enabled: this.formEnabled,
        schedule: this.buildSchedule(),
        sessionTarget: this.formSessionTarget,
        wakeMode: this.formWakeMode,
        payload: this.buildPayload(),
        delivery: this.buildDelivery(),
      });
      this.formName = '';
      this.formDescription = '';
      this.formAgentId = '';
      this.formPayloadText = '';
      await this.refresh();
    } catch (e) {
      console.error('Failed to add job:', e);
    }
    this.busy = false;
  }

  /* ---- channel options helper ---- */

  private get channelOptions(): string[] {
    const opts = ['last', ...this.channels.filter(Boolean)];
    const current = this.formDeliveryChannel?.trim();
    if (current && !opts.includes(current)) opts.push(current);
    const seen = new Set<string>();
    return opts.filter((v) => { if (seen.has(v)) return false; seen.add(v); return true; });
  }

  /* ---- render ---- */

  render() {
    return html`
      <div class="page-header">
        <h2>Cron Jobs</h2>
        <p>Scheduled tasks and automation.</p>
      </div>

      <section class="grid-cols-2">
        ${this.renderStatusCard()}
        ${this.renderNewJobCard()}
      </section>

      ${this.renderJobsList()}
      ${this.renderRunHistory()}
    `;
  }

  /* -- status card -- */
  private renderStatusCard() {
    return html`
      <div class="card">
        <div class="card-title">Scheduler</div>
        <div class="card-sub">Gateway-owned cron scheduler status.</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">Enabled</div>
            <div class="stat-value">${this.status ? (this.status.enabled ? 'Yes' : 'No') : 'n/a'}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Jobs</div>
            <div class="stat-value">${this.status?.jobs ?? 'n/a'}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Next wake</div>
            <div class="stat-value">${formatNextRun(this.status?.nextWakeAtMs ?? null)}</div>
          </div>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn" ?disabled=${this.loading} @click=${() => this.refresh()}>
            ${this.loading ? 'Refreshing…' : 'Refresh'}
          </button>
          ${this.error ? html`<span class="muted">${this.error}</span>` : nothing}
        </div>
      </div>
    `;
  }

  /* -- new job form -- */
  private renderNewJobCard() {
    return html`
      <div class="card">
        <div class="card-title">New Job</div>
        <div class="card-sub">Create a scheduled wakeup or agent run.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>Name</span>
            <input .value=${this.formName}
              @input=${(e: Event) => { this.formName = (e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field">
            <span>Description</span>
            <input .value=${this.formDescription}
              @input=${(e: Event) => { this.formDescription = (e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field">
            <span>Agent ID</span>
            <input .value=${this.formAgentId} placeholder="default"
              @input=${(e: Event) => { this.formAgentId = (e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field checkbox">
            <span>Enabled</span>
            <input type="checkbox" .checked=${this.formEnabled}
              @change=${(e: Event) => { this.formEnabled = (e.target as HTMLInputElement).checked; }} />
          </label>
          <label class="field">
            <span>Schedule</span>
            <select .value=${this.formScheduleKind}
              @change=${(e: Event) => { this.formScheduleKind = (e.target as HTMLSelectElement).value as 'every' | 'at' | 'cron'; }}>
              <option value="every">Every</option>
              <option value="at">At</option>
              <option value="cron">Cron</option>
            </select>
          </label>
        </div>

        ${this.renderScheduleFields()}

        <div class="form-grid" style="margin-top: 12px;">
          <label class="field">
            <span>Session</span>
            <select .value=${this.formSessionTarget}
              @change=${(e: Event) => { this.formSessionTarget = (e.target as HTMLSelectElement).value as CronSessionTarget; }}>
              <option value="main">Main</option>
              <option value="isolated">Isolated</option>
            </select>
          </label>
          <label class="field">
            <span>Wake mode</span>
            <select .value=${this.formWakeMode}
              @change=${(e: Event) => { this.formWakeMode = (e.target as HTMLSelectElement).value as CronWakeMode; }}>
              <option value="next-heartbeat">Next heartbeat</option>
              <option value="now">Now</option>
            </select>
          </label>
          <label class="field">
            <span>Payload</span>
            <select .value=${this.formPayloadKind}
              @change=${(e: Event) => { this.formPayloadKind = (e.target as HTMLSelectElement).value as CronPayloadKind; }}>
              <option value="systemEvent">System event</option>
              <option value="agentTurn">Agent turn</option>
            </select>
          </label>
        </div>

        <label class="field" style="margin-top: 12px;">
          <span>${this.formPayloadKind === 'systemEvent' ? 'System text' : 'Agent message'}</span>
          <textarea .value=${this.formPayloadText} rows="4"
            @input=${(e: Event) => { this.formPayloadText = (e.target as HTMLTextAreaElement).value; }}></textarea>
        </label>

        ${this.formPayloadKind === 'agentTurn' ? html`
          <div class="form-grid" style="margin-top: 12px;">
            <label class="field">
              <span>Delivery</span>
              <select .value=${this.formDeliveryMode}
                @change=${(e: Event) => { this.formDeliveryMode = (e.target as HTMLSelectElement).value as CronDeliveryMode; }}>
                <option value="announce">Announce summary (default)</option>
                <option value="none">None (internal)</option>
              </select>
            </label>
            <label class="field">
              <span>Timeout (seconds)</span>
              <input .value=${this.formTimeoutSeconds}
                @input=${(e: Event) => { this.formTimeoutSeconds = (e.target as HTMLInputElement).value; }} />
            </label>
            ${this.formDeliveryMode === 'announce' ? html`
              <label class="field">
                <span>Channel</span>
                <select .value=${this.formDeliveryChannel}
                  @change=${(e: Event) => { this.formDeliveryChannel = (e.target as HTMLSelectElement).value; }}>
                  ${this.channelOptions.map((ch) => html`<option value=${ch}>${ch}</option>`)}
                </select>
              </label>
              <label class="field">
                <span>To</span>
                <input .value=${this.formDeliveryTo} placeholder="+1555… or chat id"
                  @input=${(e: Event) => { this.formDeliveryTo = (e.target as HTMLInputElement).value; }} />
              </label>
            ` : nothing}
          </div>
        ` : nothing}

        <div class="row" style="margin-top: 14px;">
          <button class="btn primary" ?disabled=${this.busy} @click=${() => this.addJob()}>
            ${this.busy ? 'Saving…' : 'Add job'}
          </button>
        </div>
      </div>
    `;
  }

  private renderScheduleFields() {
    if (this.formScheduleKind === 'at') {
      return html`
        <label class="field" style="margin-top: 12px;">
          <span>Run at</span>
          <input type="datetime-local" .value=${this.formScheduleAt}
            @input=${(e: Event) => { this.formScheduleAt = (e.target as HTMLInputElement).value; }} />
        </label>
      `;
    }
    if (this.formScheduleKind === 'every') {
      return html`
        <div class="form-grid" style="margin-top: 12px;">
          <label class="field">
            <span>Every</span>
            <input .value=${this.formEveryAmount}
              @input=${(e: Event) => { this.formEveryAmount = (e.target as HTMLInputElement).value; }} />
          </label>
          <label class="field">
            <span>Unit</span>
            <select .value=${this.formEveryUnit}
              @change=${(e: Event) => { this.formEveryUnit = (e.target as HTMLSelectElement).value; }}>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </select>
          </label>
        </div>
      `;
    }
    return html`
      <div class="form-grid" style="margin-top: 12px;">
        <label class="field">
          <span>Expression</span>
          <input .value=${this.formCronExpr}
            @input=${(e: Event) => { this.formCronExpr = (e.target as HTMLInputElement).value; }} />
        </label>
        <label class="field">
          <span>Timezone (optional)</span>
          <input .value=${this.formCronTz}
            @input=${(e: Event) => { this.formCronTz = (e.target as HTMLInputElement).value; }} />
        </label>
      </div>
    `;
  }

  /* -- jobs list -- */
  private renderJobsList() {
    return html`
      <section class="card" style="margin-top: 18px;">
        <div class="card-title">Jobs</div>
        <div class="card-sub">All scheduled jobs stored in the gateway.</div>
        ${this.jobs.length === 0
          ? html`<div class="muted" style="margin-top: 12px">No jobs yet.</div>`
          : html`
            <div class="list" style="margin-top: 12px;">
              ${this.jobs.map((job) => this.renderJob(job))}
            </div>
          `}
      </section>
    `;
  }

  private renderJob(job: CronJob) {
    const isSelected = this.runsJobId === job.id;
    const itemClass = `list-item list-item-clickable${isSelected ? ' list-item-selected' : ''}`;
    return html`
      <div class=${itemClass} @click=${() => this.loadRuns(job.id)}>
        <div class="list-main">
          <div class="list-title">${job.name}</div>
          <div class="list-sub">${formatCronSchedule(job)}</div>
          <div class="muted">${formatCronPayload(job)}</div>
          ${job.agentId ? html`<div class="muted">Agent: ${job.agentId}</div>` : nothing}
          <div class="chip-row" style="margin-top: 6px;">
            <span class="chip">${job.enabled ? 'enabled' : 'disabled'}</span>
            <span class="chip">${job.sessionTarget}</span>
            <span class="chip">${job.wakeMode}</span>
          </div>
        </div>
        <div class="list-meta">
          <div>${formatCronState(job)}</div>
          <div class="row" style="justify-content: flex-end; margin-top: 8px;">
            <button class="btn" ?disabled=${this.busy}
              @click=${(ev: Event) => { ev.stopPropagation(); this.toggleJob(job, !job.enabled); }}>
              ${job.enabled ? 'Disable' : 'Enable'}
            </button>
            <button class="btn" ?disabled=${this.busy}
              @click=${(ev: Event) => { ev.stopPropagation(); this.runJob(job); }}>
              Run
            </button>
            <button class="btn" ?disabled=${this.busy}
              @click=${(ev: Event) => { ev.stopPropagation(); this.loadRuns(job.id); }}>
              Runs
            </button>
            <button class="btn danger" ?disabled=${this.busy}
              @click=${(ev: Event) => { ev.stopPropagation(); this.removeJob(job); }}>
              Remove
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /* -- run history -- */
  private renderRunHistory() {
    return html`
      <section class="card" style="margin-top: 18px;">
        <div class="card-title">Run history</div>
        <div class="card-sub">Latest runs for ${this.runsJobId ?? '(select a job)'}.</div>
        ${this.runsJobId == null
          ? html`<div class="muted" style="margin-top: 12px">Select a job to inspect run history.</div>`
          : this.runs.length === 0
            ? html`<div class="muted" style="margin-top: 12px">No runs yet.</div>`
            : html`
              <div class="list" style="margin-top: 12px;">
                ${this.runs.map((entry) => html`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${entry.status ?? 'unknown'}</div>
                      <div class="list-sub">${entry.summary ?? ''}</div>
                    </div>
                    <div class="list-meta">
                      <div>${formatMs(entry.ts)}</div>
                      <div class="muted">${entry.durationMs != null ? formatDurationMs(entry.durationMs) : '0ms'}</div>
                      ${entry.error ? html`<div class="muted">${entry.error}</div>` : nothing}
                    </div>
                  </div>
                `)}
              </div>
            `}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-cron': OpenRappterCron;
  }
}
