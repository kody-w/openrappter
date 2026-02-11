/**
 * Sessions View Component
 * Displays chat sessions and their history
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface SessionSummary {
  id: string;
  agentId: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
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
      margin-bottom: 1.5rem;
    }

    .header h2 {
      font-size: 1.125rem;
      font-weight: 600;
    }

    button {
      padding: 0.5rem 1rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      cursor: pointer;
    }

    button:hover {
      background: var(--accent-hover);
    }

    .sessions-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      overflow: hidden;
    }

    th,
    td {
      padding: 0.875rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    th {
      background: var(--bg-tertiary);
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background: var(--bg-tertiary);
    }

    .session-id {
      font-family: monospace;
      font-size: 0.875rem;
    }

    .agent-badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      background: var(--accent);
      color: white;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .message-count {
      font-weight: 600;
    }

    .actions button {
      padding: 0.375rem 0.75rem;
      margin-right: 0.5rem;
    }

    .actions button.danger {
      background: var(--error);
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }
  `;

  @state()
  private sessions: SessionSummary[] = [];

  @state()
  private loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.loadSessions();
  }

  private async loadSessions() {
    this.loading = true;
    try {
      this.sessions = await gateway.call<SessionSummary[]>('chat.list');
    } catch (error) {
      console.error('Failed to load sessions:', error);
      this.sessions = [];
    }
    this.loading = false;
  }

  private async deleteSession(id: string) {
    if (!confirm('Are you sure you want to delete this session?')) return;

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

  render() {
    if (this.loading) {
      return html`<div class="loading">Loading sessions...</div>`;
    }

    return html`
      <div class="header">
        <h2>Chat Sessions</h2>
        <button @click=${this.loadSessions}>Refresh</button>
      </div>

      ${this.sessions.length === 0
        ? html`
            <div class="empty-state">
              <p>No active sessions.</p>
              <p>Start a conversation in the Chat view to create a session.</p>
            </div>
          `
        : html`
            <table class="sessions-table">
              <thead>
                <tr>
                  <th>Session ID</th>
                  <th>Agent</th>
                  <th>Messages</th>
                  <th>Created</th>
                  <th>Last Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${this.sessions.map(
                  (session) => html`
                    <tr>
                      <td class="session-id">${session.id}</td>
                      <td><span class="agent-badge">${session.agentId}</span></td>
                      <td class="message-count">${session.messageCount}</td>
                      <td>${this.formatDate(session.createdAt)}</td>
                      <td>${this.formatDate(session.updatedAt)}</td>
                      <td class="actions">
                        <button>View</button>
                        <button class="danger" @click=${() => this.deleteSession(session.id)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  `
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
