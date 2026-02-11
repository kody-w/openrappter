/**
 * Configuration View Component
 * Dual-mode config editor (Form + Raw) with save/reload.
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import { createConfigState, loadConfig, saveConfig, updateConfigRaw, type ConfigState } from '../services/config.js';
import * as YAML from 'yaml';

// ── Section metadata ──

const SECTION_META: Record<string, { label: string; description: string }> = {
  env:       { label: 'Environment Variables', description: 'Environment variables passed to the gateway' },
  agents:    { label: 'Agents',    description: 'Agent configurations, models, and identities' },
  auth:      { label: 'Authentication', description: 'API keys and authentication profiles' },
  channels:  { label: 'Channels',  description: 'Messaging channels (Telegram, Discord, WhatsApp)' },
  tools:     { label: 'Tools',     description: 'Tool configurations' },
  gateway:   { label: 'Gateway',   description: 'Gateway server settings (port, auth)' },
  skills:    { label: 'Skills',    description: 'Skill packs and capabilities' },
  logging:   { label: 'Logging',   description: 'Log levels and output configuration' },
  models:    { label: 'Models',    description: 'AI model configurations and providers' },
  cron:      { label: 'Cron',      description: 'Scheduled tasks and automation' },
};

// ── SVG icons (Lucide-style, 20×20 stroke currentColor) ──

const sectionIcons: Record<string, TemplateResult> = {
  env: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  agents: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path><circle cx="8" cy="14" r="1"></circle><circle cx="16" cy="14" r="1"></circle></svg>`,
  auth: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
  channels: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
  tools: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`,
  gateway: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  skills: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
  logging: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`,
  models: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,
  cron: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  default: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
};

function getSectionIcon(key: string): TemplateResult {
  return sectionIcons[key] ?? sectionIcons.default;
}

type ViewMode = 'form' | 'raw';

// ── Helpers ──

function parseConfig(raw: string, format: 'yaml' | 'json'): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    if (format === 'json') return JSON.parse(raw);
    return YAML.parse(raw) as Record<string, unknown>;
  } catch { return null; }
}

function serializeConfig(obj: Record<string, unknown>, format: 'yaml' | 'json'): string {
  if (format === 'json') return JSON.stringify(obj, null, 2);
  return YAML.stringify(obj, { indent: 2 });
}

function matchesSearch(key: string, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (key.toLowerCase().includes(q)) return true;
  const meta = SECTION_META[key];
  if (meta) {
    if (meta.label.toLowerCase().includes(q)) return true;
    if (meta.description.toLowerCase().includes(q)) return true;
  }
  return false;
}

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

    .page-header { margin-bottom: 1rem; }
    .page-header h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
    .page-header p { font-size: 0.875rem; color: var(--text-secondary); }

    /* ── Toolbar ── */
    .toolbar {
      display: flex; align-items: center; gap: 0.5rem;
      margin-bottom: 1rem; flex-wrap: wrap;
    }
    .toolbar-left { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
    .toolbar-right { display: flex; align-items: center; gap: 0.5rem; }

    .btn {
      padding: 0.5rem 1rem; border: 1px solid var(--border); border-radius: 0.375rem;
      background: var(--bg-tertiary); color: var(--text-primary); font-size: 0.8125rem;
      cursor: pointer; transition: all 0.15s ease; white-space: nowrap;
    }
    .btn:hover { background: var(--border); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: white; }
    .btn.primary:hover { background: var(--accent-hover); }

    /* Mode toggle group */
    .mode-toggle { display: flex; border: 1px solid var(--border); border-radius: 0.375rem; overflow: hidden; }
    .mode-toggle button {
      padding: 0.375rem 0.75rem; border: none; background: var(--bg-tertiary);
      color: var(--text-secondary); font-size: 0.8125rem; cursor: pointer;
      transition: all 0.15s ease;
    }
    .mode-toggle button:not(:last-child) { border-right: 1px solid var(--border); }
    .mode-toggle button:hover { background: var(--border); }
    .mode-toggle button.active { background: var(--accent); color: white; }

    .dirty-badge {
      font-size: 0.75rem; padding: 0.25rem 0.5rem; border-radius: 0.25rem;
      background: rgba(245, 158, 11, 0.2); color: var(--warning); font-weight: 500;
    }
    .format-badge {
      font-size: 0.75rem; padding: 0.25rem 0.5rem; border-radius: 0.25rem;
      background: var(--bg-tertiary); color: var(--text-secondary); font-family: monospace;
    }

    /* ── Search ── */
    .search-wrap {
      position: relative; display: flex; align-items: center;
    }
    .search-wrap svg {
      position: absolute; left: 0.5rem; width: 14px; height: 14px;
      color: var(--text-secondary); pointer-events: none;
    }
    .search-input {
      padding: 0.375rem 0.5rem 0.375rem 1.75rem; border: 1px solid var(--border);
      border-radius: 0.375rem; background: var(--bg-secondary); color: var(--text-primary);
      font-size: 0.8125rem; width: 180px; outline: none;
    }
    .search-input:focus { border-color: var(--accent); }
    .search-input::placeholder { color: var(--text-secondary); }

    /* ── Raw editor ── */
    .editor-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    textarea.config-editor {
      flex: 1; width: 100%; min-height: 400px; padding: 1rem;
      background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 0.5rem;
      color: var(--text-primary); font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.8125rem; line-height: 1.6; resize: vertical; tab-size: 2;
    }
    textarea.config-editor:focus { outline: none; border-color: var(--accent); }

    /* ── Callouts ── */
    .callout {
      padding: 0.625rem 0.75rem; border-radius: 0.375rem; font-size: 0.8125rem; margin-bottom: 1rem;
    }
    .callout.danger { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }
    .callout.success { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; }

    .loading { display: flex; justify-content: center; padding: 2rem; color: var(--text-secondary); }

    /* ── Form mode ── */
    .form-wrap { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0.75rem; }

    .config-section-card {
      border: 1px solid var(--border); border-radius: 0.5rem;
      background: var(--bg-secondary); overflow: hidden;
    }
    .config-section-card__header {
      display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem;
      cursor: pointer; user-select: none; transition: background 0.15s ease;
    }
    .config-section-card__header:hover { background: var(--bg-tertiary); }
    .config-section-card__icon {
      width: 20px; height: 20px; flex-shrink: 0; color: var(--accent);
      display: flex; align-items: center; justify-content: center;
    }
    .config-section-card__icon svg { width: 20px; height: 20px; }
    .config-section-card__titles { flex: 1; min-width: 0; }
    .config-section-card__title { font-size: 0.875rem; font-weight: 600; margin: 0; }
    .config-section-card__desc { font-size: 0.75rem; color: var(--text-secondary); margin: 0.125rem 0 0; }
    .config-section-card__chevron {
      width: 16px; height: 16px; color: var(--text-secondary);
      transition: transform 0.2s ease; flex-shrink: 0;
    }
    .config-section-card__chevron.expanded { transform: rotate(90deg); }
    .config-section-card__content {
      padding: 0 1rem 1rem; display: flex; flex-direction: column; gap: 0.5rem;
    }

    /* ── Form fields ── */
    .field {
      display: flex; flex-direction: column; gap: 0.25rem;
    }
    .field span {
      font-size: 0.75rem; font-weight: 500; color: var(--text-secondary); font-family: monospace;
    }
    .field input, .field select {
      padding: 0.375rem 0.5rem; border: 1px solid var(--border); border-radius: 0.375rem;
      background: var(--bg-tertiary); color: var(--text-primary); font-size: 0.8125rem; outline: none;
    }
    .field input:focus, .field select:focus { border-color: var(--accent); }
    .field input[type="checkbox"] { width: auto; margin: 0; }
    .field-row {
      display: flex; align-items: center; gap: 0.5rem;
    }
    .field-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }
    .field-row span { margin: 0; }

    .field pre {
      margin: 0; padding: 0.5rem; background: var(--bg-tertiary); border: 1px solid var(--border);
      border-radius: 0.375rem; font-size: 0.75rem; line-height: 1.5; overflow-x: auto;
      color: var(--text-primary); font-family: 'SF Mono', 'Fira Code', monospace;
    }

    /* Array items */
    .array-items { display: flex; flex-direction: column; gap: 0.25rem; }
    .array-item {
      display: flex; align-items: center; gap: 0.375rem;
    }
    .array-item input { flex: 1; }
    .array-item .remove-btn {
      padding: 0.25rem; border: none; background: none; color: var(--text-secondary);
      cursor: pointer; font-size: 1rem; line-height: 1;
    }
    .array-item .remove-btn:hover { color: #ef4444; }
    .add-btn {
      padding: 0.25rem 0.5rem; border: 1px dashed var(--border); border-radius: 0.25rem;
      background: none; color: var(--text-secondary); font-size: 0.75rem;
      cursor: pointer; align-self: flex-start; margin-top: 0.25rem;
    }
    .add-btn:hover { border-color: var(--accent); color: var(--accent); }

    /* Key-value pairs */
    .kv-row {
      display: flex; gap: 0.375rem; align-items: center;
    }
    .kv-row input { flex: 1; }
    .kv-row .remove-btn {
      padding: 0.25rem; border: none; background: none; color: var(--text-secondary);
      cursor: pointer; font-size: 1rem; line-height: 1;
    }
    .kv-row .remove-btn:hover { color: #ef4444; }

    /* Empty state */
    .config-empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 3rem; color: var(--text-secondary); gap: 0.75rem; flex: 1;
    }
    .config-empty__icon { width: 32px; height: 32px; opacity: 0.5; }
    .config-empty__icon svg { width: 32px; height: 32px; }
    .config-empty__text { font-size: 0.875rem; }
  `;

  @state() private configState: ConfigState = createConfigState();
  @state() private originalRaw = '';
  @state() private saveMessage: string | null = null;
  @state() private mode: ViewMode = 'form';
  @state() private searchQuery = '';
  @state() private expandedSections: Set<string> = new Set();

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
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      this.handleSave();
    }
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

  // Cmd/Ctrl+S in form mode
  private handleFormKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      this.handleSave();
    }
  }

  private toggleSection(key: string) {
    const next = new Set(this.expandedSections);
    if (next.has(key)) next.delete(key); else next.add(key);
    this.expandedSections = next;
  }

  // Patch a value in the parsed config and re-serialize
  private patchConfig(path: string[], value: unknown) {
    const parsed = parseConfig(this.configState.raw, this.configState.format);
    if (!parsed) return;
    let target: Record<string, unknown> = parsed;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (target[key] == null || typeof target[key] !== 'object') {
        target[key] = {};
      }
      target = target[key] as Record<string, unknown>;
    }
    target[path[path.length - 1]] = value;
    updateConfigRaw(this.configState, serializeConfig(parsed, this.configState.format));
    this.requestUpdate();
  }

  private deleteConfigKey(path: string[]) {
    const parsed = parseConfig(this.configState.raw, this.configState.format);
    if (!parsed) return;
    let target: Record<string, unknown> = parsed;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (target[key] == null || typeof target[key] !== 'object') return;
      target = target[key] as Record<string, unknown>;
    }
    delete target[path[path.length - 1]];
    updateConfigRaw(this.configState, serializeConfig(parsed, this.configState.format));
    this.requestUpdate();
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
          <div class="mode-toggle">
            <button class=${this.mode === 'form' ? 'active' : ''} @click=${() => { this.mode = 'form'; }}>Form</button>
            <button class=${this.mode === 'raw' ? 'active' : ''} @click=${() => { this.mode = 'raw'; }}>Raw</button>
          </div>
          ${this.mode === 'form' ? html`
            <div class="search-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              <input class="search-input" type="text" placeholder="Search settings…"
                .value=${this.searchQuery}
                @input=${(e: Event) => { this.searchQuery = (e.target as HTMLInputElement).value; }}>
            </div>
          ` : nothing}
          <span class="format-badge">${this.configState.format.toUpperCase()}</span>
          ${this.configState.dirty ? html`<span class="dirty-badge">Unsaved changes</span>` : nothing}
        </div>
        <div class="toolbar-right">
          <button class="btn" @click=${this.doLoad} ?disabled=${this.configState.saving}>Reload</button>
          <button class="btn" @click=${this.handleReset} ?disabled=${!this.configState.dirty || this.configState.saving}>Reset</button>
          <button class="btn primary" @click=${this.handleSave} ?disabled=${!this.configState.dirty || this.configState.saving}>
            ${this.configState.saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      ${this.mode === 'raw' ? this.renderRaw() : this.renderForm()}
    `;
  }

  private renderRaw() {
    return html`
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
    `;
  }

  private renderForm() {
    const parsed = parseConfig(this.configState.raw, this.configState.format);
    if (!parsed) {
      return html`<div class="config-empty">
        <div class="config-empty__text">No valid configuration to display. Switch to Raw mode to edit.</div>
      </div>`;
    }

    const entries = Object.keys(parsed)
      .filter(key => matchesSearch(key, this.searchQuery))
      .sort();

    if (entries.length === 0) {
      return html`<div class="config-empty">
        <div class="config-empty__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        </div>
        <div class="config-empty__text">No settings match "${this.searchQuery}"</div>
      </div>`;
    }

    return html`
      <div class="form-wrap" @keydown=${this.handleFormKeyDown}>
        ${entries.map(key => this.renderSectionCard(key, parsed[key]))}
      </div>
    `;
  }

  private renderSectionCard(key: string, value: unknown) {
    const meta = SECTION_META[key] ?? { label: key.charAt(0).toUpperCase() + key.slice(1), description: '' };
    const expanded = this.expandedSections.has(key);

    return html`
      <section class="config-section-card">
        <div class="config-section-card__header" @click=${() => this.toggleSection(key)}>
          <span class="config-section-card__icon">${getSectionIcon(key)}</span>
          <div class="config-section-card__titles">
            <h3 class="config-section-card__title">${meta.label}</h3>
            ${meta.description ? html`<p class="config-section-card__desc">${meta.description}</p>` : nothing}
          </div>
          <svg class="config-section-card__chevron ${expanded ? 'expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>
        ${expanded ? html`
          <div class="config-section-card__content">
            ${this.renderValue(value, [key])}
          </div>
        ` : nothing}
      </section>
    `;
  }

  private renderValue(value: unknown, path: string[]): TemplateResult | typeof nothing {
    if (value === null || value === undefined) {
      return html`<label class="field"><span>${path[path.length - 1]}</span><input type="text" value="" placeholder="(empty)" @change=${(e: Event) => this.patchConfig(path, (e.target as HTMLInputElement).value || null)}></label>`;
    }

    if (typeof value === 'boolean') {
      return html`<div class="field-row">
        <input type="checkbox" .checked=${value} @change=${(e: Event) => this.patchConfig(path, (e.target as HTMLInputElement).checked)}>
        <span>${path[path.length - 1]}</span>
      </div>`;
    }

    if (typeof value === 'number') {
      return html`<label class="field"><span>${path[path.length - 1]}</span><input type="number" .value=${String(value)} @change=${(e: Event) => this.patchConfig(path, Number((e.target as HTMLInputElement).value))}></label>`;
    }

    if (typeof value === 'string') {
      return html`<label class="field"><span>${path[path.length - 1]}</span><input type="text" .value=${value} @change=${(e: Event) => this.patchConfig(path, (e.target as HTMLInputElement).value)}></label>`;
    }

    if (Array.isArray(value)) {
      return this.renderArray(value, path);
    }

    if (typeof value === 'object') {
      return this.renderObject(value as Record<string, unknown>, path);
    }

    return nothing;
  }

  private renderArray(arr: unknown[], path: string[]) {
    const allPrimitive = arr.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');

    if (allPrimitive || arr.length === 0) {
      return html`
        <div class="field">
          <span>${path[path.length - 1]}</span>
          <div class="array-items">
            ${arr.map((item, i) => html`
              <div class="array-item">
                <input type="text" .value=${String(item)} @change=${(e: Event) => {
                  const newArr = [...arr];
                  newArr[i] = (e.target as HTMLInputElement).value;
                  this.patchConfig(path, newArr);
                }}>
                <button class="remove-btn" @click=${() => {
                  const newArr = arr.filter((_, idx) => idx !== i);
                  this.patchConfig(path, newArr);
                }}>×</button>
              </div>
            `)}
          </div>
          <button class="add-btn" @click=${() => {
            this.patchConfig(path, [...arr, '']);
          }}>+ Add item</button>
        </div>
      `;
    }

    // Complex array items: show as formatted JSON
    return html`<div class="field"><span>${path[path.length - 1]}</span><pre>${JSON.stringify(arr, null, 2)}</pre></div>`;
  }

  private renderObject(obj: Record<string, unknown>, path: string[]) {
    const entries = Object.entries(obj);
    // Check nesting depth: if we're already deep, show as JSON
    if (path.length >= 3) {
      return html`<div class="field"><span>${path[path.length - 1]}</span><pre>${JSON.stringify(obj, null, 2)}</pre></div>`;
    }

    // Check if it's a simple flat object (all values are primitives)
    const allFlat = entries.every(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null);

    if (allFlat) {
      return html`
        ${entries.map(([k, v]) => this.renderValue(v, [...path, k]))}
        <div class="kv-row" style="margin-top: 0.25rem;">
          <button class="add-btn" @click=${() => {
            this.patchConfig([...path, ''], '');
          }}>+ Add key</button>
        </div>
      `;
    }

    // Mixed or nested: render each sub-key
    return html`${entries.map(([k, v]) => {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        // Nested object — render as sub-group if shallow, else JSON
        const subEntries = Object.entries(v as Record<string, unknown>);
        const subAllFlat = subEntries.every(([, sv]) => typeof sv !== 'object' || sv === null);
        if (subAllFlat && path.length < 2) {
          return html`
            <div class="field" style="margin-top: 0.5rem;">
              <span style="font-weight: 600; font-size: 0.8125rem; color: var(--text-primary);">${k}</span>
              <div style="padding-left: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;">
                ${subEntries.map(([sk, sv]) => this.renderValue(sv, [...path, k, sk]))}
              </div>
            </div>
          `;
        }
        return html`<div class="field"><span>${k}</span><pre>${JSON.stringify(v, null, 2)}</pre></div>`;
      }
      return this.renderValue(v, [...path, k]);
    })}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-config': OpenRappterConfig;
  }
}
