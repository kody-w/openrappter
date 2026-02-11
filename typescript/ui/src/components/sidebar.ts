/**
 * Sidebar Navigation Component
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

type View = 'chat' | 'channels' | 'sessions' | 'cron' | 'config' | 'logs' | 'agents' | 'skills' | 'devices' | 'presence' | 'debug';

interface NavItem {
  id: View;
  label: string;
  icon: string;
}

@customElement('openrappter-sidebar')
export class OpenRappterSidebar extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      width: 240px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
    }

    .logo {
      padding: 1.5rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border-bottom: 1px solid var(--border);
    }

    .logo-icon {
      font-size: 1.5rem;
    }

    .logo-text {
      font-size: 1.125rem;
      font-weight: 600;
    }

    nav {
      flex: 1;
      padding: 1rem 0;
    }

    .nav-section {
      padding: 0 0.75rem;
      margin-bottom: 1rem;
    }

    .nav-section-title {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.5rem 0.75rem;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.625rem 0.75rem;
      border-radius: 0.375rem;
      cursor: pointer;
      transition: background 0.15s ease;
      color: var(--text-secondary);
      text-decoration: none;
    }

    .nav-item:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .nav-item.active {
      background: var(--accent);
      color: white;
    }

    .nav-icon {
      font-size: 1.125rem;
      width: 1.5rem;
      text-align: center;
    }

    .nav-label {
      font-size: 0.875rem;
      font-weight: 500;
    }

    .footer {
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--border);
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .footer a {
      color: var(--accent);
      text-decoration: none;
    }

    .footer a:hover {
      text-decoration: underline;
    }
  `;

  @property({ type: String })
  currentView: View = 'chat';

  private navItems: NavItem[] = [
    { id: 'chat', label: 'Chat', icon: '💬' },
    { id: 'channels', label: 'Channels', icon: '📡' },
    { id: 'sessions', label: 'Sessions', icon: '📋' },
    { id: 'agents', label: 'Agents', icon: '🤖' },
    { id: 'skills', label: 'Skills', icon: '🧩' },
    { id: 'cron', label: 'Cron Jobs', icon: '⏰' },
    { id: 'config', label: 'Config', icon: '⚙️' },
    { id: 'devices', label: 'Devices', icon: '💻' },
    { id: 'presence', label: 'Health', icon: '🏥' },
    { id: 'logs', label: 'Logs', icon: '📜' },
    { id: 'debug', label: 'Debug', icon: '🔧' },
  ];

  private handleClick(view: View) {
    this.dispatchEvent(
      new CustomEvent('navigate', {
        detail: { view },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    return html`
      <div class="logo">
        <span class="logo-icon">🦖</span>
        <span class="logo-text">OpenRappter</span>
      </div>

      <nav>
        <div class="nav-section">
          <div class="nav-section-title">Main</div>
          ${this.navItems.slice(0, 6).map(
            (item) => html`
              <div
                class="nav-item ${this.currentView === item.id ? 'active' : ''}"
                @click=${() => this.handleClick(item.id)}
              >
                <span class="nav-icon">${item.icon}</span>
                <span class="nav-label">${item.label}</span>
              </div>
            `
          )}
        </div>

        <div class="nav-section">
          <div class="nav-section-title">System</div>
          ${this.navItems.slice(6).map(
            (item) => html`
              <div
                class="nav-item ${this.currentView === item.id ? 'active' : ''}"
                @click=${() => this.handleClick(item.id)}
              >
                <span class="nav-icon">${item.icon}</span>
                <span class="nav-label">${item.label}</span>
              </div>
            `
          )}
        </div>
      </nav>

      <div class="footer">
        <a href="https://github.com/kody-w/openrappter" target="_blank">GitHub</a>
        • v1.2.0
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-sidebar': OpenRappterSidebar;
  }
}
