/**
 * Skills View Component
 * View installed skills and their status
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  installed: boolean;
  enabled: boolean;
}

@customElement('openrappter-skills')
export class OpenRappterSkills extends LitElement {
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
    .skills-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .skill-card {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem 1.25rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
    }
    .skill-icon { font-size: 1.5rem; }
    .skill-info { flex: 1; }
    .skill-name { font-weight: 600; }
    .skill-desc {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }
    .skill-version {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: monospace;
    }
    .status-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-weight: 500;
    }
    .status-badge.enabled {
      background: rgba(16, 185, 129, 0.2);
      color: var(--accent);
    }
    .status-badge.disabled {
      background: rgba(239, 68, 68, 0.2);
      color: var(--error);
    }
    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }
  `;

  @state() private skills: SkillInfo[] = [];
  @state() private loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.loadSkills();
  }

  private async loadSkills() {
    this.loading = true;
    try {
      this.skills = await gateway.call<SkillInfo[]>('skills.list');
    } catch {
      this.skills = [];
    }
    this.loading = false;
  }

  render() {
    if (this.loading) return html`<div>Loading skills...</div>`;

    return html`
      <div class="header">
        <h2>Skills</h2>
        <button @click=${this.loadSkills}>Refresh</button>
      </div>
      ${this.skills.length === 0
        ? html`<div class="empty-state"><p>No skills installed.</p></div>`
        : html`
            <div class="skills-list">
              ${this.skills.map(
                (s) => html`
                  <div class="skill-card">
                    <span class="skill-icon">🧩</span>
                    <div class="skill-info">
                      <div class="skill-name">${s.name}</div>
                      ${s.description ? html`<div class="skill-desc">${s.description}</div>` : ''}
                    </div>
                    ${s.version ? html`<span class="skill-version">v${s.version}</span>` : ''}
                    <span class="status-badge ${s.enabled ? 'enabled' : 'disabled'}">
                      ${s.enabled ? 'Enabled' : 'Disabled'}
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
    'openrappter-skills': OpenRappterSkills;
  }
}
