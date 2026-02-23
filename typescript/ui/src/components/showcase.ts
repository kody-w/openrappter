/**
 * Showcase View Component
 * Browse and run the 10 Power Prompts agent orchestration demos.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface DemoInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  agentTypes: string[];
}

interface DemoStepResult {
  label: string;
  result: unknown;
  durationMs: number;
}

interface DemoRunResult {
  demoId: string;
  name: string;
  status: 'success' | 'error';
  steps: DemoStepResult[];
  totalDurationMs: number;
  summary: string;
  error?: string;
}

@customElement('openrappter-showcase')
export class OpenRappterShowcase extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem 2rem;
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
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
    }

    .btn {
      padding: 0.5rem 1rem;
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 0.8125rem;
      cursor: pointer;
    }

    .btn:hover { background: var(--border); }

    .btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .btn.primary:hover { opacity: 0.9; }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .filter-chips {
      display: flex;
      gap: 0.375rem;
      flex-wrap: wrap;
      margin-left: 0.5rem;
    }

    .filter-chip {
      font-size: 0.6875rem;
      padding: 0.25rem 0.625rem;
      border-radius: 1rem;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      cursor: pointer;
    }

    .filter-chip:hover { background: var(--border); }

    .filter-chip.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .demos-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 1rem;
    }

    .demo-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .demo-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .demo-icon { font-size: 1.5rem; }

    .demo-meta { flex: 1; }

    .demo-name {
      font-weight: 600;
      font-size: 1rem;
    }

    .demo-category {
      font-size: 0.6875rem;
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      display: inline-block;
      margin-top: 0.125rem;
    }

    .demo-desc {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .chip-row {
      display: flex;
      gap: 0.375rem;
      flex-wrap: wrap;
    }

    .chip {
      font-size: 0.6875rem;
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .demo-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }

    .status-badge {
      font-size: 0.75rem;
      font-weight: 500;
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
    }

    .status-badge.success {
      background: rgba(52, 211, 153, 0.15);
      color: #34d399;
    }

    .status-badge.error {
      background: rgba(248, 113, 113, 0.15);
      color: #f87171;
    }

    .result-panel {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      padding: 0.75rem;
      font-size: 0.8125rem;
    }

    .result-summary {
      color: var(--text-primary);
      margin-bottom: 0.5rem;
      font-weight: 500;
    }

    .result-steps {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }

    .result-step {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--text-secondary);
      font-size: 0.75rem;
    }

    .result-step-label { flex: 1; }

    .result-step-duration {
      font-family: monospace;
      color: var(--text-secondary);
    }

    .result-total {
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-primary);
    }

    .spinner-inline {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .empty-state {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }

    .run-all-progress {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      margin-left: 0.5rem;
    }
  `;

  @state() private demos: DemoInfo[] = [];
  @state() private loading = true;
  @state() private results: Map<string, DemoRunResult> = new Map();
  @state() private running: Set<string> = new Set();
  @state() private runningAll = false;
  @state() private runAllProgress = 0;
  @state() private categoryFilter = '';

  connectedCallback() {
    super.connectedCallback();
    this.loadDemos();
  }

  private async loadDemos() {
    this.loading = true;
    try {
      const response = await gateway.call<{ demos: DemoInfo[] }>('showcase.list');
      this.demos = response.demos;
    } catch {
      this.demos = [];
    }
    this.loading = false;
  }

  private get categories(): string[] {
    return [...new Set(this.demos.map((d) => d.category))].sort();
  }

  private get filteredDemos(): DemoInfo[] {
    if (!this.categoryFilter) return this.demos;
    return this.demos.filter((d) => d.category === this.categoryFilter);
  }

  private async runDemo(demoId: string) {
    this.running = new Set([...this.running, demoId]);
    this.requestUpdate();
    try {
      const result = await gateway.call<DemoRunResult>('showcase.run', { demoId });
      this.results = new Map(this.results);
      this.results.set(demoId, result);
    } catch (e) {
      this.results = new Map(this.results);
      this.results.set(demoId, {
        demoId,
        name: this.demos.find((d) => d.id === demoId)?.name ?? 'Unknown',
        status: 'error',
        steps: [],
        totalDurationMs: 0,
        summary: '',
        error: e instanceof Error ? e.message : String(e),
      });
    }
    this.running = new Set([...this.running].filter((id) => id !== demoId));
    this.requestUpdate();
  }

  private async runAll() {
    this.runningAll = true;
    this.runAllProgress = 0;
    const demos = this.filteredDemos;
    for (const demo of demos) {
      await this.runDemo(demo.id);
      this.runAllProgress++;
    }
    this.runningAll = false;
  }

  private getCategoryIcon(category: string): string {
    const icons: Record<string, string> = {
      Competition: '🏆',
      Safety: '🛡️',
      Analysis: '🔍',
      Observability: '📊',
      Evolution: '🧬',
      Meta: '🏗️',
      Parallel: '⚡',
      DAG: '🔀',
      Verification: '🪞',
      Cloning: '🧪',
      Emergent: '📈',
    };
    return icons[category] ?? '🎪';
  }

  render() {
    if (this.loading) return html`<div class="empty-state">Loading demos...</div>`;

    const demos = this.filteredDemos;

    return html`
      <div class="page-header">
        <h2>Agent Orchestration Showcase</h2>
        <p>10 Power Prompts demos — run agent orchestration patterns directly in the browser.</p>
      </div>

      <div class="toolbar">
        <button
          class="btn primary"
          @click=${() => this.runAll()}
          ?disabled=${this.runningAll}
        >
          ${this.runningAll ? html`<span class="spinner-inline"></span>` : 'Run All'}
        </button>
        ${this.runningAll
          ? html`<span class="run-all-progress">${this.runAllProgress}/${demos.length}</span>`
          : nothing}
        <button class="btn" @click=${() => this.loadDemos()}>Refresh</button>

        <div class="filter-chips">
          <span
            class="filter-chip ${!this.categoryFilter ? 'active' : ''}"
            @click=${() => { this.categoryFilter = ''; }}
          >All</span>
          ${this.categories.map(
            (cat) => html`
              <span
                class="filter-chip ${this.categoryFilter === cat ? 'active' : ''}"
                @click=${() => { this.categoryFilter = cat; }}
              >${cat}</span>
            `,
          )}
        </div>
      </div>

      ${demos.length === 0
        ? html`<div class="empty-state">No demos match the selected category.</div>`
        : html`
            <div class="demos-grid">
              ${demos.map((demo) => this.renderDemoCard(demo))}
            </div>
          `}
    `;
  }

  private renderDemoCard(demo: DemoInfo) {
    const isRunning = this.running.has(demo.id);
    const result = this.results.get(demo.id);

    return html`
      <div class="demo-card">
        <div class="demo-header">
          <span class="demo-icon">${this.getCategoryIcon(demo.category)}</span>
          <div class="demo-meta">
            <div class="demo-name">${demo.name}</div>
            <span class="demo-category">${demo.category}</span>
          </div>
        </div>
        <div class="demo-desc">${demo.description}</div>
        <div class="chip-row">
          ${demo.agentTypes.map((t) => html`<span class="chip">${t}</span>`)}
        </div>
        <div class="demo-footer">
          ${result
            ? html`<span class="status-badge ${result.status}">${result.status}</span>`
            : html`<span></span>`}
          <button
            class="btn${isRunning ? '' : ' primary'}"
            @click=${() => this.runDemo(demo.id)}
            ?disabled=${isRunning}
          >
            ${isRunning ? html`<span class="spinner-inline"></span> Running` : 'Run'}
          </button>
        </div>
        ${result ? this.renderResult(result) : nothing}
      </div>
    `;
  }

  private renderResult(result: DemoRunResult) {
    return html`
      <div class="result-panel">
        <div class="result-summary">${result.summary}</div>
        ${result.error ? html`<div style="color: var(--error); font-size: 0.75rem;">${result.error}</div>` : nothing}
        <div class="result-steps">
          ${result.steps.map(
            (step) => html`
              <div class="result-step">
                <span class="result-step-label">${step.label}</span>
                <span class="result-step-duration">${step.durationMs}ms</span>
              </div>
            `,
          )}
        </div>
        <div class="result-total">
          <span>Total</span>
          <span>${result.totalDurationMs}ms</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-showcase': OpenRappterShowcase;
  }
}
