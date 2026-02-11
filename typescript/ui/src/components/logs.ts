/**
 * Logs View Component
 * View system logs and debug output
 */

import { LitElement, html, css } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import { createLogsState, addLogEntry, clearLogs as clearLogsState, toggleLevel, getFilteredLogs, subscribeToLogs, type LogsState } from '../services/logs.js';
import type { LogEntry } from '../types.js';

@customElement('openrappter-logs')
export class OpenRappterLogs extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--border);
    }

    .header h2 {
      font-size: 1.125rem;
      font-weight: 600;
    }

    .header-actions {
      display: flex;
      gap: 0.75rem;
      align-items: center;
    }

    .filter-group {
      display: flex;
      gap: 0.25rem;
    }

    .filter-btn {
      padding: 0.375rem 0.75rem;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      border-radius: 0.25rem;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .filter-btn:hover {
      background: var(--bg-secondary);
    }

    .filter-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
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

    button.secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }

    .logs-container {
      flex: 1;
      overflow: auto;
      padding: 0.5rem;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.8125rem;
      line-height: 1.5;
      background: #0d0d0d;
    }

    .log-entry {
      display: flex;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
    }

    .log-entry:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .log-timestamp {
      color: #666;
      min-width: 90px;
      flex-shrink: 0;
    }

    .log-level {
      min-width: 50px;
      flex-shrink: 0;
      font-weight: 600;
    }

    .log-level.debug {
      color: #888;
    }

    .log-level.info {
      color: #3b82f6;
    }

    .log-level.warn {
      color: #f59e0b;
    }

    .log-level.error {
      color: #ef4444;
    }

    .log-source {
      color: #a855f7;
      min-width: 100px;
      flex-shrink: 0;
    }

    .log-message {
      color: #e0e0e0;
      flex: 1;
      word-break: break-word;
    }

    .log-data {
      color: #666;
      margin-left: 240px;
      white-space: pre-wrap;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-secondary);
      gap: 0.5rem;
    }

    .auto-scroll {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
    }

    .auto-scroll input {
      width: 16px;
      height: 16px;
    }
  `;

  @state()
  private logsState: LogsState = createLogsState();

  @state()
  private autoScroll = true;

  @query('.logs-container')
  private logsContainer!: HTMLDivElement;

  connectedCallback() {
    super.connectedCallback();
    this.logsState.client = gateway;
    subscribeToLogs(this.logsState);
    // No mock data — real logs come from gateway events
  }

  private handleToggleLevel(level: string) {
    toggleLevel(this.logsState, level);
    this.requestUpdate();
  }

  private handleClearLogs() {
    clearLogsState(this.logsState);
    this.requestUpdate();
  }

  private formatTime(timestamp: string): string {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  private get filteredLogs(): LogEntry[] {
    return getFilteredLogs(this.logsState);
  }

  render() {
    return html`
      <div class="header">
        <h2>System Logs</h2>
        <div class="header-actions">
          <div class="filter-group">
            <button
              class="filter-btn ${this.logsState.levelFilter.has('debug') ? 'active' : ''}"
              @click=${() => this.handleToggleLevel('debug')}
            >
              Debug
            </button>
            <button
              class="filter-btn ${this.logsState.levelFilter.has('info') ? 'active' : ''}"
              @click=${() => this.handleToggleLevel('info')}
            >
              Info
            </button>
            <button
              class="filter-btn ${this.logsState.levelFilter.has('warn') ? 'active' : ''}"
              @click=${() => this.handleToggleLevel('warn')}
            >
              Warn
            </button>
            <button
              class="filter-btn ${this.logsState.levelFilter.has('error') ? 'active' : ''}"
              @click=${() => this.handleToggleLevel('error')}
            >
              Error
            </button>
          </div>

          <label class="auto-scroll">
            <input
              type="checkbox"
              ?checked=${this.autoScroll}
              @change=${(e: Event) => {
                this.autoScroll = (e.target as HTMLInputElement).checked;
              }}
            />
            Auto-scroll
          </label>

          <button class="secondary" @click=${this.handleClearLogs}>Clear</button>
        </div>
      </div>

      <div class="logs-container">
        ${this.filteredLogs.length === 0
          ? html`
              <div class="empty-state">
                <span>No logs to display</span>
              </div>
            `
          : this.filteredLogs.map(
              (log) => html`
                <div class="log-entry">
                  <span class="log-timestamp">${this.formatTime(log.timestamp)}</span>
                  <span class="log-level ${log.level}">${log.level.toUpperCase()}</span>
                  <span class="log-source">[${log.source}]</span>
                  <span class="log-message">${log.message}</span>
                </div>
                ${log.data
                  ? html`<div class="log-data">${JSON.stringify(log.data, null, 2)}</div>`
                  : ''}
              `
            )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-logs': OpenRappterLogs;
  }
}
