/**
 * Devices View Component
 * Connected clients and device management with chip badges.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import type { ConnectionInfo } from '../types.js';

@customElement('openrappter-devices')
export class OpenRappterDevices extends LitElement {
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
      align-items: center;
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

    .count-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.625rem;
      border-radius: 1rem;
      background: var(--accent);
      color: white;
      font-weight: 600;
    }

    .devices-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-width: 720px;
    }

    .device-card {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem 1.25rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
    }

    .device-main { flex: 1; }

    .device-title {
      font-weight: 600;
      font-size: 0.9375rem;
      margin-bottom: 0.25rem;
    }

    .device-sub {
      font-size: 0.8125rem;
      color: var(--text-secondary);
    }

    .chip-row {
      display: flex;
      gap: 0.375rem;
      flex-wrap: wrap;
      margin-top: 0.5rem;
    }

    .chip {
      font-size: 0.6875rem;
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .chip.auth {
      background: rgba(16, 185, 129, 0.2);
      color: var(--accent);
    }

    .chip.unauth {
      background: rgba(239, 68, 68, 0.2);
      color: var(--error);
    }

    .device-meta {
      text-align: right;
      font-size: 0.75rem;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }
  `;

  @state() private devices: ConnectionInfo[] = [];
  @state() private loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.loadDevices();
    gateway.on('presence', () => this.loadDevices());
  }

  private async loadDevices() {
    this.loading = true;
    try {
      this.devices = await gateway.call<ConnectionInfo[]>('connections.list');
    } catch {
      this.devices = [];
    }
    this.loading = false;
  }

  private formatAgo(ts: string): string {
    const diff = Date.now() - new Date(ts).getTime();
    const sec = Math.round(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    return `${hr}h ago`;
  }

  render() {
    if (this.loading) return html`<div class="empty-state">Loading devices…</div>`;

    return html`
      <div class="page-header">
        <h2>Connected Devices</h2>
        <p>Active WebSocket connections to the gateway.</p>
      </div>

      <div class="toolbar">
        <span class="count-badge">${this.devices.length} connected</span>
        <button class="btn" @click=${() => this.loadDevices()}>Refresh</button>
      </div>

      ${this.devices.length === 0
        ? html`<div class="empty-state"><p>No devices connected.</p></div>`
        : html`
            <div class="devices-list">
              ${this.devices.map(
                (d) => html`
                  <div class="device-card">
                    <div class="device-main">
                      <div class="device-title">${d.deviceId ?? d.id}</div>
                      <div class="device-sub">${d.deviceType ?? 'WebSocket client'}</div>
                      <div class="chip-row">
                        <span class="chip ${d.authenticated ? 'auth' : 'unauth'}">
                          ${d.authenticated ? '✓ Authenticated' : '✗ Unauthenticated'}
                        </span>
                        ${d.metadata?.platform
                          ? html`<span class="chip">${d.metadata.platform}</span>`
                          : nothing}
                        ${d.metadata?.mode
                          ? html`<span class="chip">${d.metadata.mode}</span>`
                          : nothing}
                        ${d.metadata?.version
                          ? html`<span class="chip">v${d.metadata.version}</span>`
                          : nothing}
                      </div>
                    </div>
                    <div class="device-meta">
                      <div>Connected</div>
                      <div>${this.formatAgo(d.connectedAt)}</div>
                    </div>
                  </div>
                `,
              )}
            </div>
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-devices': OpenRappterDevices;
  }
}
