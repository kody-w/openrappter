/**
 * Configuration View Component
 * Raw config editor with save/reload — loads actual config from gateway.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import { createConfigState, loadConfig, saveConfig, updateConfigRaw, type ConfigState } from '../services/config.js';

@customElement('openrappter-config')
export class OpenRappterConfig extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem 2rem;
      height: 100%;
      display: flex;
      flex-direction: column;
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
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }

    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex: 1;
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
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .btn.primary:hover { background: var(--accent-hover); }

    .btn.danger {
      border-color: var(--error);
      color: var(--error);
    }

    .dirty-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      background: rgba(245, 158, 11, 0.2);
      color: var(--warning);
      font-weight: 500;
    }

    .format-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      font-family: monospace;
    }

    .editor-wrap {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    textarea.config-editor {
      flex: 1;
      width: 100%;
      min-height: 400px;
      padding: 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      color: var(--text-primary);
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.8125rem;
      line-height: 1.6;
      resize: vertical;
      tab-size: 2;
    }

    textarea.config-editor:focus {
      outline: none;
      border-color: var(--accent);
    }

    .callout {
      padding: 0.625rem 0.75rem;
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      margin-bottom: 1rem;
    }

    .callout.danger {
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
    }

    .callout.success {
      background: rgba(16, 185, 129, 0.15);
      color: #6ee7b7;
    }

    .callout.info {
      background: rgba(59, 130, 246, 0.15);
      color: #93c5fd;
    }

    .env-section {
      margin-top: 1.5rem;
    }

    .env-section h3 {
      font-size: 0.9375rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
    }

    .env-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.5rem;
    }

    .env-item {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      font-size: 0.8125rem;
    }

    .env-key {
      font-family: monospace;
      color: var(--accent);
    }

    .env-value {
      color: var(--text-secondary);
    }

    .loading {
      display: flex;
      justify-content: center;
      padding: 2rem;
      color: var(--text-secondary);
    }
  `;

  @state() private configState: ConfigState = createConfigState();
  @state() private originalRaw = '';
  @state() private saveMessage: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.configState.client = gateway;
    this.doLoad();
  }

  private async doLoad() {
    await loadConfig(this.configState);
    this.originalRaw = this.configState.raw;
    this.requestUpdate();
  }

  private async handleSave() {
    const ok = await saveConfig(this.configState);
    if (ok) {
      this.originalRaw = this.configState.raw;
      this.saveMessage = 'Configuration saved successfully.';
    } else {
      this.saveMessage = null;
    }
    this.requestUpdate();
    if (ok) setTimeout(() => { this.saveMessage = null; this.requestUpdate(); }, 3000);
  }

  private handleReset() {
    updateConfigRaw(this.configState, this.originalRaw);
    this.configState.dirty = false;
    this.configState.error = null;
    this.requestUpdate();
  }

  private handleInput(e: Event) {
    const val = (e.target as HTMLTextAreaElement).value;
    updateConfigRaw(this.configState, val);
    this.requestUpdate();
  }

  private handleKeyDown(e: KeyboardEvent) {
    // Cmd/Ctrl+S to save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      this.handleSave();
    }
    // Tab inserts spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      ta.value = val.substring(0, start) + '  ' + val.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      updateConfigRaw(this.configState, ta.value);
      this.requestUpdate();
    }
  }

  render() {
    if (this.configState.loading) {
      return html`<div class="loading">Loading configuration…</div>`;
    }

    return html`
      <div class="page-header">
        <h2>Configuration</h2>
        <p>Edit your OpenRappter configuration. Press Cmd+S to save.</p>
      </div>

      ${this.configState.error
        ? html`<div class="callout danger">${this.configState.error}</div>`
        : nothing}

      ${this.saveMessage
        ? html`<div class="callout success">${this.saveMessage}</div>`
        : nothing}

      <div class="toolbar">
        <div class="toolbar-left">
          <span class="format-badge">${this.configState.format.toUpperCase()}</span>
          ${this.configState.dirty
            ? html`<span class="dirty-badge">Unsaved changes</span>`
            : nothing}
        </div>
        <button class="btn" @click=${this.doLoad}
          ?disabled=${this.configState.saving}>Reload</button>
        <button class="btn" @click=${this.handleReset}
          ?disabled=${!this.configState.dirty || this.configState.saving}>Reset</button>
        <button class="btn primary" @click=${this.handleSave}
          ?disabled=${!this.configState.dirty || this.configState.saving}>
          ${this.configState.saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div class="editor-wrap">
        <textarea
          class="config-editor"
          .value=${this.configState.raw}
          @input=${this.handleInput}
          @keydown=${this.handleKeyDown}
          ?disabled=${this.configState.saving}
          spellcheck="false"
          placeholder="No configuration loaded. Click Reload or check gateway connection."
        ></textarea>
      </div>

      <div class="env-section">
        <h3>Environment Variables</h3>
        <div class="callout info">These are set in your shell or .env file and cannot be edited here.</div>
        <div class="env-grid">
          <div class="env-item">
            <span class="env-key">OPENRAPPTER_PORT</span>
            <span class="env-value">18790</span>
          </div>
          <div class="env-item">
            <span class="env-key">TELEGRAM_BOT_TOKEN</span>
            <span class="env-value">••••••••</span>
          </div>
          <div class="env-item">
            <span class="env-key">DISCORD_TOKEN</span>
            <span class="env-value">not set</span>
          </div>
          <div class="env-item">
            <span class="env-key">OPENRAPPTER_MODEL</span>
            <span class="env-value">default</span>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-config': OpenRappterConfig;
  }
}
