/**
 * Main App Component
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

type View = 'surgeon' | 'rappids' | 'chat' | 'show-and-tell' | 'channels' | 'sessions' | 'cron' | 'config' | 'logs' | 'agents' | 'skills' | 'devices' | 'presence' | 'debug' | 'showcase' | 'zen' | 'accounts';

@customElement('openrappter-app')
export class OpenRappterApp extends LitElement {
  static styles = css`
    :host {
      display: flex;
      min-height: 100vh;
    }

    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      margin-left: 240px;
    }

    .main-content.focused {
      margin-left: 0;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.5rem;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
    }

    .header h1 {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .back {
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.45rem 0.7rem;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      cursor: pointer;
    }

    .back:hover {
      color: var(--text-primary);
      border-color: var(--accent);
    }

    .status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: var(--text-secondary);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--error);
    }

    .status-dot.connected {
      background: var(--accent);
    }

    .view-container {
      flex: 1;
      overflow: auto;
    }

    .connecting {
      width: 100vw;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 1rem;
      background:
        radial-gradient(circle at 50% 42%, rgba(88, 245, 210, 0.12), transparent 24rem),
        #050711;
      color: #f7f9ff;
    }

    .connecting strong {
      font-size: 1rem;
    }

    .connecting span {
      color: #94a0ba;
      font-size: 0.8rem;
    }

    .retry {
      margin-top: 0.35rem;
      border: 1px solid rgba(88, 245, 210, 0.35);
      border-radius: 0.6rem;
      padding: 0.55rem 0.9rem;
      background: rgba(88, 245, 210, 0.1);
      color: #d7fff5;
      cursor: pointer;
      font-size: 0.8rem;
      font-weight: 600;
    }

    .retry:hover {
      background: rgba(88, 245, 210, 0.18);
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;

  @state()
  private currentView: View = 'surgeon';

  @state()
  private connected = false;

  @state()
  private connecting = true;

  @state()
  private connectionError: string | null = null;

  @state()
  private status: { uptime: number; connections: number } | null = null;

  @state()
  private focusMode = false;

  connectedCallback() {
    super.connectedCallback();
    if (window.openrappterDesktop) {
      this.navigate('chat');
    }
    this.connectToGateway();

    // Update status when connection state changes
    gateway.onStatusChange = (connected: boolean) => {
      this.connected = connected;
      if (connected) {
        this.connecting = false;
        this.connectionError = null;
      }
    };
  }

  private async connectToGateway() {
    this.connecting = true;
    this.connectionError = null;
    try {
      await gateway.connect();
      this.connected = true;

      // Subscribe to chat events for streaming
      await gateway.subscribe(['chat', 'agent', 'presence', 'heartbeat']);

      // Get initial status
      try {
        this.status = await gateway.call('status');
      } catch { /* status endpoint may not exist */ }

      gateway.on('heartbeat', (data) => {
        this.status = data as { uptime: number; connections: number };
      });
    } catch (error) {
      console.error('Failed to connect to gateway:', error);
      this.connected = false;
      this.connectionError = (error as Error).message;
    } finally {
      this.connecting = false;
    }
  }

  private handleNavigation(e: CustomEvent<{ view: View }>) {
    this.navigate(e.detail.view);
  }

  private handleToggleFocus(e: CustomEvent<{ focused: boolean }>) {
    this.focusMode = e.detail.focused;
  }

  navigate(view: View): void {
    this.currentView = view;
    if (view !== 'chat') this.focusMode = false;
  }

  private renderView() {
    switch (this.currentView) {
      case 'surgeon':
        return html`<openrappter-surgeon></openrappter-surgeon>`;
      case 'chat':
        return html`
          <openrappter-chat
            @toggle-focus=${this.handleToggleFocus}
          ></openrappter-chat>
        `;
      case 'rappids':
        return html`<openrappter-rappids></openrappter-rappids>`;
      case 'show-and-tell':
        return html`<openrappter-show-and-tell></openrappter-show-and-tell>`;
      case 'channels':
        return html`<openrappter-channels></openrappter-channels>`;
      case 'sessions':
        return html`<openrappter-sessions></openrappter-sessions>`;
      case 'cron':
        return html`<openrappter-cron></openrappter-cron>`;
      case 'config':
        return html`<openrappter-config></openrappter-config>`;
      case 'logs':
        return html`<openrappter-logs></openrappter-logs>`;
      case 'agents':
        return html`<openrappter-agents></openrappter-agents>`;
      case 'skills':
        return html`<openrappter-skills></openrappter-skills>`;
      case 'devices':
        return html`<openrappter-devices></openrappter-devices>`;
      case 'presence':
        return html`<openrappter-presence></openrappter-presence>`;
      case 'debug':
        return html`<openrappter-debug></openrappter-debug>`;
      case 'showcase':
        return html`<openrappter-showcase></openrappter-showcase>`;
      case 'zen':
        return html`<openrappter-zen></openrappter-zen>`;
      case 'accounts':
        return html`<openrappter-accounts></openrappter-accounts>`;
      default:
        return html`<openrappter-chat></openrappter-chat>`;
    }
  }

  render() {
    // Only the very first connection blocks the surface. A later drop must
    // leave the operating room usable and offer an explicit retry instead of
    // trapping the owner behind a spinner.
    if (this.connecting && !this.connected) {
      return html`
        <div class="connecting">
          <div class="spinner"></div>
          <strong>Waking the OpenRappter patient…</strong>
          <span>Connecting Copilot to live anatomy</span>
        </div>
      `;
    }

    if (!this.connected) {
      return html`
        <div class="connecting">
          <strong>The OpenRappter patient is unreachable.</strong>
          <span>${this.connectionError ?? 'The gateway connection was lost.'}</span>
          <button class="retry" @click=${() => void this.connectToGateway()}>
            Reconnect
          </button>
        </div>
      `;
    }

    if (this.currentView === 'surgeon') {
      return html`
        <openrappter-surgeon
          @navigate=${this.handleNavigation}
        ></openrappter-surgeon>
      `;
    }

    return html`
      ${this.focusMode
        ? nothing
        : html`
            <openrappter-sidebar
              .currentView=${this.currentView}
              @navigate=${this.handleNavigation}
            ></openrappter-sidebar>
          `}

      <div class="main-content ${this.focusMode ? 'focused' : ''}">
        ${this.focusMode
          ? nothing
          : html`<header class="header">
          <div class="header-title">
            <button class="back" @click=${() => this.navigate('surgeon')}>
              ← Operating room
            </button>
            <h1>${this.getViewTitle()}</h1>
          </div>
          <div class="status">
            <span class="status-dot ${this.connected ? 'connected' : ''}"></span>
            ${this.connected ? 'Connected' : 'Disconnected'}
            ${this.status ? html` • Uptime: ${this.formatUptime(this.status.uptime)}` : ''}
          </div>
        </header>`}

        <div class="view-container">
          ${this.renderView()}
        </div>
      </div>
    `;
  }

  private getViewTitle(): string {
    const titles: Record<View, string> = {
      surgeon: 'Copilot Surgeon',
      rappids: 'Quantum RAPPIDs',
      chat: 'Chat',
      'show-and-tell': 'Show-and-Tell',
      channels: 'Channels',
      sessions: 'Sessions',
      cron: 'Cron Jobs',
      config: 'Configuration',
      logs: 'Logs',
      agents: 'Agents',
      skills: 'Skills',
      devices: 'Devices',
      presence: 'System Health',
      debug: 'Debug',
      showcase: 'Showcase',
      zen: 'Zen',
      accounts: 'GitHub Accounts',
    };
    return titles[this.currentView];
  }

  private formatUptime(seconds: number): string {
    if (!seconds || !Number.isFinite(seconds)) return '0m';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-app': OpenRappterApp;
  }
}
