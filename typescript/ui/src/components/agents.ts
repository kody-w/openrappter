/**
 * Agents View Component
 * Agent management dashboard with sidebar list and tabbed detail panel.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AgentInfo {
  id: string;
  type: string;
  description?: string;
  capabilities?: string[];
  parameters?: Record<string, unknown>;
  tools?: ToolInfo[];
  channels?: ChannelBinding[];
  messageCount?: number;
}

interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  enabled: boolean;
  agentId?: string;
}

interface ChannelBinding {
  type: string;
  connected: boolean;
}

interface ToolInfo {
  name: string;
  description?: string;
}

type DetailTab = 'overview' | 'skills' | 'channels' | 'tools';

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

@customElement('openrappter-agents')
export class OpenRappterAgents extends LitElement {
  /* ---- state ---- */

  @state() private agents: AgentInfo[] = [];
  @state() private loading = true;
  @state() private error = '';
  @state() private searchQuery = '';
  @state() private selectedId: string | null = null;
  @state() private activeTab: DetailTab = 'overview';

  @state() private skills: SkillInfo[] = [];
  @state() private skillsLoading = false;
  @state() private skillsError = '';

  /* ---- styles ---- */

  static styles = css`
    /* ===== layout ===== */
    :host {
      display: flex;
      height: 100%;
      overflow: hidden;
    }

    /* ===== sidebar ===== */
    .sidebar {
      width: 280px;
      min-width: 220px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .sidebar-header {
      padding: 1rem 1rem 0.75rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .sidebar-header h2 {
      font-size: 1rem;
      font-weight: 600;
      margin: 0;
    }

    .sidebar-header .count {
      font-size: 0.75rem;
      color: var(--text-secondary);
      background: var(--bg-tertiary);
      padding: 0.125rem 0.5rem;
      border-radius: 999px;
    }

    .search-box {
      padding: 0 1rem 0.75rem;
    }

    .search-box input {
      width: 100%;
      padding: 0.5rem 0.625rem;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.8125rem;
      box-sizing: border-box;
    }

    .search-box input::placeholder { color: var(--text-secondary); }
    .search-box input:focus { outline: none; border-color: var(--accent); }

    .agent-list {
      flex: 1;
      overflow-y: auto;
      padding: 0 0.5rem 0.5rem;
    }

    .agent-item {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0.625rem 0.625rem;
      border-radius: 0.375rem;
      cursor: pointer;
      transition: background 0.12s ease;
      border: 1px solid transparent;
    }

    .agent-item:hover { background: var(--bg-tertiary); }

    .agent-item.selected {
      background: var(--bg-tertiary);
      border-color: var(--accent);
    }

    .agent-item .icon { font-size: 1.25rem; flex-shrink: 0; }

    .agent-item .info {
      flex: 1;
      min-width: 0;
    }

    .agent-item .name {
      font-size: 0.8125rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .agent-item .type-badge {
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
      background: var(--bg-primary);
      padding: 0.0625rem 0.375rem;
      border-radius: 0.25rem;
      display: inline-block;
      margin-top: 0.125rem;
    }

    .agent-item .active-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      flex-shrink: 0;
    }

    .sidebar-empty {
      padding: 1.5rem 1rem;
      text-align: center;
      color: var(--text-secondary);
      font-size: 0.8125rem;
    }

    /* ===== detail panel ===== */
    .detail {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg-primary);
    }

    /* no selection */
    .no-selection {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
      gap: 0.5rem;
    }

    .no-selection .icon { font-size: 2.5rem; opacity: 0.5; }
    .no-selection p { font-size: 0.875rem; }

    /* tabs */
    .tab-bar {
      display: flex;
      border-bottom: 1px solid var(--border);
      padding: 0 1.5rem;
      background: var(--bg-secondary);
    }

    .tab-btn {
      padding: 0.75rem 1rem;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-secondary);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: color 0.12s ease, border-color 0.12s ease;
    }

    .tab-btn:hover { color: var(--text-primary); }

    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    .tab-content {
      flex: 1;
      overflow-y: auto;
      padding: 1.5rem;
    }

    /* ===== overview tab ===== */
    .overview-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.25rem;
    }

    .overview-header .icon { font-size: 2rem; }

    .overview-header .title {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .overview-header .type {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
      background: var(--bg-tertiary);
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
    }

    .overview-desc {
      font-size: 0.875rem;
      color: var(--text-secondary);
      line-height: 1.5;
      margin-bottom: 1.25rem;
    }

    .stat-row {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
    }

    .stat-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      min-width: 100px;
    }

    .stat-card .label {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    .stat-card .value {
      font-size: 1.125rem;
      font-weight: 600;
    }

    .section-title {
      font-size: 0.8125rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
      margin-bottom: 0.625rem;
      margin-top: 1.25rem;
    }

    .cap-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }

    .cap-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.625rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.25rem;
      color: var(--text-secondary);
    }

    .schema-block {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.75rem;
      line-height: 1.5;
      color: var(--text-secondary);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ===== skills tab ===== */
    .skill-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .skill-row .skill-info { flex: 1; min-width: 0; }

    .skill-row .skill-name { font-weight: 600; font-size: 0.875rem; }

    .skill-row .skill-version {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: 'SF Mono', 'Fira Code', monospace;
    }

    .toggle {
      position: relative;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }

    .toggle input {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }

    .toggle .slider {
      position: absolute;
      inset: 0;
      background: var(--bg-tertiary);
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.2s;
      border: 1px solid var(--border);
    }

    .toggle .slider::before {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      left: 2px;
      top: 2px;
      background: var(--text-secondary);
      border-radius: 50%;
      transition: transform 0.2s, background 0.2s;
    }

    .toggle input:checked + .slider { background: var(--accent); border-color: var(--accent); }
    .toggle input:checked + .slider::before { transform: translateX(16px); background: white; }

    /* ===== channels tab ===== */
    .channel-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .channel-row .ch-icon { font-size: 1.25rem; flex-shrink: 0; }

    .channel-row .ch-info { flex: 1; min-width: 0; }

    .channel-row .ch-type {
      font-weight: 600;
      font-size: 0.875rem;
      text-transform: capitalize;
    }

    .status-badge {
      font-size: 0.6875rem;
      font-weight: 600;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .status-badge.connected {
      background: rgba(16, 185, 129, 0.2);
      color: var(--accent);
    }

    .status-badge.disconnected {
      background: rgba(239, 68, 68, 0.2);
      color: var(--error);
    }

    /* ===== tools tab ===== */
    .tool-row {
      padding: 0.75rem 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .tool-row .tool-name {
      font-weight: 600;
      font-size: 0.875rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
    }

    .tool-row .tool-desc {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
      line-height: 1.4;
    }

    /* ===== shared ===== */
    .empty-tab {
      text-align: center;
      padding: 2rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    .loading-state {
      display: flex;
      justify-content: center;
      padding: 2rem;
      color: var(--text-secondary);
      font-size: 0.8125rem;
    }

    .error-banner {
      padding: 0.625rem 0.75rem;
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      background: rgba(239, 68, 68, 0.15);
      color: var(--error);
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .error-banner button {
      background: none;
      border: none;
      color: var(--error);
      cursor: pointer;
      font-size: 0.8125rem;
      text-decoration: underline;
      padding: 0;
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

    .btn:hover { background: var(--border); }
  `;

  /* ---- lifecycle ---- */

  connectedCallback() {
    super.connectedCallback();
    this.loadAgents();
  }

  /* ---- data loading ---- */

  private async loadAgents() {
    this.loading = true;
    this.error = '';
    try {
      this.agents = await gateway.call<AgentInfo[]>('agents.list');
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to load agents';
      this.agents = [];
    }
    this.loading = false;
  }

  private async loadSkills() {
    this.skillsLoading = true;
    this.skillsError = '';
    try {
      this.skills = await gateway.call<SkillInfo[]>('skills.list');
    } catch (e) {
      this.skillsError = e instanceof Error ? e.message : 'Failed to load skills';
      this.skills = [];
    }
    this.skillsLoading = false;
  }

  /* ---- helpers ---- */

  private getAgentIcon(type: string): string {
    const icons: Record<string, string> = {
      basic: '🤖',
      shell: '⌨️',
      memory: '🧠',
      router: '🔀',
      broadcast: '📡',
      skill: '🧩',
      subagent: '🔗',
    };
    return icons[type] ?? '🤖';
  }

  private getChannelIcon(type: string): string {
    const icons: Record<string, string> = {
      telegram: '✈️',
      discord: '🎮',
      whatsapp: '📱',
      slack: '💬',
      signal: '🔒',
      imessage: '💬',
      matrix: '🌐',
      cli: '⌨️',
    };
    return icons[type] ?? '📡';
  }

  private get filteredAgents(): AgentInfo[] {
    if (!this.searchQuery) return this.agents;
    const q = this.searchQuery.toLowerCase();
    return this.agents.filter(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        a.type.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q),
    );
  }

  private get selectedAgent(): AgentInfo | undefined {
    return this.agents.find((a) => a.id === this.selectedId);
  }

  /* ---- event handlers ---- */

  private onSearch(e: Event) {
    this.searchQuery = (e.target as HTMLInputElement).value;
  }

  private selectAgent(agent: AgentInfo) {
    this.selectedId = agent.id;
    this.activeTab = 'overview';
    this.skills = [];
    this.skillsError = '';
  }

  private switchTab(tab: DetailTab) {
    this.activeTab = tab;
    if (tab === 'skills' && this.skills.length === 0 && !this.skillsLoading) {
      this.loadSkills();
    }
  }

  /* ---- render: root ---- */

  render() {
    return html`
      ${this.renderSidebar()}
      ${this.renderDetail()}
    `;
  }

  /* ---- render: sidebar ---- */

  private renderSidebar() {
    return html`
      <div class="sidebar">
        <div class="sidebar-header">
          <h2>Agents</h2>
          <span class="count">${this.agents.length}</span>
        </div>

        <div class="search-box">
          <input
            type="text"
            placeholder="Search agents…"
            .value=${this.searchQuery}
            @input=${this.onSearch}
          />
        </div>

        ${this.loading
          ? html`<div class="loading-state">Loading…</div>`
          : this.error
            ? html`
                <div class="error-banner" style="margin: 0 0.5rem;">
                  ${this.error}
                  <button @click=${this.loadAgents}>Retry</button>
                </div>
              `
            : this.renderAgentList()}
      </div>
    `;
  }

  private renderAgentList() {
    const list = this.filteredAgents;

    if (this.agents.length === 0) {
      return html`<div class="sidebar-empty">No agents registered.</div>`;
    }

    if (list.length === 0) {
      return html`<div class="sidebar-empty">No agents match "${this.searchQuery}".</div>`;
    }

    return html`
      <div class="agent-list">
        ${list.map(
          (a) => html`
            <div
              class="agent-item ${a.id === this.selectedId ? 'selected' : ''}"
              @click=${() => this.selectAgent(a)}
            >
              <span class="icon">${this.getAgentIcon(a.type)}</span>
              <div class="info">
                <div class="name">${a.id}</div>
                <span class="type-badge">${a.type}</span>
              </div>
              ${(a.capabilities?.length ?? 0) > 0
                ? html`<span class="active-dot" title="Has capabilities"></span>`
                : nothing}
            </div>
          `,
        )}
      </div>
    `;
  }

  /* ---- render: detail panel ---- */

  private renderDetail() {
    const agent = this.selectedAgent;

    if (!agent) {
      return html`
        <div class="detail">
          <div class="no-selection">
            <span class="icon">🤖</span>
            <p>Select an agent to view details</p>
          </div>
        </div>
      `;
    }

    const tabs: { id: DetailTab; label: string }[] = [
      { id: 'overview', label: 'Overview' },
      { id: 'skills', label: 'Skills' },
      { id: 'channels', label: 'Channels' },
      { id: 'tools', label: 'Tools' },
    ];

    return html`
      <div class="detail">
        <div class="tab-bar">
          ${tabs.map(
            (t) => html`
              <button
                class="tab-btn ${this.activeTab === t.id ? 'active' : ''}"
                @click=${() => this.switchTab(t.id)}
              >
                ${t.label}
              </button>
            `,
          )}
          <span style="flex:1"></span>
          <button class="btn" style="align-self:center;margin-right:0.5rem;" @click=${this.loadAgents}>
            Refresh
          </button>
        </div>

        <div class="tab-content">
          ${this.activeTab === 'overview' ? this.renderOverview(agent) : nothing}
          ${this.activeTab === 'skills' ? this.renderSkills(agent) : nothing}
          ${this.activeTab === 'channels' ? this.renderChannels(agent) : nothing}
          ${this.activeTab === 'tools' ? this.renderTools(agent) : nothing}
        </div>
      </div>
    `;
  }

  /* ---- render: overview tab ---- */

  private renderOverview(agent: AgentInfo) {
    return html`
      <div class="overview-header">
        <span class="icon">${this.getAgentIcon(agent.type)}</span>
        <div>
          <div class="title">${agent.id}</div>
          <span class="type">${agent.type}</span>
        </div>
      </div>

      ${agent.description
        ? html`<div class="overview-desc">${agent.description}</div>`
        : html`<div class="overview-desc" style="font-style:italic;">No description available.</div>`}

      ${agent.messageCount != null
        ? html`
            <div class="stat-row">
              <div class="stat-card">
                <div class="label">Messages</div>
                <div class="value">${agent.messageCount.toLocaleString()}</div>
              </div>
              <div class="stat-card">
                <div class="label">Capabilities</div>
                <div class="value">${agent.capabilities?.length ?? 0}</div>
              </div>
              <div class="stat-card">
                <div class="label">Tools</div>
                <div class="value">${agent.tools?.length ?? 0}</div>
              </div>
            </div>
          `
        : html`
            <div class="stat-row">
              <div class="stat-card">
                <div class="label">Capabilities</div>
                <div class="value">${agent.capabilities?.length ?? 0}</div>
              </div>
              <div class="stat-card">
                <div class="label">Tools</div>
                <div class="value">${agent.tools?.length ?? 0}</div>
              </div>
            </div>
          `}

      ${(agent.capabilities?.length ?? 0) > 0
        ? html`
            <div class="section-title">Capabilities</div>
            <div class="cap-list">
              ${agent.capabilities!.map(
                (c) => html`<span class="cap-badge">${c}</span>`,
              )}
            </div>
          `
        : nothing}

      ${agent.parameters
        ? html`
            <div class="section-title">Parameters Schema</div>
            <div class="schema-block">${JSON.stringify(agent.parameters, null, 2)}</div>
          `
        : nothing}
    `;
  }

  /* ---- render: skills tab ---- */

  private renderSkills(agent: AgentInfo) {
    if (this.skillsLoading) {
      return html`<div class="loading-state">Loading skills…</div>`;
    }

    if (this.skillsError) {
      return html`
        <div class="error-banner">
          ${this.skillsError}
          <button @click=${() => this.loadSkills()}>Retry</button>
        </div>
      `;
    }

    const agentSkills = this.skills.filter(
      (s) => !s.agentId || s.agentId === agent.id,
    );

    if (agentSkills.length === 0) {
      return html`<div class="empty-tab">No skills associated with this agent.</div>`;
    }

    return html`
      ${agentSkills.map(
        (s) => html`
          <div class="skill-row">
            <span style="font-size:1.25rem;">🧩</span>
            <div class="skill-info">
              <div class="skill-name">${s.name}</div>
              ${s.description
                ? html`<div style="font-size:0.75rem;color:var(--text-secondary);margin-top:0.125rem;">${s.description}</div>`
                : nothing}
            </div>
            ${s.version
              ? html`<span class="skill-version">v${s.version}</span>`
              : nothing}
            <label class="toggle" title="${s.enabled ? 'Enabled' : 'Disabled'}">
              <input type="checkbox" .checked=${s.enabled} disabled />
              <span class="slider"></span>
            </label>
          </div>
        `,
      )}
    `;
  }

  /* ---- render: channels tab ---- */

  private renderChannels(agent: AgentInfo) {
    const channels = agent.channels ?? [];

    if (channels.length === 0) {
      return html`<div class="empty-tab">No channels bound to this agent.</div>`;
    }

    return html`
      ${channels.map(
        (ch) => html`
          <div class="channel-row">
            <span class="ch-icon">${this.getChannelIcon(ch.type)}</span>
            <div class="ch-info">
              <div class="ch-type">${ch.type}</div>
            </div>
            <span class="status-badge ${ch.connected ? 'connected' : 'disconnected'}">
              ${ch.connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        `,
      )}
    `;
  }

  /* ---- render: tools tab ---- */

  private renderTools(agent: AgentInfo) {
    const tools = agent.tools ?? [];

    if (tools.length === 0) {
      return html`<div class="empty-tab">No tools available for this agent.</div>`;
    }

    return html`
      ${tools.map(
        (t) => html`
          <div class="tool-row">
            <div class="tool-name">${t.name}</div>
            ${t.description
              ? html`<div class="tool-desc">${t.description}</div>`
              : nothing}
          </div>
        `,
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-agents': OpenRappterAgents;
  }
}
