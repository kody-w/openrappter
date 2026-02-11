/**
 * Presence / Health View Component
 * Gateway status, health checks, and connected instances.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import type { GatewayStatus, HealthResponse } from '../types.js';

@customElement('openrappter-presence')
export class OpenRappterPresence extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem 2rem;
    }

    .page-header { margin-bottom: 1.25rem; }
    .page-header h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
    .page-header p { font-size: 0.875rem; color: var(--text-secondary); }

    .overall-banner {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem 1.25rem;
      border-radius: 0.5rem;
      margin-bottom: 1.25rem;
    }

    .overall-banner.ok {
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .overall-banner.degraded {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .overall-banner.error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .overall-icon { font-size: 2rem; }

    .overall-text h3 {
      font-size: 1.125rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    .overall-banner.ok .overall-text h3 { color: var(--accent); }
    .overall-banner.degraded .overall-text h3 { color: var(--warning); }
    .overall-banner.error .overall-text h3 { color: var(--error); }

    .overall-text p {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      margin-top: 0.125rem;
    }

    .cards-row {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    .card-title {
      font-weight: 600;
      font-size: 1rem;
    }

    .btn {
      padding: 0.375rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 0.75rem;
      cursor: pointer;
    }

    .btn:hover { background: var(--border); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }

    .stat-item {
      padding: 0.75rem;
      background: var(--bg-primary);
      border-radius: 0.375rem;
    }

    .stat-label {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    .stat-value {
      font-size: 1.25rem;
      font-weight: 700;
      font-family: 'SF Mono', monospace;
    }

    .checks-list {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }

    .check-item {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0.5rem 0.625rem;
      background: var(--bg-primary);
      border-radius: 0.375rem;
      font-size: 0.875rem;
    }

    .check-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .check-dot.ok { background: var(--accent); }
    .check-dot.error { background: var(--error); }
    .check-dot.unknown { background: var(--text-secondary); }

    .check-name { flex: 1; text-transform: capitalize; }
    .check-status { font-size: 0.75rem; color: var(--text-secondary); }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }
  `;

  @state() private status: GatewayStatus | null = null;
  @state() private health: HealthResponse | null = null;
  @state() private loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  private async refresh() {
    this.loading = true;
    try {
      const [s, h] = await Promise.allSettled([
        gateway.call<GatewayStatus>('status'),
        gateway.call<HealthResponse>('health'),
      ]);
      this.status = s.status === 'fulfilled' ? s.value : null;
      this.health = h.status === 'fulfilled' ? h.value : null;
    } catch { /* ignore */ }
    this.loading = false;
  }

  private formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  render() {
    if (this.loading) return html`<div class="empty-state">Loading system status…</div>`;

    const overallStatus = this.health?.status ?? 'ok';
    const statusIcons: Record<string, string> = { ok: '✅', degraded: '⚠️', error: '❌' };

    return html`
      <div class="page-header">
        <h2>System Health</h2>
        <p>Gateway status, health checks, and diagnostics.</p>
      </div>

      ${this.health
        ? html`
            <div class="overall-banner ${overallStatus}">
              <span class="overall-icon">${statusIcons[overallStatus] ?? '❓'}</span>
              <div class="overall-text">
                <h3>${overallStatus}</h3>
                <p>Last checked ${new Date(this.health.timestamp).toLocaleTimeString()}</p>
              </div>
            </div>
          `
        : nothing}

      <div class="cards-row">
        ${this.status
          ? html`
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Gateway Status</span>
                  <button class="btn" ?disabled=${this.loading} @click=${() => this.refresh()}>
                    Refresh
                  </button>
                </div>
                <div class="stat-grid">
                  <div class="stat-item">
                    <div class="stat-label">Port</div>
                    <div class="stat-value">${this.status.port}</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-label">Connections</div>
                    <div class="stat-value">${this.status.connections}</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-label">Uptime</div>
                    <div class="stat-value">${this.formatUptime(this.status.uptime)}</div>
                  </div>
                  <div class="stat-item">
                    <div class="stat-label">Version</div>
                    <div class="stat-value">${this.status.version ?? '1.2.0'}</div>
                  </div>
                </div>
              </div>
            `
          : nothing}

        ${this.health
          ? html`
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Health Checks</span>
                </div>
                <div class="checks-list">
                  ${Object.entries(this.health.checks).map(
                    ([name, ok]) => html`
                      <div class="check-item">
                        <span class="check-dot ${ok === true ? 'ok' : ok === false ? 'error' : 'unknown'}"></span>
                        <span class="check-name">${name}</span>
                        <span class="check-status">${ok === true ? 'Pass' : ok === false ? 'Fail' : 'Unknown'}</span>
                      </div>
                    `,
                  )}
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-presence': OpenRappterPresence;
  }
}
