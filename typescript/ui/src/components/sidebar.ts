import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { View } from '../services/navigation.js';

interface NavItem {
  id: View;
  label: string;
  icon: string;
}

@customElement('openrappter-sidebar')
export class OpenRappterSidebar extends LitElement {
  static styles = css`
    :host {
      position: fixed; left: 0; top: 0; bottom: 0; width: 192px;
      background: var(--cp-bg-elevated); border-right: 1px solid var(--cp-border);
      display: flex; flex-direction: column;
    }
    * { box-sizing: border-box; }
    .logo { padding: 24px 18px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--cp-border); }
    .logo-icon {
      width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px;
      font-size: 11px; font-weight: 750; letter-spacing: -.08em;
      background: var(--cp-accent); color: var(--cp-accent-fg);
    }
    .logo-text { font-size: 16px; font-weight: 650; letter-spacing: -.03em; color: var(--cp-text); }
    nav { flex: 1; padding: 20px 0; overflow-y: auto; min-height: 0; }
    .nav-section { padding: 0 12px; margin-bottom: 16px; }
    .nav-section-title {
      font-size: 10px; font-weight: 500; color: var(--cp-text-muted);
      text-transform: uppercase; letter-spacing: .1em; padding: 8px 12px;
    }
    .nav-item {
      display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: .625rem;
      cursor: pointer; transition: background .15s ease; color: var(--cp-text-muted);
      text-decoration: none; width: 100%; border: 0; background: var(--cp-bg-elevated);
      font: inherit; text-align: left;
    }
    .nav-item:hover { background: var(--cp-surface-soft); color: var(--cp-text); }
    .nav-item.active { background: var(--cp-accent-soft); color: var(--cp-accent); }
    .nav-item:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid var(--cp-accent); outline-offset: 2px; }
    .nav-icon { font-size: 14px; width: 20px; text-align: center; }
    .nav-label { font-size: 12px; font-weight: 500; }
    .compatibility { margin-top: 24px; border-top: 1px solid var(--cp-border); padding-top: 16px; }
    .compatibility summary { cursor: pointer; color: var(--cp-text-muted); font-size: 11px; padding: 8px 12px; }
    .compatibility p { color: var(--cp-text-muted); font-size: 10px; line-height: 1.6; padding: 0 12px; }
    .footer { padding: 20px; border-top: 1px solid var(--cp-border); font-size: 11px; line-height: 1.7; color: var(--cp-text-muted); }
    .footer a { color: var(--cp-text-muted); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
    @media (max-width: 900px) {
      :host { position: relative; width: 100%; border-right: 0; border-bottom: 1px solid var(--cp-border); }
      .logo { padding: 14px 16px; border-bottom: 0; }
      nav { padding: 0 4px 8px; }
      .nav-section { margin-bottom: 0; }
      .primary-items { display: flex; flex-wrap: wrap; gap: 4px; }
      .primary-items .nav-item { width: auto; padding: 8px 10px; gap: 5px; }
      .nav-section-title, .footer { display: none; }
      .compatibility { margin: 8px 0 0; padding-top: 4px; }
      .compatibility[open] .compatibility-items { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  `;

  @property({ type: String }) currentView: View = 'work';

  private navItems: NavItem[] = [
    { id: 'work', label: 'Work', icon: '▦' },
    { id: 'chat', label: 'Chat', icon: '↗' },
    { id: 'show-and-tell', label: 'Record workflow', icon: '⊙' },
    { id: 'cron', label: 'Automations', icon: '↻' },
    { id: 'config', label: 'Settings', icon: '≡' },
  ];

  private compatibilityItems: NavItem[] = [
    { id: 'surgeon', label: 'Copilot Surgeon', icon: '✦' },
    { id: 'rappids', label: 'Quantum RAPPIDs', icon: '◉' },
    { id: 'channels', label: 'Channels', icon: '↔' },
    { id: 'sessions', label: 'Sessions', icon: '≡' },
    { id: 'agents', label: 'Agent management', icon: '⊞' },
    { id: 'skills', label: 'Skills', icon: '◇' },
    { id: 'showcase', label: 'Showcase', icon: '▤' },
    { id: 'zen', label: 'Zen', icon: '○' },
    { id: 'accounts', label: 'Accounts', icon: '⊡' },
    { id: 'devices', label: 'Devices', icon: '▣' },
    { id: 'presence', label: 'System health', icon: '⌁' },
    { id: 'logs', label: 'Logs', icon: '≡' },
    { id: 'debug', label: 'Debug', icon: '⌘' },
  ];

  private handleClick(view: View) {
    this.dispatchEvent(new CustomEvent('navigate', {
      detail: { view }, bubbles: true, composed: true,
    }));
  }

  private renderItem(item: NavItem) {
    return html`<button type="button" class="nav-item ${this.currentView === item.id ? 'active' : ''}"
      aria-current=${this.currentView === item.id ? 'page' : nothing}
      data-view=${item.id} @click=${() => this.handleClick(item.id)}>
      <span class="nav-icon" aria-hidden="true">${item.icon}</span><span class="nav-label">${item.label}</span>
    </button>`;
  }

  render() {
    return html`
      <div class="logo"><span class="logo-icon" aria-hidden="true">RW</span><span class="logo-text">RAPP Work</span></div>
      <nav aria-label="Product navigation">
        <div class="nav-section">
          <div class="nav-section-title">Workspace</div>
          <div class="primary-items" aria-label="Primary navigation">${this.navItems.map((item) => this.renderItem(item))}</div>
        </div>
        <details class="nav-section compatibility" ?open=${this.compatibilityItems.some((item) => item.id === this.currentView)}>
          <summary>Compatibility</summary><p>Specialist & legacy views. Existing tools, unchanged.</p>
          <div class="compatibility-items">${this.compatibilityItems.map((item) => this.renderItem(item))}</div>
        </details>
      </nav>
      <div class="footer">Your local AI workforce.<br>
        <a href="https://github.com/kody-w/openrappter" target="_blank" rel="noopener noreferrer">RAPP Work · Source ↗</a>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-sidebar': OpenRappterSidebar;
  }
}
