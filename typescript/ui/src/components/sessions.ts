/**
 * Sessions View Component
 * Displays chat sessions with search/filter and token metadata
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface SessionSummary {
  id: string;
  key?: string;
  agentId: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  totalTokens?: number;
  contextTokens?: number;
  reasoningLevel?: string;
}

@customElement('openrappter-sessions')
export class OpenRappterSessions extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    .header-left h2 {
      font-size: 1.125rem;
      font-weight: 600;
      margin: 0;
    }

    .header-left .sub {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.25rem;
    }

    .search-input {
      flex: 1;
      max-width: 320px;
      padding: 0.5rem 0.75rem;
      background: var(--bg-tertiary);
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
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      cursor: pointer;
    }

    .btn:hover { background: var(--bg-secondary); }
    .btn:disabled { opacity: 0.5; cursor: default; }
    .btn.primary { background: var(--accent); color: white; border-color: var(--accent); }
    .btn.primary:hover { opacity: 0.85; }
    .btn.danger { background: var(--error); color: white; border-color: var(--error); }

    .count-badge {
      font-size: 0.75rem;
      color: var(--text-secondary);
      background: var(--bg-tertiary);
      padding: 0.25rem 0.625rem;
      border-radius: 0.25rem;
    }

    .sessions-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      overflow: hidden;
      border: 1px solid var(--border);
    }

    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    th {
      background: var(--bg-tertiary);
      font-weight: 600;
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
    }

    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg-tertiary); }

    .session-id {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.8125rem;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .agent-badge {
      display: inline-block;
      padding: 0.1875rem 0.5rem;
      background: rgba(16, 185, 129, 0.15);
      color: var(--accent);
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .message-count { font-weight: 600; }

    .token-info {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .reasoning-chip {
      display: inline-block;
      padding: 0.125rem 0.375rem;
      background: rgba(139, 92, 246, 0.15);
      color: #a78bfa;
      border-radius: 0.1875rem;
      font-size: 0.6875rem;
      font-weight: 500;
    }

    .timestamp {
      font-size: 0.8125rem;
      color: var(--text-secondary);
    }

    .actions {
      display: flex;
      gap: 0.375rem;
    }

    .actions .btn {
      padding: 0.25rem 0.625rem;
      font-size: 0.75rem;
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }

    .muted { color: var(--text-secondary); font-size: 0.8125rem; }
  `;

  @state() private sessions: SessionSummary[] = [];
  @state() private loading = true;
  @state() private searchQuery = '';

  connectedCallback() {
    super.connectedCallback();
    this.loadSessions();
  }

  private async loadSessions() {
    this.loading = true;
    try {
      this.sessions = await gateway.call<SessionSummary[]>('chat.list');
    } catch {
      this.sessions = [];
    }
    this.loading = false;
  }

  private async deleteSession(id: string) {
    if (!confirm('Delete this session? This cannot be undone.')) return;
    try {
      await gateway.call('chat.delete', { sessionId: id });
      this.sessions = this.sessions.filter((s) => s.id !== id);
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  }

  private formatDate(timestamp: string): string {
    return new Date(timestamp).toLocaleString();
  }

  private formatAgo(timestamp: string): string {
    const ms = Date.now() - new Date(timestamp).getTime();
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.round(hr / 24);
    return `${days}d ago`;
  }

  private formatTokens(s: SessionSummary): string {
    if (s.totalTokens == null) return '-';
    const ctx = s.contextTokens ?? 0;
    return ctx ? `${s.totalTokens} / ${ctx}` : String(s.totalTokens);
  }

  private get filteredSessions(): SessionSummary[] {
    if (!this.searchQuery.trim()) return this.sessions;
    const q = this.searchQuery.toLowerCase();
    return this.sessions.filter((s) =>
      [s.id, s.key, s.agentId].join(' ').toLowerCase().includes(q),
    );
  }

  private viewSession(id: string) {
    this.dispatchEvent(
      new CustomEvent('navigate', { bubbles: true, composed: true, detail: { view: 'chat', sessionId: id } }),
    );
  }

  render() {
    if (this.loading) {
      return html`<div class="muted">Loading sessions…</div>`;
    }

    const filtered = this.filteredSessions;

    return html`
      <div class="header">
        <div class="header-left">
          <h2>Chat Sessions</h2>
          <div class="sub">${this.sessions.length} session${this.sessions.length !== 1 ? 's' : ''} stored.</div>
        </div>
        <button class="btn" @click=${this.loadSessions} ?disabled=${this.loading}>
          ${this.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div class="toolbar">
        <input
          class="search-input"
          placeholder="Search sessions…"
          .value=${this.searchQuery}
          @input=${(e: Event) => (this.searchQuery = (e.target as HTMLInputElement).value)}
        />
        ${filtered.length !== this.sessions.length
          ? html`<span class="count-badge">${filtered.length} shown</span>`
          : nothing}
      </div>

      ${filtered.length === 0
        ? html`
            <div class="empty-state">
              ${this.searchQuery
                ? html`<p>No sessions match "${this.searchQuery}".</p>`
                : html`<p>No active sessions.</p><p class="muted">Start a conversation in Chat to create one.</p>`}
            </div>
          `
        : html`
            <table class="sessions-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Agent</th>
                  <th>Messages</th>
                  <th>Tokens</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map(
                  (s) => html`
                    <tr>
                      <td class="session-id" title=${s.id}>${s.key ?? s.id}</td>
                      <td>
                        <span class="agent-badge">${s.agentId}</span>
                        ${s.reasoningLevel && s.reasoningLevel !== 'off'
                          ? html`<span class="reasoning-chip">${s.reasoningLevel}</span>`
                          : nothing}
                      </td>
                      <td class="message-count">${s.messageCount}</td>
                      <td class="token-info">${this.formatTokens(s)}</td>
                      <td class="timestamp" title=${this.formatDate(s.updatedAt)}>
                        ${this.formatAgo(s.updatedAt)}
                      </td>
                      <td class="actions">
                        <button class="btn" @click=${() => this.viewSession(s.id)}>View</button>
                        <button class="btn danger" @click=${() => this.deleteSession(s.id)}>Delete</button>
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-sessions': OpenRappterSessions;
  }
}
