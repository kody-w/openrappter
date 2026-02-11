/**
 * Devices View Component
 * Manage connected devices and pairing
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import type { ConnectionInfo } from '../types.js';

@customElement('openrappter-devices')
export class OpenRappterDevices extends LitElement {
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
    .header h2 { font-size: 1.125rem; font-weight: 600; }
    button {
      padding: 0.5rem 1rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      cursor: pointer;
    }
    button:hover { background: var(--accent-hover); }
    button.danger { background: var(--error); }
    .devices-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
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
    .device-icon { font-size: 1.5rem; }
    .device-info { flex: 1; }
    .device-name { font-weight: 600; }
    .device-meta {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }
    .status-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-weight: 500;
    }
    .status-badge.authenticated {
      background: rgba(16, 185, 129, 0.2);
      color: var(--accent);
    }
    .status-badge.unauthenticated {
      background: rgba(239, 68, 68, 0.2);
      color: var(--error);
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

  render() {
    if (this.loading) return html`<div>Loading devices...</div>`;

    return html`
      <div class="header">
        <h2>Connected Devices</h2>
        <button @click=${this.loadDevices}>Refresh</button>
      </div>
      ${this.devices.length === 0
        ? html`<div class="empty-state"><p>No devices connected.</p></div>`
        : html`
            <div class="devices-list">
              ${this.devices.map(
                (d) => html`
                  <div class="device-card">
                    <span class="device-icon">💻</span>
                    <div class="device-info">
                      <div class="device-name">${d.deviceId ?? d.id}</div>
                      <div class="device-meta">
                        ${d.deviceType ?? 'Unknown'} •
                        Connected ${new Date(d.connectedAt).toLocaleString()}
                      </div>
                    </div>
                    <span class="status-badge ${d.authenticated ? 'authenticated' : 'unauthenticated'}">
                      ${d.authenticated ? 'Authenticated' : 'Unauthenticated'}
                    </span>
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
