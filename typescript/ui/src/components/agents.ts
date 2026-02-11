/**
 * Agents View Component
 * List and manage agents
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface AgentInfo {
  id: string;
  type: string;
  description?: string;
  capabilities?: string[];
}

@customElement('openrappter-agents')
export class OpenRappterAgents extends LitElement {
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
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 1rem;
    }
    .agent-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
    }
    .agent-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }
    .agent-icon { font-size: 1.5rem; }
    .agent-name { font-weight: 600; font-size: 1rem; }
    .agent-type {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
    }
    .agent-desc {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-bottom: 0.75rem;
      line-height: 1.4;
    }
    .capabilities {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }
    .cap-badge {
      font-size: 0.75rem;
      padding: 0.125rem 0.5rem;
      background: var(--bg-tertiary);
      border-radius: 0.25rem;
      color: var(--text-secondary);
    }
    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }
  `;

  @state() private agents: AgentInfo[] = [];
  @state() private loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.loadAgents();
  }

  private async loadAgents() {
    this.loading = true;
    try {
      this.agents = await gateway.call<AgentInfo[]>('agents.list');
    } catch {
      this.agents = [];
    }
    this.loading = false;
  }

  private getAgentIcon(type: string): string {
    const icons: Record<string, string> = {
      basic: '🤖',
      shell: '⌨️',
      memory: '🧠',
      router: '🔀',
      broadcast: '📡',
    };
    return icons[type] ?? '🤖';
  }

  render() {
    if (this.loading) return html`<div>Loading agents...</div>`;

    return html`
      <div class="header">
        <h2>Agents</h2>
        <button @click=${this.loadAgents}>Refresh</button>
      </div>
      ${this.agents.length === 0
        ? html`<div class="empty-state"><p>No agents registered.</p></div>`
        : html`
            <div class="agents-grid">
              ${this.agents.map(
                (a) => html`
                  <div class="agent-card">
                    <div class="agent-header">
                      <span class="agent-icon">${this.getAgentIcon(a.type)}</span>
                      <div>
                        <div class="agent-name">${a.id}</div>
                        <div class="agent-type">${a.type}</div>
                      </div>
                    </div>
                    ${a.description ? html`<div class="agent-desc">${a.description}</div>` : ''}
                    ${a.capabilities?.length
                      ? html`
                          <div class="capabilities">
                            ${a.capabilities.map(
                              (c) => html`<span class="cap-badge">${c}</span>`,
                            )}
                          </div>
                        `
                      : ''}
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
    'openrappter-agents': OpenRappterAgents;
  }
}
