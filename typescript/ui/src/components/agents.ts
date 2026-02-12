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

interface AgentFileEntry {
  name: string;
  path: string;
  size?: number;
  modified?: string;
}

interface CronJob {
  id: string;
  name?: string;
  description?: string;
  schedule: string;
  agentId?: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  status?: string;
}

type DetailTab = 'overview' | 'skills' | 'channels' | 'tools' | 'files' | 'cron';

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

  @state() private filesList: AgentFileEntry[] = [];
  @state() private filesLoading = false;
  @state() private filesError = '';
  @state() private activeFile: string | null = null;
  @state() private fileContents: Record<string, string> = {};
  @state() private fileDrafts: Record<string, string> = {};
  @state() private fileSaving = false;

  @state() private cronJobs: CronJob[] = [];
  @state() private cronLoading = false;

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

    /* ===== files tab ===== */
    .files-layout {
      display: flex;
      gap: 1rem;
      height: calc(100vh - 220px);
      min-height: 300px;
    }

    .files-sidebar {
      width: 220px;
      min-width: 180px;
      display: flex;
      flex-direction: column;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      overflow: hidden;
    }

    .files-sidebar-header {
      padding: 0.625rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border);
    }

    .files-list {
      flex: 1;
      overflow-y: auto;
    }

    .file-item {
      padding: 0.5rem 0.75rem;
      font-size: 0.8125rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: background 0.12s;
      border-left: 2px solid transparent;
    }

    .file-item:hover { background: var(--bg-tertiary); }
    .file-item.active { background: var(--bg-tertiary); border-left-color: var(--accent); }

    .file-item .file-icon { font-size: 0.875rem; opacity: 0.6; }

    .file-item .file-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.75rem;
    }

    .file-item .dirty-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--warning, #f59e0b);
      flex-shrink: 0;
    }

    .file-editor {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      overflow: hidden;
    }

    .file-editor-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--border);
      font-size: 0.8125rem;
    }

    .file-editor-header .filename {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .file-editor-actions {
      display: flex;
      gap: 0.375rem;
    }

    .file-editor textarea {
      flex: 1;
      width: 100%;
      padding: 0.75rem;
      background: var(--bg-primary);
      color: var(--text-primary);
      border: none;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.75rem;
      line-height: 1.6;
      resize: none;
      box-sizing: border-box;
    }

    .file-editor textarea:focus { outline: none; }

    .file-no-selection {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    .btn-sm {
      padding: 0.25rem 0.625rem;
      font-size: 0.75rem;
      border-radius: 0.25rem;
    }

    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .btn-primary:hover { opacity: 0.9; }

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: var(--error);
      color: var(--error);
    }

    /* ===== cron tab ===== */
    .cron-job-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .cron-job-card .cron-info { flex: 1; min-width: 0; }

    .cron-job-card .cron-name {
      font-weight: 600;
      font-size: 0.875rem;
    }

    .cron-job-card .cron-schedule {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: 'SF Mono', 'Fira Code', monospace;
      margin-top: 0.125rem;
    }

    .cron-job-card .cron-meta {
      font-size: 0.6875rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .chip {
      font-size: 0.6875rem;
      font-weight: 600;
      padding: 0.125rem 0.5rem;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .chip-ok { background: rgba(16, 185, 129, 0.2); color: var(--accent); }
    .chip-warn { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    .chip-muted { background: var(--bg-tertiary); color: var(--text-secondary); }
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

  private async loadFiles() {
    if (!this.selectedId) return;
    this.filesLoading = true;
    this.filesError = '';
    try {
      const result = await gateway.call<{ files: AgentFileEntry[] }>('agents.files.list', { agentId: this.selectedId });
      this.filesList = result?.files ?? (Array.isArray(result) ? result as unknown as AgentFileEntry[] : []);
    } catch (e) {
      this.filesError = e instanceof Error ? e.message : 'Failed to load files';
      this.filesList = [];
    }
    this.filesLoading = false;
  }

  private async loadFileContent(path: string) {
    this.activeFile = path;
    if (this.fileContents[path] != null) return;
    try {
      const result = await gateway.call<{ content: string }>('agents.files.read', { agentId: this.selectedId, path });
      const content = typeof result === 'string' ? result : result?.content ?? '';
      this.fileContents = { ...this.fileContents, [path]: content };
      this.fileDrafts = { ...this.fileDrafts, [path]: content };
    } catch {
      this.fileContents = { ...this.fileContents, [path]: '// Failed to load file' };
      this.fileDrafts = { ...this.fileDrafts, [path]: '// Failed to load file' };
    }
  }

  private async saveFile(path: string) {
    const content = this.fileDrafts[path];
    if (content == null) return;
    this.fileSaving = true;
    try {
      await gateway.call('agents.files.write', { agentId: this.selectedId, path, content });
      this.fileContents = { ...this.fileContents, [path]: content };
    } catch (e) {
      console.error('Failed to save file:', e);
    }
    this.fileSaving = false;
  }

  private resetFile(path: string) {
    const original = this.fileContents[path];
    if (original != null) {
      this.fileDrafts = { ...this.fileDrafts, [path]: original };
    }
  }

  private isFileDirty(path: string): boolean {
    return this.fileDrafts[path] != null && this.fileDrafts[path] !== this.fileContents[path];
  }

  private async loadCronJobs() {
    this.cronLoading = true;
    try {
      const result = await gateway.call<CronJob[]>('cron.list');
      this.cronJobs = Array.isArray(result) ? result : [];
    } catch {
      this.cronJobs = [];
    }
    this.cronLoading = false;
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
    this.filesList = [];
    this.filesError = '';
    this.activeFile = null;
    this.fileContents = {};
    this.fileDrafts = {};
    this.cronJobs = [];
  }

  private switchTab(tab: DetailTab) {
    this.activeTab = tab;
    if (tab === 'skills' && this.skills.length === 0 && !this.skillsLoading) {
      this.loadSkills();
    }
    if (tab === 'files' && this.filesList.length === 0 && !this.filesLoading) {
      this.loadFiles();
    }
    if (tab === 'cron' && this.cronJobs.length === 0 && !this.cronLoading) {
      this.loadCronJobs();
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
      { id: 'files', label: 'Files' },
      { id: 'tools', label: 'Tools' },
      { id: 'skills', label: 'Skills' },
      { id: 'channels', label: 'Channels' },
      { id: 'cron', label: 'Cron' },
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
          ${this.activeTab === 'files' ? this.renderFiles() : nothing}
          ${this.activeTab === 'skills' ? this.renderSkills(agent) : nothing}
          ${this.activeTab === 'channels' ? this.renderChannels(agent) : nothing}
          ${this.activeTab === 'tools' ? this.renderTools(agent) : nothing}
          ${this.activeTab === 'cron' ? this.renderCron(agent) : nothing}
        </div>
      </div>
    `;
  }

  /* ---- render: overview tab ---- */

  private renderOverview(agent: AgentInfo) {
    const toolCount = agent.tools?.length ?? 0;
    const capCount = agent.capabilities?.length ?? 0;
    const channelCount = agent.channels?.length ?? 0;
    const connectedChannels = agent.channels?.filter(c => c.connected).length ?? 0;

    return html`
      <div class="overview-header">
        <span class="icon">${this.getAgentIcon(agent.type)}</span>
        <div>
          <div class="title">${agent.id}</div>
          <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.25rem;">
            <span class="type">${agent.type}</span>
            ${agent.type === 'skill'
              ? html`<span class="chip chip-muted">Skill Agent</span>`
              : nothing}
          </div>
        </div>
      </div>

      ${agent.description
        ? html`<div class="overview-desc">${agent.description}</div>`
        : html`<div class="overview-desc" style="font-style:italic;">No description available.</div>`}

      <div class="stat-row">
        ${agent.messageCount != null
          ? html`
              <div class="stat-card">
                <div class="label">Messages</div>
                <div class="value">${agent.messageCount.toLocaleString()}</div>
              </div>
            `
          : nothing}
        <div class="stat-card">
          <div class="label">Tools</div>
          <div class="value">${toolCount}</div>
        </div>
        <div class="stat-card">
          <div class="label">Capabilities</div>
          <div class="value">${capCount}</div>
        </div>
        <div class="stat-card">
          <div class="label">Channels</div>
          <div class="value">${connectedChannels}/${channelCount}</div>
        </div>
      </div>

      ${capCount > 0
        ? html`
            <div class="section-title">Capabilities</div>
            <div class="cap-list">
              ${agent.capabilities!.map(
                (c) => html`<span class="cap-badge">${c}</span>`,
              )}
            </div>
          `
        : nothing}

      ${channelCount > 0
        ? html`
            <div class="section-title">Connected Channels</div>
            <div style="display:flex;flex-wrap:wrap;gap:0.375rem;">
              ${agent.channels!.map(
                (ch) => html`
                  <span class="chip ${ch.connected ? 'chip-ok' : 'chip-muted'}">
                    ${this.getChannelIcon(ch.type)} ${ch.type}
                  </span>
                `,
              )}
            </div>
          `
        : nothing}

      ${toolCount > 0
        ? html`
            <div class="section-title">Available Tools (${toolCount})</div>
            <div style="display:flex;flex-wrap:wrap;gap:0.375rem;">
              ${agent.tools!.slice(0, 20).map(
                (t) => html`<span class="cap-badge" style="font-family:'SF Mono','Fira Code',monospace;font-size:0.6875rem;">${t.name}</span>`,
              )}
              ${toolCount > 20
                ? html`<span class="cap-badge" style="opacity:0.6;">+${toolCount - 20} more</span>`
                : nothing}
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

    const groups = new Map<string, SkillInfo[]>();
    for (const s of agentSkills) {
      const source = (s as unknown as { source?: string }).source ?? 'installed';
      if (!groups.has(source)) groups.set(source, []);
      groups.get(source)!.push(s);
    }

    const sourceLabels: Record<string, { label: string; icon: string }> = {
      workspace: { label: 'Workspace', icon: '📁' },
      'built-in': { label: 'Built-in', icon: '📦' },
      installed: { label: 'Installed', icon: '⬇️' },
      extra: { label: 'Extra', icon: '✨' },
    };

    const enabledCount = agentSkills.filter(s => s.enabled).length;

    return html`
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
        <div>
          <span style="font-size:0.875rem;font-weight:600;">Skills</span>
          <span class="chip chip-muted" style="margin-left:0.5rem;">
            ${enabledCount}/${agentSkills.length} enabled
          </span>
        </div>
        <button class="btn btn-sm" @click=${() => this.loadSkills()}>Refresh</button>
      </div>

      ${[...groups.entries()].map(([source, skills]) => {
        const meta = sourceLabels[source] ?? { label: source, icon: '📄' };
        return html`
          <div style="margin-bottom:1rem;">
            <div class="section-title" style="display:flex;align-items:center;gap:0.375rem;">
              <span>${meta.icon}</span>
              ${meta.label}
              <span class="chip chip-muted" style="font-size:0.5625rem;">${skills.length}</span>
            </div>
            ${skills.map(
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
                    <input
                      type="checkbox"
                      .checked=${s.enabled}
                      @change=${() => this.toggleSkill(s)}
                    />
                    <span class="slider"></span>
                  </label>
                </div>
              `,
            )}
          </div>
        `;
      })}
    `;
  }

  private async toggleSkill(skill: SkillInfo) {
    try {
      await gateway.call('skills.toggle', { id: skill.id, enabled: !skill.enabled });
      skill.enabled = !skill.enabled;
      this.requestUpdate();
    } catch (e) {
      console.error('Failed to toggle skill:', e);
    }
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

    const toolSections: { label: string; icon: string; prefix: string[] }[] = [
      { label: 'Files', icon: '📁', prefix: ['read', 'write', 'edit', 'apply_patch', 'list'] },
      { label: 'Runtime', icon: '⚡', prefix: ['exec', 'process', 'bash', 'shell'] },
      { label: 'Web', icon: '🌐', prefix: ['web_search', 'web_fetch', 'http'] },
      { label: 'Memory', icon: '🧠', prefix: ['memory', 'remember', 'recall', 'store'] },
      { label: 'Sessions', icon: '💬', prefix: ['session', 'chat'] },
      { label: 'Messaging', icon: '📨', prefix: ['message', 'send', 'broadcast'] },
      { label: 'Automation', icon: '⏰', prefix: ['cron', 'schedule', 'gateway'] },
      { label: 'Agents', icon: '🤖', prefix: ['agent'] },
    ];

    const categorized = new Map<string, ToolInfo[]>();
    const uncategorized: ToolInfo[] = [];

    for (const tool of tools) {
      let found = false;
      for (const section of toolSections) {
        if (section.prefix.some(p => tool.name.toLowerCase().startsWith(p))) {
          if (!categorized.has(section.label)) categorized.set(section.label, []);
          categorized.get(section.label)!.push(tool);
          found = true;
          break;
        }
      }
      if (!found) uncategorized.push(tool);
    }

    return html`
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;">
        <div>
          <span style="font-size:0.875rem;font-weight:600;">Tools</span>
          <span class="chip chip-muted" style="margin-left:0.5rem;">${tools.length} available</span>
        </div>
      </div>

      ${toolSections
        .filter(s => categorized.has(s.label))
        .map(s => html`
          <div style="margin-bottom:1.25rem;">
            <div class="section-title" style="display:flex;align-items:center;gap:0.375rem;">
              <span>${s.icon}</span>
              ${s.label}
              <span class="chip chip-muted" style="font-size:0.5625rem;">${categorized.get(s.label)!.length}</span>
            </div>
            ${categorized.get(s.label)!.map(
              (t) => html`
                <div class="tool-row" style="display:flex;align-items:flex-start;gap:0.75rem;">
                  <div style="flex:1;min-width:0;">
                    <div class="tool-name">${t.name}</div>
                    ${t.description
                      ? html`<div class="tool-desc">${t.description}</div>`
                      : nothing}
                  </div>
                </div>
              `,
            )}
          </div>
        `)}

      ${uncategorized.length > 0
        ? html`
            <div style="margin-bottom:1.25rem;">
              <div class="section-title" style="display:flex;align-items:center;gap:0.375rem;">
                <span>🔧</span>
                Other
                <span class="chip chip-muted" style="font-size:0.5625rem;">${uncategorized.length}</span>
              </div>
              ${uncategorized.map(
                (t) => html`
                  <div class="tool-row" style="display:flex;align-items:flex-start;gap:0.75rem;">
                    <div style="flex:1;min-width:0;">
                      <div class="tool-name">${t.name}</div>
                      ${t.description
                        ? html`<div class="tool-desc">${t.description}</div>`
                        : nothing}
                    </div>
                  </div>
                `,
              )}
            </div>
          `
        : nothing}
    `;
  }

  /* ---- render: files tab ---- */

  private renderFiles() {
    if (this.filesLoading) {
      return html`<div class="loading-state">Loading files…</div>`;
    }

    if (this.filesError) {
      return html`
        <div class="error-banner">
          ${this.filesError}
          <button @click=${() => this.loadFiles()}>Retry</button>
        </div>
      `;
    }

    if (this.filesList.length === 0) {
      return html`<div class="empty-tab">No workspace files for this agent.</div>`;
    }

    return html`
      <div class="files-layout">
        <div class="files-sidebar">
          <div class="files-sidebar-header">Files (${this.filesList.length})</div>
          <div class="files-list">
            ${this.filesList.map(
              (f) => html`
                <div
                  class="file-item ${this.activeFile === f.path ? 'active' : ''}"
                  @click=${() => this.loadFileContent(f.path)}
                >
                  <span class="file-icon">📄</span>
                  <span class="file-name" title=${f.path}>${f.name}</span>
                  ${this.isFileDirty(f.path)
                    ? html`<span class="dirty-dot" title="Unsaved changes"></span>`
                    : nothing}
                </div>
              `,
            )}
          </div>
        </div>

        ${this.activeFile
          ? this.renderFileEditor()
          : html`<div class="file-no-selection">Select a file to view</div>`}
      </div>
    `;
  }

  private renderFileEditor() {
    const path = this.activeFile!;
    const draft = this.fileDrafts[path] ?? '';
    const dirty = this.isFileDirty(path);

    return html`
      <div class="file-editor">
        <div class="file-editor-header">
          <span class="filename">${path}</span>
          <div class="file-editor-actions">
            ${dirty
              ? html`
                  <button class="btn btn-sm" @click=${() => this.resetFile(path)} ?disabled=${this.fileSaving}>Reset</button>
                  <button class="btn btn-sm btn-primary" @click=${() => this.saveFile(path)} ?disabled=${this.fileSaving}>
                    ${this.fileSaving ? 'Saving…' : 'Save'}
                  </button>
                `
              : nothing}
          </div>
        </div>
        <textarea
          .value=${draft}
          @input=${(e: Event) => {
            const val = (e.target as HTMLTextAreaElement).value;
            this.fileDrafts = { ...this.fileDrafts, [path]: val };
          }}
          spellcheck="false"
        ></textarea>
      </div>
    `;
  }

  /* ---- render: cron tab ---- */

  private renderCron(agent: AgentInfo) {
    if (this.cronLoading) {
      return html`<div class="loading-state">Loading cron jobs…</div>`;
    }

    const agentJobs = this.cronJobs.filter(
      (j) => !j.agentId || j.agentId === agent.id,
    );

    if (agentJobs.length === 0) {
      return html`<div class="empty-tab">No cron jobs associated with this agent.</div>`;
    }

    return html`
      ${agentJobs.map(
        (j) => html`
          <div class="cron-job-card">
            <span style="font-size:1.25rem;">⏰</span>
            <div class="cron-info">
              <div class="cron-name">${j.name ?? j.id}</div>
              <div class="cron-schedule">${j.schedule}</div>
              ${j.description
                ? html`<div class="cron-meta">${j.description}</div>`
                : nothing}
              ${j.lastRun
                ? html`<div class="cron-meta">Last run: ${j.lastRun}</div>`
                : nothing}
            </div>
            <span class="chip ${j.enabled ? 'chip-ok' : 'chip-muted'}">
              ${j.enabled ? 'Active' : 'Paused'}
            </span>
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
