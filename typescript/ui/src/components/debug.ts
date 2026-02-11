/**
 * Debug View Component
 * RPC test console, status/health cards, and real-time event log
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import type { EventCallback } from '../services/gateway.js';

interface EventLogEntry {
  timestamp: string;
  event: string;
  payload: string;
}

@customElement('openrappter-debug')
export class OpenRappterDebug extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: auto;
      padding: 1.5rem;
      gap: 1.5rem;
    }

    .cards-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
    }

    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      overflow: hidden;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      font-size: 0.9375rem;
    }

    .card-body {
      padding: 1rem 1.25rem;
    }

    pre {
      margin: 0;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.8125rem;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-primary);
      background: var(--bg-tertiary);
      padding: 0.75rem;
      border-radius: 0.375rem;
      max-height: 240px;
      overflow: auto;
    }

    .health-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0;
      font-size: 0.875rem;
    }

    .health-pass {
      color: var(--accent);
    }

    .health-fail {
      color: var(--error);
    }

    .rpc-form {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    label {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-secondary);
    }

    input[type="text"],
    textarea {
      width: 100%;
      padding: 0.5rem 0.75rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.8125rem;
      box-sizing: border-box;
    }

    input[type="text"]:focus,
    textarea:focus {
      outline: none;
      border-color: var(--accent);
    }

    textarea {
      min-height: 60px;
      resize: vertical;
    }

    button {
      padding: 0.5rem 1rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      cursor: pointer;
      font-weight: 500;
    }

    button:hover {
      background: var(--accent-hover);
    }

    button.secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }

    button.secondary:hover {
      background: var(--bg-secondary);
    }

    .rpc-actions {
      display: flex;
      gap: 0.5rem;
    }

    .rpc-result {
      margin-top: 0.5rem;
    }

    .rpc-error {
      color: var(--error);
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.8125rem;
      background: var(--bg-tertiary);
      padding: 0.75rem;
      border-radius: 0.375rem;
      border: 1px solid var(--error);
    }

    .event-log {
      max-height: 400px;
      overflow: auto;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.8125rem;
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
    }

    .event-entry {
      display: flex;
      gap: 0.75rem;
      padding: 0.375rem 0.75rem;
      border-bottom: 1px solid var(--border);
    }

    .event-entry:last-child {
      border-bottom: none;
    }

    .event-entry:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    .event-time {
      color: var(--text-secondary);
      flex-shrink: 0;
      min-width: 75px;
    }

    .event-type {
      color: var(--accent);
      flex-shrink: 0;
      min-width: 120px;
      font-weight: 600;
    }

    .event-payload {
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .empty-state {
      padding: 2rem;
      text-align: center;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    .loading {
      color: var(--text-secondary);
      font-size: 0.875rem;
      padding: 0.5rem 0;
    }
  `;

  @state() private statusJson = '';
  @state() private statusLoading = false;
  @state() private healthResults: { name: string; pass: boolean; detail?: string }[] = [];
  @state() private healthLoading = false;
  @state() private rpcMethod = '';
  @state() private rpcParams = '{}';
  @state() private rpcResult = '';
  @state() private rpcError = '';
  @state() private rpcLoading = false;
  @state() private eventLog: EventLogEntry[] = [];
  @state() private modelsJson = '';
  @state() private modelsLoading = false;
  @state() private heartbeatJson = '';

  private eventHandler: EventCallback = (data) => {
    const d = data as { event?: string; payload?: unknown };
    if (d.event === 'heartbeat') {
      this.heartbeatJson = JSON.stringify(d.payload ?? {}, null, 2);
    }
    const entry: EventLogEntry = {
      timestamp: new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      event: d.event ?? 'unknown',
      payload: JSON.stringify(d.payload ?? {}).slice(0, 200),
    };
    this.eventLog = [entry, ...this.eventLog].slice(0, 100);
  };

  connectedCallback() {
    super.connectedCallback();
    this.fetchStatus();
    this.fetchHealth();
    this.fetchModels();
    gateway.on('*', this.eventHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    gateway.off('*', this.eventHandler);
  }

  private async fetchStatus() {
    this.statusLoading = true;
    try {
      const result = await gateway.call('status');
      this.statusJson = JSON.stringify(result, null, 2);
    } catch (e) {
      this.statusJson = `Error: ${(e as Error).message}`;
    }
    this.statusLoading = false;
  }

  private async fetchHealth() {
    this.healthLoading = true;
    try {
      const result = await gateway.call<Record<string, unknown>>('health');
      if (result && typeof result === 'object') {
        this.healthResults = Object.entries(result).map(([name, val]) => {
          if (typeof val === 'object' && val !== null) {
            const v = val as Record<string, unknown>;
            return { name, pass: v.status === 'ok' || v.pass === true, detail: v.message as string | undefined };
          }
          return { name, pass: !!val };
        });
      } else {
        this.healthResults = [{ name: 'health', pass: true, detail: JSON.stringify(result) }];
      }
    } catch (e) {
      this.healthResults = [{ name: 'health', pass: false, detail: (e as Error).message }];
    }
    this.healthLoading = false;
  }

  private async fetchModels() {
    this.modelsLoading = true;
    try {
      const result = await gateway.call('models.list');
      this.modelsJson = JSON.stringify(result, null, 2);
    } catch {
      this.modelsJson = '[]';
    }
    this.modelsLoading = false;
  }

  private async handleRpcCall() {
    this.rpcResult = '';
    this.rpcError = '';
    if (!this.rpcMethod.trim()) {
      this.rpcError = 'Method name is required';
      return;
    }

    let params: unknown;
    try {
      params = JSON.parse(this.rpcParams);
    } catch {
      this.rpcError = 'Invalid JSON params';
      return;
    }

    this.rpcLoading = true;
    try {
      const result = await gateway.call(this.rpcMethod.trim(), params as Record<string, unknown>);
      this.rpcResult = JSON.stringify(result, null, 2);
    } catch (e) {
      this.rpcError = (e as Error).message;
    }
    this.rpcLoading = false;
  }

  private clearEventLog() {
    this.eventLog = [];
  }

  render() {
    return html`
      <div class="cards-row">
        <div class="card">
          <div class="card-header">
            <span>📊 Status</span>
            <button class="secondary" @click=${this.fetchStatus}>Refresh</button>
          </div>
          <div class="card-body">
            ${this.statusLoading
              ? html`<div class="loading">Loading…</div>`
              : html`<pre>${this.statusJson || 'No data'}</pre>`}
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <span>🏥 Health</span>
            <button class="secondary" @click=${this.fetchHealth}>Refresh</button>
          </div>
          <div class="card-body">
            ${this.healthLoading
              ? html`<div class="loading">Loading…</div>`
              : this.healthResults.length === 0
                ? html`<div class="loading">No health data</div>`
                : this.healthResults.map(
                    (h) => html`
                      <div class="health-item">
                        <span class=${h.pass ? 'health-pass' : 'health-fail'}>
                          ${h.pass ? '✅' : '❌'}
                        </span>
                        <span>${h.name}</span>
                        ${h.detail ? html`<span style="color: var(--text-secondary)">— ${h.detail}</span>` : ''}
                      </div>
                    `
                  )}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">🧪 RPC Test Console</div>
        <div class="card-body">
          <div class="rpc-form">
            <div>
              <label>Method</label>
              <input
                type="text"
                placeholder="e.g. agents.list, channels.list"
                .value=${this.rpcMethod}
                @input=${(e: InputEvent) => {
                  this.rpcMethod = (e.target as HTMLInputElement).value;
                }}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') this.handleRpcCall();
                }}
              />
            </div>
            <div>
              <label>Params (JSON)</label>
              <textarea
                placeholder="{}"
                .value=${this.rpcParams}
                @input=${(e: InputEvent) => {
                  this.rpcParams = (e.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
            </div>
            <div class="rpc-actions">
              <button @click=${this.handleRpcCall} ?disabled=${this.rpcLoading}>
                ${this.rpcLoading ? 'Calling…' : 'Call'}
              </button>
            </div>
            ${this.rpcResult
              ? html`<div class="rpc-result"><pre>${this.rpcResult}</pre></div>`
              : ''}
            ${this.rpcError
              ? html`<div class="rpc-error">${this.rpcError}</div>`
              : ''}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span>📡 Event Log (${this.eventLog.length})</span>
          <button class="secondary" @click=${this.clearEventLog}>Clear</button>
        </div>
        <div class="card-body" style="padding: 0;">
          ${this.eventLog.length === 0
            ? html`<div class="empty-state">No events received yet. Events will appear here in real time.</div>`
            : html`
                <div class="event-log">
                  ${this.eventLog.map(
                    (entry) => html`
                      <div class="event-entry">
                        <span class="event-time">${entry.timestamp}</span>
                        <span class="event-type">${entry.event}</span>
                        <span class="event-payload">${entry.payload}</span>
                      </div>
                    `
                  )}
                </div>
              `}
        </div>
      </div>

      <div class="cards-row">
        <div class="card">
          <div class="card-header">
            <span>🧊 Models</span>
            <button class="secondary" @click=${this.fetchModels}>Refresh</button>
          </div>
          <div class="card-body">
            ${this.modelsLoading
              ? html`<div class="loading">Loading…</div>`
              : html`<pre>${this.modelsJson || '[]'}</pre>`}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><span>💓 Last Heartbeat</span></div>
          <div class="card-body">
            ${this.heartbeatJson
              ? html`<pre>${this.heartbeatJson}</pre>`
              : html`<div class="loading">Waiting for heartbeat…</div>`}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-debug': OpenRappterDebug;
  }
}
