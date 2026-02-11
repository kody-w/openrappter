/**
 * Main App Component
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

type View = 'chat' | 'channels' | 'sessions' | 'cron' | 'config' | 'logs' | 'agents' | 'skills' | 'devices' | 'presence' | 'debug';

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
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 1rem;
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
  private currentView: View = 'chat';

  @state()
  private connected = false;

  @state()
  private status: { uptime: number; connections: number } | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.connectToGateway();

    // Update status when connection state changes
    gateway.onStatusChange = (connected: boolean) => {
      this.connected = connected;
    };
  }

  private async connectToGateway() {
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
    }
  }

  private handleNavigation(e: CustomEvent<{ view: View }>) {
    this.currentView = e.detail.view;
  }

  private renderView() {
    switch (this.currentView) {
      case 'chat':
        return html`<openrappter-chat></openrappter-chat>`;
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
      default:
        return html`<openrappter-chat></openrappter-chat>`;
    }
  }

  render() {
    return html`
      <openrappter-sidebar
        .currentView=${this.currentView}
        @navigate=${this.handleNavigation}
      ></openrappter-sidebar>

      <div class="main-content">
        <header class="header">
          <h1>${this.getViewTitle()}</h1>
          <div class="status">
            <span class="status-dot ${this.connected ? 'connected' : ''}"></span>
            ${this.connected ? 'Connected' : 'Disconnected'}
            ${this.status ? html` • Uptime: ${this.formatUptime(this.status.uptime)}` : ''}
          </div>
        </header>

        <div class="view-container">
          ${this.renderView()}
        </div>
      </div>
    `;
  }

  private getViewTitle(): string {
    const titles: Record<View, string> = {
      chat: 'Chat',
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
    };
    return titles[this.currentView];
  }

  private formatUptime(seconds: number): string {
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
