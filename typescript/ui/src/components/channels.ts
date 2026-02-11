/**
 * Channels View Component
 * Displays connected channels and their status
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface Channel {
  id: string;
  type: string;
  connected: boolean;
  lastActivity?: string;
  metadata?: Record<string, unknown>;
}

@customElement('openrappter-channels')
export class OpenRappterChannels extends LitElement {
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

    button {
      padding: 0.5rem 1rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    button:hover {
      background: var(--accent-hover);
    }

    .channels-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }

    .channel-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
    }

    .channel-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }

    .channel-icon {
      font-size: 1.5rem;
    }

    .channel-info {
      flex: 1;
    }

    .channel-name {
      font-weight: 600;
      font-size: 1rem;
    }

    .channel-type {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
    }

    .channel-status {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.875rem;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .status-dot.connected {
      background: var(--accent);
    }

    .status-dot.disconnected {
      background: var(--error);
    }

    .channel-details {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }

    .channel-detail {
      display: flex;
      justify-content: space-between;
      margin-bottom: 0.375rem;
    }

    .channel-actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 1rem;
    }

    .channel-actions button {
      flex: 1;
      padding: 0.5rem;
      font-size: 0.8125rem;
    }

    .channel-actions button.secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }

    .loading {
      display: flex;
      justify-content: center;
      padding: 2rem;
    }
  `;

  @state()
  private channels: Channel[] = [];

  @state()
  private loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.loadChannels();
  }

  private async loadChannels() {
    this.loading = true;
    try {
      this.channels = await gateway.call<Channel[]>('channels.list');
    } catch (error) {
      console.error('Failed to load channels:', error);
      this.channels = [];
    }
    this.loading = false;
  }

  private getChannelIcon(type: string): string {
    const icons: Record<string, string> = {
      discord: '🎮',
      slack: '💼',
      telegram: '✈️',
      whatsapp: '📱',
      signal: '🔐',
      imessage: '💬',
      matrix: '🔷',
      teams: '👥',
      googlechat: '💬',
      cli: '⌨️',
    };
    return icons[type] ?? '📡';
  }

  private formatTime(timestamp?: string): string {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleString();
  }

  render() {
    if (this.loading) {
      return html`
        <div class="loading">
          <span>Loading channels...</span>
        </div>
      `;
    }

    return html`
      <div class="header">
        <h2>Connected Channels</h2>
        <button @click=${this.loadChannels}>Refresh</button>
      </div>

      ${this.channels.length === 0
        ? html`
            <div class="empty-state">
              <p>No channels configured.</p>
              <p>Add channels in your configuration file.</p>
            </div>
          `
        : html`
            <div class="channels-grid">
              ${this.channels.map(
                (channel) => html`
                  <div class="channel-card">
                    <div class="channel-header">
                      <span class="channel-icon">${this.getChannelIcon(channel.type)}</span>
                      <div class="channel-info">
                        <div class="channel-name">${channel.id}</div>
                        <div class="channel-type">${channel.type}</div>
                      </div>
                      <div class="channel-status">
                        <span class="status-dot ${channel.connected ? 'connected' : 'disconnected'}"></span>
                        ${channel.connected ? 'Connected' : 'Disconnected'}
                      </div>
                    </div>

                    <div class="channel-details">
                      <div class="channel-detail">
                        <span>Last Activity</span>
                        <span>${this.formatTime(channel.lastActivity)}</span>
                      </div>
                    </div>

                    <div class="channel-actions">
                      <button class="secondary">Configure</button>
                      <button>${channel.connected ? 'Disconnect' : 'Connect'}</button>
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
    'openrappter-channels': OpenRappterChannels;
  }
}
