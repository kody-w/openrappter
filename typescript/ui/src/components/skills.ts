/**
 * Skills View Component
 * View installed skills with search, enable/disable, and install from ClawHub.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  installed: boolean;
  enabled: boolean;
  source?: string;
  scripts?: string[];
}

@customElement('openrappter-skills')
export class OpenRappterSkills extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem 2rem;
    }

    .page-header {
      margin-bottom: 1rem;
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

    .toolbar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1.25rem;
    }

    .search-input {
      flex: 1;
      max-width: 320px;
      padding: 0.5rem 0.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.875rem;
    }

    .search-input:focus {
      outline: none;
      border-color: var(--accent);
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

    .btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .skills-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 1rem;
    }

    .skill-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .skill-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .skill-icon { font-size: 1.5rem; }

    .skill-meta { flex: 1; }

    .skill-name {
      font-weight: 600;
      font-size: 1rem;
    }

    .skill-version {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: monospace;
    }

    .skill-desc {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .skill-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }

    .chip-row {
      display: flex;
      gap: 0.375rem;
      flex-wrap: wrap;
    }

    .chip {
      font-size: 0.6875rem;
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .toggle-switch {
      width: 44px;
      height: 24px;
      background: var(--bg-tertiary);
      border-radius: 12px;
      position: relative;
      cursor: pointer;
      transition: background 0.2s ease;
      flex-shrink: 0;
    }

    .toggle-switch.enabled {
      background: var(--accent);
    }

    .toggle-switch::after {
      content: '';
      position: absolute;
      width: 20px;
      height: 20px;
      background: white;
      border-radius: 50%;
      top: 2px;
      left: 2px;
      transition: transform 0.2s ease;
    }

    .toggle-switch.enabled::after {
      transform: translateX(20px);
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }

    .skill-source {
      font-size: 0.6875rem;
      color: var(--text-secondary);
      font-family: monospace;
    }
  `;

  @state() private skills: SkillInfo[] = [];
  @state() private loading = true;
  @state() private search = '';

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

  private get filteredSkills() {
    if (!this.search) return this.skills;
    const q = this.search.toLowerCase();
    return this.skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q),
    );
  }

  private async toggleSkill(skill: SkillInfo) {
    try {
      await gateway.call('skills.toggle', { id: skill.id, enabled: !skill.enabled });
      this.skills = this.skills.map((s) =>
        s.id === skill.id ? { ...s, enabled: !s.enabled } : s,
      );
    } catch (e) {
      console.error('Failed to toggle skill:', e);
    }
  }

  render() {
    if (this.loading) return html`<div class="empty-state">Loading skills…</div>`;

    const skills = this.filteredSkills;

    return html`
      <div class="page-header">
        <h2>Skills</h2>
        <p>Installed ClawHub skills and local SKILL.md files.</p>
      </div>

      <div class="toolbar">
        <input
          class="search-input"
          placeholder="Search skills…"
          .value=${this.search}
          @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; }}
        />
        <button class="btn" @click=${() => this.loadSkills()}>Refresh</button>
      </div>

      ${skills.length === 0
        ? html`<div class="empty-state">
            <p>${this.search ? 'No skills match your search.' : 'No skills installed.'}</p>
            <p>Install skills with <code>npx clawhub install &lt;skill&gt;</code></p>
          </div>`
        : html`
            <div class="skills-grid">
              ${skills.map(
                (s) => html`
                  <div class="skill-card">
                    <div class="skill-header">
                      <span class="skill-icon">🧩</span>
                      <div class="skill-meta">
                        <div class="skill-name">${s.name}</div>
                        ${s.version ? html`<span class="skill-version">v${s.version}</span>` : nothing}
                      </div>
                      <div
                        class="toggle-switch ${s.enabled ? 'enabled' : ''}"
                        @click=${() => this.toggleSkill(s)}
                        title=${s.enabled ? 'Disable' : 'Enable'}
                      ></div>
                    </div>
                    ${s.description ? html`<div class="skill-desc">${s.description}</div>` : nothing}
                    <div class="skill-footer">
                      <div class="chip-row">
                        ${s.scripts?.map((sc) => html`<span class="chip">${sc}</span>`) ?? nothing}
                        ${s.source ? html`<span class="skill-source">${s.source}</span>` : nothing}
                      </div>
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
    'openrappter-skills': OpenRappterSkills;
  }
}
