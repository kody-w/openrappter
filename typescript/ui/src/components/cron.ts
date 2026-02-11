/**
 * Cron Jobs View Component
 * Manage scheduled tasks with create form and run history.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRun?: string;
  lastStatus?: 'success' | 'error' | 'running';
  nextRun?: string;
}

type ScheduleMode = 'every' | 'at' | 'cron';

@customElement('openrappter-cron')
export class OpenRappterCron extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem 2rem;
    }

    .page-header { margin-bottom: 1.25rem; }
    .page-header h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
    .page-header p { font-size: 0.875rem; color: var(--text-secondary); }

    .toolbar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.25rem;
    }

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

    .create-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }

    .create-card h3 {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }

    .form-row {
      display: flex;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
      align-items: flex-end;
    }

    .form-field {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      flex: 1;
    }

    .form-field label {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .form-field input,
    .form-field select {
      padding: 0.5rem 0.625rem;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.8125rem;
    }

    .form-field input:focus,
    .form-field select:focus {
      outline: none;
      border-color: var(--accent);
    }

    .schedule-tabs {
      display: flex;
      gap: 0;
      margin-bottom: 0.75rem;
    }

    .schedule-tab {
      padding: 0.375rem 0.75rem;
      border: 1px solid var(--border);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      font-size: 0.75rem;
      cursor: pointer;
    }

    .schedule-tab:first-child { border-radius: 0.375rem 0 0 0.375rem; }
    .schedule-tab:last-child { border-radius: 0 0.375rem 0.375rem 0; }
    .schedule-tab.active { background: var(--accent); color: white; border-color: var(--accent); }

    .jobs-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-width: 720px;
    }

    .job-card {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem 1.25rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
    }

    .toggle-switch {
      width: 44px;
      height: 24px;
      background: var(--bg-tertiary);
      border-radius: 12px;
      position: relative;
      cursor: pointer;
      transition: background 0.2s ease;
      flex-shrink: 0;
    }

    .toggle-switch.enabled { background: var(--accent); }

    .toggle-switch::after {
      content: '';
      position: absolute;
      width: 20px;
      height: 20px;
      background: white;
      border-radius: 50%;
      top: 2px;
      left: 2px;
      transition: transform 0.2s ease;
    }

    .toggle-switch.enabled::after { transform: translateX(20px); }

    .job-info { flex: 1; }
    .job-name { font-weight: 600; margin-bottom: 0.25rem; }

    .job-schedule {
      font-family: 'SF Mono', monospace;
      font-size: 0.8125rem;
      color: var(--text-secondary);
    }

    .job-meta {
      text-align: right;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 0.375rem;
    }

    .status-dot.success { background: var(--accent); }
    .status-dot.error { background: var(--error); }
    .status-dot.running { background: var(--warning); }

    .job-actions {
      display: flex;
      gap: 0.375rem;
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }
  `;

  @state() private jobs: CronJob[] = [];
  @state() private loading = true;
  @state() private showCreate = false;
  @state() private newName = '';
  @state() private newSchedule = '';
  @state() private scheduleMode: ScheduleMode = 'every';
  @state() private everyValue = '5';
  @state() private everyUnit = 'minutes';
  @state() private atTime = '09:00';

  connectedCallback() {
    super.connectedCallback();
    this.loadJobs();
  }

  private async loadJobs() {
    this.loading = true;
    try {
      this.jobs = await gateway.call<CronJob[]>('cron.list');
    } catch {
      this.jobs = [];
    }
    this.loading = false;
  }

  private async toggleJob(job: CronJob) {
    try {
      await gateway.call('cron.enable', { jobId: job.id, enabled: !job.enabled });
      this.jobs = this.jobs.map((j) =>
        j.id === job.id ? { ...j, enabled: !j.enabled } : j,
      );
    } catch (e) {
      console.error('Failed to toggle job:', e);
    }
  }

  private async runJob(job: CronJob) {
    try {
      await gateway.call('cron.run', { jobId: job.id });
      this.jobs = this.jobs.map((j) =>
        j.id === job.id ? { ...j, lastStatus: 'running' as const } : j,
      );
    } catch (e) {
      console.error('Failed to run job:', e);
    }
  }

  private getComputedSchedule(): string {
    if (this.scheduleMode === 'cron') return this.newSchedule;
    if (this.scheduleMode === 'every') {
      const map: Record<string, string> = {
        minutes: `*/${this.everyValue} * * * *`,
        hours: `0 */${this.everyValue} * * *`,
        days: `0 0 */${this.everyValue} * *`,
      };
      return map[this.everyUnit] ?? `*/${this.everyValue} * * * *`;
    }
    const [h, m] = this.atTime.split(':');
    return `${m} ${h} * * *`;
  }

  private async createJob() {
    if (!this.newName.trim()) return;
    try {
      await gateway.call('cron.add', {
        name: this.newName,
        schedule: this.getComputedSchedule(),
      });
      this.showCreate = false;
      this.newName = '';
      this.newSchedule = '';
      await this.loadJobs();
    } catch (e) {
      console.error('Failed to create job:', e);
    }
  }

  private formatAgo(ts?: string): string {
    if (!ts) return 'Never';
    const diff = Date.now() - new Date(ts).getTime();
    const sec = Math.round(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    return `${Math.round(min / 60)}h ago`;
  }

  render() {
    if (this.loading) return html`<div class="empty-state">Loading cron jobs…</div>`;

    return html`
      <div class="page-header">
        <h2>Cron Jobs</h2>
        <p>Scheduled tasks and automation.</p>
      </div>

      <div class="toolbar">
        <button class="btn" @click=${() => this.loadJobs()}>Refresh</button>
        <button class="btn primary" @click=${() => { this.showCreate = !this.showCreate; }}>
          ${this.showCreate ? 'Cancel' : '+ Add Job'}
        </button>
      </div>

      ${this.showCreate ? this.renderCreateForm() : nothing}

      ${this.jobs.length === 0
        ? html`<div class="empty-state">
            <p>No cron jobs configured.</p>
            <p>Click "Add Job" to create a scheduled task.</p>
          </div>`
        : html`
            <div class="jobs-list">
              ${this.jobs.map((job) => html`
                <div class="job-card">
                  <div
                    class="toggle-switch ${job.enabled ? 'enabled' : ''}"
                    @click=${() => this.toggleJob(job)}
                  ></div>
                  <div class="job-info">
                    <div class="job-name">${job.name}</div>
                    <div class="job-schedule">${job.schedule}</div>
                  </div>
                  <div class="job-meta">
                    ${job.lastStatus
                      ? html`<div><span class="status-dot ${job.lastStatus}"></span>${job.lastStatus}</div>`
                      : nothing}
                    <div>Last: ${this.formatAgo(job.lastRun)}</div>
                    ${job.nextRun ? html`<div>Next: ${this.formatAgo(job.nextRun)}</div>` : nothing}
                  </div>
                  <div class="job-actions">
                    <button class="btn" @click=${() => this.runJob(job)}>Run</button>
                  </div>
                </div>
              `)}
            </div>
          `}
    `;
  }

  private renderCreateForm() {
    return html`
      <div class="create-card">
        <h3>New Cron Job</h3>

        <div class="form-row">
          <div class="form-field">
            <label>Job Name</label>
            <input
              type="text"
              placeholder="e.g. daily-backup"
              .value=${this.newName}
              @input=${(e: Event) => { this.newName = (e.target as HTMLInputElement).value; }}
            />
          </div>
        </div>

        <div class="schedule-tabs">
          ${(['every', 'at', 'cron'] as ScheduleMode[]).map(
            (m) => html`
              <div
                class="schedule-tab ${this.scheduleMode === m ? 'active' : ''}"
                @click=${() => { this.scheduleMode = m; }}
              >
                ${m === 'every' ? 'Every X' : m === 'at' ? 'At Time' : 'Cron'}
              </div>
            `,
          )}
        </div>

        ${this.scheduleMode === 'every'
          ? html`
              <div class="form-row">
                <div class="form-field">
                  <label>Interval</label>
                  <input
                    type="number"
                    min="1"
                    .value=${this.everyValue}
                    @input=${(e: Event) => { this.everyValue = (e.target as HTMLInputElement).value; }}
                  />
                </div>
                <div class="form-field">
                  <label>Unit</label>
                  <select
                    .value=${this.everyUnit}
                    @change=${(e: Event) => { this.everyUnit = (e.target as HTMLSelectElement).value; }}
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                </div>
              </div>
            `
          : this.scheduleMode === 'at'
            ? html`
                <div class="form-row">
                  <div class="form-field">
                    <label>Time (daily)</label>
                    <input
                      type="time"
                      .value=${this.atTime}
                      @input=${(e: Event) => { this.atTime = (e.target as HTMLInputElement).value; }}
                    />
                  </div>
                </div>
              `
            : html`
                <div class="form-row">
                  <div class="form-field">
                    <label>Cron Expression</label>
                    <input
                      type="text"
                      placeholder="*/5 * * * *"
                      .value=${this.newSchedule}
                      @input=${(e: Event) => { this.newSchedule = (e.target as HTMLInputElement).value; }}
                    />
                  </div>
                </div>
              `}

        <div class="form-row">
          <div class="job-schedule" style="flex:1; padding: 0.5rem 0;">
            Preview: <code>${this.getComputedSchedule()}</code>
          </div>
          <button class="btn primary" @click=${() => this.createJob()} ?disabled=${!this.newName.trim()}>
            Create
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-cron': OpenRappterCron;
  }
}
