/**
 * Channels View Component
 * Manage and monitor channel connections (Telegram, Discord, WhatsApp).
 * Inspired by OpenClaw's channels UI with per-channel cards and status fields.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface ChannelStatus {
  id: string;
  type: string;
  connected: boolean;
  configured?: boolean;
  running?: boolean;
  lastActivity?: string;
  lastConnectedAt?: string;
  lastMessageAt?: string;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

interface ChannelDefinition {
  type: string;
  label: string;
  icon: string;
  description: string;
  envVars: string[];
}

const SUPPORTED_CHANNELS: ChannelDefinition[] = [
  {
    type: 'telegram',
    label: 'Telegram',
    icon: '✈️',
    description: 'Bot API with polling or webhook mode.',
    envVars: ['TELEGRAM_BOT_TOKEN'],
  },
  {
    type: 'discord',
    label: 'Discord',
    icon: '🎮',
    description: 'Bot via Gateway WebSocket and REST API.',
    envVars: ['DISCORD_TOKEN'],
  },
  {
    type: 'whatsapp',
    label: 'WhatsApp',
    icon: '📱',
    description: 'WhatsApp Web via Baileys with QR auth.',
    envVars: ['WHATSAPP_ENABLED'],
  },
];

@customElement('openrappter-channels')
export class OpenRappterChannels extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem 2rem;
    }

    .page-header {
      margin-bottom: 1.5rem;
    }

    .page-header h2 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    }

    .page-header p {
      font-size: 0.875rem;
      color: var(--text-secondary);
    }

    .channels-list {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      max-width: 720px;
    }

    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.5rem;
    }

    .card-title {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    }

    .card-sub {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      margin-bottom: 1rem;
    }

    .status-list {
      display: flex;
      flex-direction: column;
    }

    .status-list > div {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.875rem;
    }

    .status-list > div:last-child {
      border-bottom: none;
    }

    .label {
      color: var(--text-secondary);
    }

    .callout {
      padding: 0.625rem 0.75rem;
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      background: var(--bg-tertiary);
      margin-top: 0.75rem;
    }

    .callout.danger {
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
    }

    .callout.success {
      background: rgba(16, 185, 129, 0.15);
      color: #6ee7b7;
    }

    .row {
      display: flex;
      gap: 0.5rem;
      margin-top: 1rem;
      flex-wrap: wrap;
    }

    .btn {
      padding: 0.5rem 1rem;
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 0.8125rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn:hover {
      background: var(--border);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .btn.primary:hover {
      background: var(--accent-hover);
    }

    .btn.danger {
      background: transparent;
      border-color: var(--error);
      color: var(--error);
    }

    .btn.danger:hover {
      background: rgba(239, 68, 68, 0.15);
    }

    .env-hint {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-top: 0.75rem;
      padding: 0.5rem 0.75rem;
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }

    .loading {
      display: flex;
      justify-content: center;
      padding: 2rem;
      color: var(--text-secondary);
    }

    .config-section {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    }

    .config-section summary {
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-secondary);
      user-select: none;
    }

    .config-section summary:hover {
      color: var(--text-primary);
    }

    .config-fields {
      margin-top: 0.75rem;
    }

    .config-field {
      margin-bottom: 0.625rem;
    }

    .config-field label {
      display: block;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    .config-field input {
      width: 100%;
      padding: 0.5rem 0.625rem;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.8125rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }

    .config-field input:focus {
      outline: none;
      border-color: var(--accent);
    }

    .allow-list {
      margin-top: 0.5rem;
    }

    .allow-list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.8125rem;
      color: var(--text-secondary);
    }

    .allow-list-items {
      margin-top: 0.375rem;
    }

    .allow-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.25rem 0.5rem;
      background: var(--bg-primary);
      border-radius: 0.25rem;
      font-size: 0.8125rem;
      margin-bottom: 0.25rem;
    }

    .remove-btn {
      background: none;
      border: none;
      color: var(--error);
      cursor: pointer;
      font-size: 0.75rem;
      padding: 0.125rem 0.375rem;
    }
  `;

  @state()
  private channelStatuses: Map<string, ChannelStatus> = new Map();

  @state()
  private loading = true;

  @state()
  private actionBusy: Map<string, boolean> = new Map();

  @state()
  private configForms: Map<string, Record<string, string>> = new Map();

  connectedCallback() {
    super.connectedCallback();
    this.loadChannels();

    gateway.on('channel.status', (data) => {
      const status = data as ChannelStatus;
      if (status?.type) {
        this.channelStatuses = new Map(this.channelStatuses);
        this.channelStatuses.set(status.type, status);
        this.requestUpdate();
      }
    });
  }

  private async loadChannels() {
    this.loading = true;
    try {
      const list = await gateway.call<ChannelStatus[]>('channels.list');
      const map = new Map<string, ChannelStatus>();
      for (const ch of list ?? []) {
        map.set(ch.type, ch);
      }
      this.channelStatuses = map;
    } catch {
      this.channelStatuses = new Map();
    }
    this.loading = false;
  }

  private async connectChannel(type: string) {
    this.actionBusy = new Map(this.actionBusy);
    this.actionBusy.set(type, true);
    this.requestUpdate();
    try {
      await gateway.call('channels.connect', { type });
      await this.loadChannels();
    } catch (e) {
      console.error(`Failed to connect ${type}:`, e);
    }
    this.actionBusy.set(type, false);
    this.requestUpdate();
  }

  private async disconnectChannel(type: string) {
    this.actionBusy = new Map(this.actionBusy);
    this.actionBusy.set(type, true);
    this.requestUpdate();
    try {
      await gateway.call('channels.disconnect', { type });
      await this.loadChannels();
    } catch (e) {
      console.error(`Failed to disconnect ${type}:`, e);
    }
    this.actionBusy.set(type, false);
    this.requestUpdate();
  }

  private async probeChannel(type: string) {
    this.actionBusy = new Map(this.actionBusy);
    this.actionBusy.set(type, true);
    this.requestUpdate();
    try {
      await gateway.call('channels.probe', { type });
      await this.loadChannels();
    } catch (e) {
      console.error(`Failed to probe ${type}:`, e);
    }
    this.actionBusy.set(type, false);
    this.requestUpdate();
  }

  private formatAgo(ts?: string): string {
    if (!ts) return 'n/a';
    const diff = Date.now() - new Date(ts).getTime();
    const sec = Math.round(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    return `${hr}h ago`;
  }

  private renderChannelCard(def: ChannelDefinition) {
    const status = this.channelStatuses.get(def.type);
    const busy = this.actionBusy.get(def.type) ?? false;
    const configured = status?.configured ?? false;
    const running = status?.running ?? false;
    const connected = status?.connected ?? false;

    return html`
      <div class="card">
        <div class="card-title">${def.icon} ${def.label}</div>
        <div class="card-sub">${def.description}</div>

        <div class="status-list">
          <div>
            <span class="label">Configured</span>
            <span>${configured ? 'Yes' : 'No'}</span>
          </div>
          <div>
            <span class="label">Running</span>
            <span>${running ? 'Yes' : 'No'}</span>
          </div>
          <div>
            <span class="label">Connected</span>
            <span>${connected ? 'Yes' : 'No'}</span>
          </div>
          <div>
            <span class="label">Last activity</span>
            <span>${this.formatAgo(status?.lastActivity)}</span>
          </div>
          ${status?.lastConnectedAt
            ? html`<div>
                <span class="label">Last connect</span>
                <span>${this.formatAgo(status.lastConnectedAt)}</span>
              </div>`
            : nothing}
          ${status?.lastMessageAt
            ? html`<div>
                <span class="label">Last message</span>
                <span>${this.formatAgo(status.lastMessageAt)}</span>
              </div>`
            : nothing}
        </div>

        ${status?.lastError
          ? html`<div class="callout danger">${status.lastError}</div>`
          : nothing}

        ${connected
          ? html`<div class="callout success">Channel is active and receiving messages.</div>`
          : nothing}

        <div class="row">
          ${connected
            ? html`<button class="btn danger" ?disabled=${busy} @click=${() => this.disconnectChannel(def.type)}>
                ${busy ? 'Working…' : 'Disconnect'}
              </button>`
            : html`<button class="btn primary" ?disabled=${busy} @click=${() => this.connectChannel(def.type)}>
                ${busy ? 'Working…' : 'Connect'}
              </button>`}
          <button class="btn" ?disabled=${busy} @click=${() => this.probeChannel(def.type)}>
            Probe
          </button>
          <button class="btn" @click=${() => this.loadChannels()}>
            Refresh
          </button>
        </div>

        ${!configured
          ? html`
              <div class="env-hint">
                Required: ${def.envVars.join(', ')}
              </div>
            `
          : nothing}

        ${this.renderConfigSection(def)}
      </div>
    `;
  }

  private renderConfigSection(def: ChannelDefinition) {
    const form = this.configForms.get(def.type) ?? {};

    const fields: { key: string; label: string; placeholder: string }[] = [];
    if (def.type === 'telegram') {
      fields.push(
        { key: 'botToken', label: 'Bot Token', placeholder: 'e.g. 123456:ABC-DEF...' },
        { key: 'allowedChatIds', label: 'Allowed Chat IDs', placeholder: 'Comma-separated IDs' },
      );
    } else if (def.type === 'discord') {
      fields.push(
        { key: 'token', label: 'Bot Token', placeholder: 'Discord bot token' },
        { key: 'allowedGuilds', label: 'Allowed Guild IDs', placeholder: 'Comma-separated IDs' },
        { key: 'allowedChannels', label: 'Allowed Channel IDs', placeholder: 'Comma-separated IDs' },
      );
    } else if (def.type === 'whatsapp') {
      fields.push(
        { key: 'sessionPath', label: 'Session Path', placeholder: '~/.openrappter/whatsapp-session' },
        { key: 'allowedNumbers', label: 'Allowed Numbers', placeholder: 'Comma-separated numbers' },
      );
    }

    if (fields.length === 0) return nothing;

    return html`
      <div class="config-section">
        <details>
          <summary>${def.label} Configuration</summary>
          <div class="config-fields">
            ${fields.map(
              (f) => html`
                <div class="config-field">
                  <label>${f.label}</label>
                  <input
                    type="${f.key.toLowerCase().includes('token') ? 'password' : 'text'}"
                    placeholder=${f.placeholder}
                    .value=${form[f.key] ?? ''}
                    @input=${(e: Event) => {
                      const val = (e.target as HTMLInputElement).value;
                      const updated = new Map(this.configForms);
                      const existing = updated.get(def.type) ?? {};
                      existing[f.key] = val;
                      updated.set(def.type, existing);
                      this.configForms = updated;
                    }}
                  />
                </div>
              `
            )}
            <div class="row">
              <button
                class="btn primary"
                @click=${() => this.saveConfig(def.type)}
              >
                Save
              </button>
            </div>
          </div>
        </details>
      </div>
    `;
  }

  private async saveConfig(type: string) {
    const form = this.configForms.get(type);
    if (!form) return;
    try {
      await gateway.call('channels.configure', { type, config: form });
      await this.loadChannels();
    } catch (e) {
      console.error(`Failed to save ${type} config:`, e);
    }
  }

  render() {
    if (this.loading) {
      return html`<div class="loading">Loading channels…</div>`;
    }

    return html`
      <div class="page-header">
        <h2>Channels</h2>
        <p>Manage channels and settings.</p>
      </div>

      <div class="channels-list">
        ${SUPPORTED_CHANNELS.map((def) => this.renderChannelCard(def))}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-channels': OpenRappterChannels;
  }
}
