/**
 * Main App Component
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import { isView, type View } from '../services/navigation.js';

@customElement('openrappter-app')
export class OpenRappterApp extends LitElement {
  static styles = css`
    :host {
      display: flex;
      min-height: 100vh;
      color: var(--cp-text);
    }

    .main-content {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      margin-left: 192px;
    }

    .main-content.focused {
      margin-left: 0;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 28px;
      background: var(--cp-bg-elevated);
      border-bottom: 1px solid var(--cp-border);
    }

    .header h1 {
      margin: 0;
      font-size: .875rem;
      font-weight: 600;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .back {
      border: 1px solid var(--cp-border);
      border-radius: .625rem;
      padding: 0.45rem 0.7rem;
      background: var(--cp-surface);
      color: var(--cp-text-muted);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }

    .back:hover {
      color: var(--cp-text);
      border-color: var(--cp-accent);
    }

    .status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 11px;
      color: var(--cp-text-muted);
      flex-wrap: wrap;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--cp-danger);
    }

    .status-dot.connected {
      background: var(--cp-success);
    }

    .view-container {
      flex: 1;
      overflow: auto;
    }

    .connection-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 28px;
      border-bottom: 1px solid var(--cp-border);
      background: var(--cp-bg-elevated);
      font-size: 12px;
      line-height: 1.6;
    }

    .connection-banner strong {
      display: block;
    }

    .connection-banner span {
      color: var(--cp-text-muted);
      overflow-wrap: anywhere;
    }

    .retry {
      border: 1px solid var(--cp-border);
      border-radius: .625rem;
      padding: 0.55rem 0.9rem;
      background: var(--cp-surface);
      color: var(--cp-text);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }

    .retry:hover {
      border-color: var(--cp-accent);
    }

    button:focus-visible {
      outline: 2px solid var(--cp-accent);
      outline-offset: 3px;
    }
    .offline-view { padding: 40px 28px; color: var(--cp-text-muted); }
    @media (max-width: 900px) {
      :host { flex-direction: column; }
      .main-content { margin-left: 0; }
      .header, .connection-banner { padding: 12px 16px; flex-wrap: wrap; }
    }
  `;

  @state()
  private currentView: View = 'work';

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

  @state()
  private chatSessionId: string | null = null;

  @state()
  private subscriptionError: string | null = null;

  private connectionGeneration = 0;

  connectedCallback() {
    super.connectedCallback();
    gateway.onStatusChange = this.handleGatewayStatus;
    gateway.on('heartbeat', this.handleHeartbeat);
    void this.connectToGateway();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.connectionGeneration++;
    gateway.onStatusChange = null;
    gateway.off('heartbeat', this.handleHeartbeat);
  }

  private handleHeartbeat = (data: unknown) => {
    this.status = data as { uptime: number; connections: number };
  };

  private handleGatewayStatus = (connected: boolean) => {
    this.connectionGeneration++;
    this.connected = connected;
    this.connecting = false;
    this.status = null;
    if (connected) {
      this.connectionError = null;
      void this.loadGatewayStatus();
    } else {
      this.connectionError = 'The gateway connection was lost. Your work view remains available.';
    }
  };

  private async loadGatewayStatus() {
    const generation = this.connectionGeneration;
    this.subscriptionError = null;
    try {
      await gateway.subscribe(['chat', 'agent', 'agent.tool', 'approval', 'presence', 'heartbeat', 'workspace', 'vm']);
    } catch (error) {
      if (generation === this.connectionGeneration) {
        this.subscriptionError = `Live event subscription unavailable. ${String(error)}`;
      }
    }
    try {
      const status = await gateway.call<{ uptime: number; connections: number }>('status');
      if (generation === this.connectionGeneration) this.status = status;
    } catch { /* Older gateways may omit status; Work capabilities remain independent. */ }
  }

  private async connectToGateway() {
    this.connecting = true;
    this.connectionError = null;
    try {
      await gateway.connect();
      if (!this.connected) this.handleGatewayStatus(true);
    } catch (error) {
      this.connected = false;
      this.connectionError = error instanceof Error ? error.message : String(error);
    } finally {
      this.connecting = false;
    }
  }

  private handleNavigation(e: CustomEvent<{ view: string; sessionId?: string }>) {
    if (!isView(e.detail.view)) return;
    this.chatSessionId = e.detail.view === 'chat' ? e.detail.sessionId ?? null : null;
    this.navigate(e.detail.view);
  }

  private handleToggleFocus(e: CustomEvent<{ focused: boolean }>) {
    this.focusMode = e.detail.focused;
  }

  navigate(view: View): void {
    if (!isView(view)) return;
    this.currentView = view;
    if (view !== 'chat') {
      this.focusMode = false;
      this.chatSessionId = null;
    }
    document.title = `RAPP Work · ${this.getViewTitle()}`;
  }

  private renderView() {
    switch (this.currentView) {
      case 'work':
        return html`<rapp-work .connected=${this.connected}></rapp-work>`;
      case 'surgeon':
        return html`<openrappter-surgeon></openrappter-surgeon>`;
      case 'chat':
        return html`
          <openrappter-chat
            .initialSessionId=${this.chatSessionId}
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
        return html`<rapp-work .connected=${this.connected}></rapp-work>`;
    }
  }

  render() {
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
            ${this.currentView !== 'work' ? html`<button class="back" @click=${() => this.navigate('work')}>
              ← Back to Work
            </button>` : nothing}
            <h1>${this.getViewTitle()}</h1>
          </div>
          <div class="status">
            <span class="status-dot ${this.connected ? 'connected' : ''}"></span>
            ${this.connected ? 'Gateway connected' : this.connecting ? 'Connecting to gateway' : 'Gateway offline'}
            ${this.status ? html` · ${this.formatUptime(this.status.uptime)} uptime` : nothing}
          </div>
        </header>`}

        ${!this.connected ? html`<div class="connection-banner" role="status">
          <div><strong>${this.connecting ? 'Connecting to RAPP Work…' : 'RAPP Work is waiting for your gateway.'}</strong>
            <span>${this.connectionError ?? 'Live work becomes available after the gateway connects. No demo data substitutes for a connection error.'}</span></div>
          <button class="retry" ?disabled=${this.connecting} @click=${() => void this.connectToGateway()}>
            ${this.connecting ? 'Connecting…' : 'Reconnect'}
          </button>
        </div>` : nothing}
        ${this.connected && this.subscriptionError ? html`<div class="connection-banner" role="status">${this.subscriptionError}</div>` : nothing}
        ${this.currentView !== 'work' ? html`<div class="connection-banner" role="status">
          <div><strong>Compatibility view · RAPP/1 unverified</strong>
            <span>This legacy surface is preserved, not certified. Its output is not verified Work history without canonical frame evidence.</span></div>
        </div>` : nothing}
        <main class="view-container" @navigate=${this.handleNavigation}>
          ${this.currentView === 'work' || this.connected ? this.renderView()
            : html`<div class="offline-view">Reconnect to use ${this.getViewTitle()}, or return to Work.</div>`}
        </main>
      </div>
    `;
  }

  private getViewTitle(): string {
    const titles: Record<View, string> = {
      work: 'Work',
      surgeon: 'Copilot Surgeon',
      rappids: 'Quantum RAPPIDs',
      chat: 'Chat',
      'show-and-tell': 'Show-and-Tell',
      channels: 'Channels',
      sessions: 'Sessions',
      cron: 'Automations',
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
