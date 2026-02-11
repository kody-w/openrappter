/**
 * Configuration View Component
 * View and edit configuration
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import { createConfigState, loadConfig, saveConfig, updateConfigRaw, type ConfigState } from '../services/config.js';

@customElement('openrappter-config')
export class OpenRappterConfig extends LitElement {
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

    .header-actions {
      display: flex;
      gap: 0.5rem;
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
    }

    .config-sections {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .config-section {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      overflow: hidden;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      background: var(--bg-tertiary);
      cursor: pointer;
    }

    .section-title {
      font-weight: 600;
    }

    .section-toggle {
      color: var(--text-secondary);
      transition: transform 0.2s ease;
    }

    .section-toggle.expanded {
      transform: rotate(180deg);
    }

    .section-content {
      padding: 1.25rem;
      display: none;
    }

    .section-content.expanded {
      display: block;
    }

    .config-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 0;
      border-bottom: 1px solid var(--border);
    }

    .config-item:last-child {
      border-bottom: none;
    }

    .config-label {
      font-weight: 500;
    }

    .config-description {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .config-value {
      font-family: monospace;
      font-size: 0.875rem;
      padding: 0.375rem 0.75rem;
      background: var(--bg-tertiary);
      border-radius: 0.25rem;
    }

    input[type='text'],
    input[type='number'],
    select {
      padding: 0.5rem 0.75rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.875rem;
      min-width: 200px;
    }

    input:focus,
    select:focus {
      outline: none;
      border-color: var(--accent);
    }

    .toggle-switch {
      width: 44px;
      height: 24px;
      background: var(--bg-tertiary);
      border-radius: 12px;
      position: relative;
      cursor: pointer;
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
  `;

  @state()
  private expandedSections = new Set<string>(['gateway', 'models']);

  @state()
  private configState: ConfigState = createConfigState();

  @state()
  private mode: 'form' | 'raw' = 'form';

  @state()
  private originalRaw = '';

  connectedCallback() {
    super.connectedCallback();
    this.configState.client = gateway;
    this.doLoadConfig();
  }

  private async doLoadConfig() {
    await loadConfig(this.configState);
    this.originalRaw = this.configState.raw;
    this.requestUpdate();
  }

  private async handleSave() {
    await saveConfig(this.configState);
    this.originalRaw = this.configState.raw;
    this.requestUpdate();
  }

  private handleReset() {
    this.configState.raw = this.originalRaw;
    this.configState.dirty = false;
    this.requestUpdate();
  }

  private toggleSection(section: string) {
    if (this.expandedSections.has(section)) {
      this.expandedSections.delete(section);
    } else {
      this.expandedSections.add(section);
    }
    this.requestUpdate();
  }

  render() {
    return html`
      <div class="header">
        <h2>Configuration</h2>
        <div class="header-actions">
          <button class="secondary" @click=${this.handleReset}>Reset</button>
          <button @click=${this.handleSave}>Save Changes</button>
        </div>
      </div>

      <div class="config-sections">
        <!-- Gateway Section -->
        <div class="config-section">
          <div class="section-header" @click=${() => this.toggleSection('gateway')}>
            <span class="section-title">Gateway</span>
            <span class="section-toggle ${this.expandedSections.has('gateway') ? 'expanded' : ''}">
              ▼
            </span>
          </div>
          <div class="section-content ${this.expandedSections.has('gateway') ? 'expanded' : ''}">
            <div class="config-item">
              <div>
                <div class="config-label">Port</div>
                <div class="config-description">WebSocket server port</div>
              </div>
              <input type="number" value="18789" />
            </div>
            <div class="config-item">
              <div>
                <div class="config-label">Bind Address</div>
                <div class="config-description">Network interface to bind to</div>
              </div>
              <select>
                <option value="loopback">Loopback (127.0.0.1)</option>
                <option value="all">All Interfaces (0.0.0.0)</option>
              </select>
            </div>
            <div class="config-item">
              <div>
                <div class="config-label">Authentication</div>
                <div class="config-description">Require password for connections</div>
              </div>
              <div class="toggle-switch"></div>
            </div>
          </div>
        </div>

        <!-- Models Section -->
        <div class="config-section">
          <div class="section-header" @click=${() => this.toggleSection('models')}>
            <span class="section-title">Models</span>
            <span class="section-toggle ${this.expandedSections.has('models') ? 'expanded' : ''}">
              ▼
            </span>
          </div>
          <div class="section-content ${this.expandedSections.has('models') ? 'expanded' : ''}">
            <div class="config-item">
              <div>
                <div class="config-label">Primary Provider</div>
                <div class="config-description">Default LLM provider</div>
              </div>
              <select>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
            <div class="config-item">
              <div>
                <div class="config-label">Default Model</div>
                <div class="config-description">Model to use for chat</div>
              </div>
              <input type="text" value="gpt-4o-mini" />
            </div>
          </div>
        </div>

        <!-- Memory Section -->
        <div class="config-section">
          <div class="section-header" @click=${() => this.toggleSection('memory')}>
            <span class="section-title">Memory</span>
            <span class="section-toggle ${this.expandedSections.has('memory') ? 'expanded' : ''}">
              ▼
            </span>
          </div>
          <div class="section-content ${this.expandedSections.has('memory') ? 'expanded' : ''}">
            <div class="config-item">
              <div>
                <div class="config-label">Embedding Provider</div>
                <div class="config-description">Provider for text embeddings</div>
              </div>
              <select>
                <option value="openai">OpenAI</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
            <div class="config-item">
              <div>
                <div class="config-label">Chunk Size</div>
                <div class="config-description">Tokens per memory chunk</div>
              </div>
              <input type="number" value="512" />
            </div>
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
