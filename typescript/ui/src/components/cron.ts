/**
 * Cron Jobs View Component
 * Manage scheduled tasks
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
}

@customElement('openrappter-cron')
export class OpenRappterCron extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
    }

    .header h2 {
      font-size: 1.125rem;
      font-weight: 600;
    }

    .header-actions {
      display: flex;
      gap: 0.5rem;
    }

    button {
      padding: 0.5rem 1rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      cursor: pointer;
    }

    button:hover {
      background: var(--accent-hover);
    }

    button.secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .jobs-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
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

    .job-toggle {
      width: 44px;
      height: 24px;
      background: var(--bg-tertiary);
      border-radius: 12px;
      position: relative;
      cursor: pointer;
      transition: background 0.2s ease;
    }

    .job-toggle.enabled {
      background: var(--accent);
    }

    .job-toggle::after {
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

    .job-toggle.enabled::after {
      transform: translateX(20px);
    }

    .job-info {
      flex: 1;
    }

    .job-name {
      font-weight: 600;
      margin-bottom: 0.25rem;
    }

    .job-schedule {
      font-family: monospace;
      font-size: 0.875rem;
      color: var(--text-secondary);
    }

    .job-status {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      text-transform: uppercase;
      font-weight: 500;
    }

    .job-status.enabled {
      background: rgba(16, 185, 129, 0.2);
      color: var(--accent);
    }

    .job-status.disabled {
      background: rgba(239, 68, 68, 0.2);
      color: var(--error);
    }

    .job-actions {
      display: flex;
      gap: 0.5rem;
    }

    .job-actions button {
      padding: 0.375rem 0.75rem;
      font-size: 0.8125rem;
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }
  `;

  @state()
  private jobs: CronJob[] = [];

  @state()
  private loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.loadJobs();
  }

  private async loadJobs() {
    this.loading = true;
    try {
      this.jobs = await gateway.call<CronJob[]>('cron.list');
    } catch (error) {
      console.error('Failed to load cron jobs:', error);
      this.jobs = [];
    }
    this.loading = false;
  }

  private async toggleJob(job: CronJob) {
    try {
      await gateway.call('cron.enable', { jobId: job.id, enabled: !job.enabled });
      this.jobs = this.jobs.map((j) =>
        j.id === job.id ? { ...j, enabled: !j.enabled } : j
      );
    } catch (error) {
      console.error('Failed to toggle job:', error);
    }
  }

  private async runJob(job: CronJob) {
    try {
      await gateway.call('cron.run', { jobId: job.id });
      alert(`Job "${job.name}" triggered successfully`);
    } catch (error) {
      console.error('Failed to run job:', error);
      alert(`Failed to run job: ${(error as Error).message}`);
    }
  }

  render() {
    if (this.loading) {
      return html`<div class="loading">Loading cron jobs...</div>`;
    }

    return html`
      <div class="header">
        <h2>Cron Jobs</h2>
        <div class="header-actions">
          <button class="secondary" @click=${this.loadJobs}>Refresh</button>
          <button>Add Job</button>
        </div>
      </div>

      ${this.jobs.length === 0
        ? html`
            <div class="empty-state">
              <p>No cron jobs configured.</p>
              <p>Add scheduled tasks in your configuration file.</p>
            </div>
          `
        : html`
            <div class="jobs-list">
              ${this.jobs.map(
                (job) => html`
                  <div class="job-card">
                    <div
                      class="job-toggle ${job.enabled ? 'enabled' : ''}"
                      @click=${() => this.toggleJob(job)}
                    ></div>
                    <div class="job-info">
                      <div class="job-name">${job.name}</div>
                      <div class="job-schedule">${job.schedule}</div>
                    </div>
                    <span class="job-status ${job.enabled ? 'enabled' : 'disabled'}">
                      ${job.enabled ? 'Active' : 'Disabled'}
                    </span>
                    <div class="job-actions">
                      <button class="secondary" @click=${() => this.runJob(job)}>Run Now</button>
                      <button class="secondary">Edit</button>
                    </div>
                  </div>
                `
              )}
            </div>
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-cron': OpenRappterCron;
  }
}
