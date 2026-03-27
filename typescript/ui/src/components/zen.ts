/**
 * Zen Viewer — Watch a live zen terminal stream in the browser.
 *
 * Connects to the gateway via WebSocket, subscribes to zen.frame events,
 * and renders ANSI terminal frames in a styled <pre> element using
 * ansi_up for color conversion.
 *
 * Optionally upgrades to PeerJS P2P for direct viewer-to-viewer relay
 * (reduces gateway load when many people watch).
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface ZenSession {
  id: string;
  name: string;
  startedAt: string;
  frameCount: number;
  viewerCount: number;
}

@customElement('openrappter-zen')
export class OpenRappterZen extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem 2rem;
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

    .sessions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 1rem;
      margin-top: 1rem;
    }

    .session-card {
      background: var(--bg-secondary, #1e1e2e);
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      padding: 1rem;
      cursor: pointer;
      transition: border-color 0.2s;
    }

    .session-card:hover {
      border-color: var(--accent-color, #7c3aed);
    }

    .session-card.active {
      border-color: var(--accent-color, #7c3aed);
      box-shadow: 0 0 8px rgba(124, 58, 237, 0.3);
    }

    .session-name {
      font-weight: 600;
      margin-bottom: 0.5rem;
    }

    .session-meta {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .terminal {
      background: #0d0d0d;
      color: #c8c8c8;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 13px;
      line-height: 1.35;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid #333;
      overflow: hidden;
      white-space: pre;
      margin-top: 1rem;
      min-height: 400px;
    }

    .empty-state {
      text-align: center;
      color: var(--text-secondary);
      padding: 3rem;
      font-size: 0.875rem;
    }

    .empty-state .emoji {
      font-size: 2rem;
      margin-bottom: 0.5rem;
    }

    .viewer-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--accent-color, #7c3aed);
      color: white;
      font-size: 0.7rem;
      padding: 2px 8px;
      border-radius: 10px;
    }

    .disconnect-btn {
      margin-top: 0.5rem;
      background: transparent;
      border: 1px solid #555;
      color: var(--text-secondary);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
    }

    .disconnect-btn:hover {
      border-color: #f87171;
      color: #f87171;
    }
  `;

  @state() private sessions: ZenSession[] = [];
  @state() private activeSessionId: string | null = null;
  @state() private currentFrame = '';
  @state() private loading = true;

  private frameHandler: ((payload: unknown) => void) | null = null;

  async connectedCallback() {
    super.connectedCallback();
    await this.loadSessions();
    this.loading = false;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.activeSessionId) {
      this.unsubscribe();
    }
  }

  private async loadSessions() {
    try {
      const result = await gateway.call('zen.sessions') as { sessions: ZenSession[] };
      this.sessions = result.sessions ?? [];
    } catch {
      this.sessions = [];
    }
  }

  private async subscribe(sessionId: string) {
    // Unsubscribe from current if switching
    if (this.activeSessionId) {
      await this.unsubscribe();
    }

    try {
      const result = await gateway.call('zen.subscribe', { sessionId }) as {
        subscribed: boolean;
        lastFrame?: string;
      };
      if (result.subscribed) {
        this.activeSessionId = sessionId;
        if (result.lastFrame) {
          this.currentFrame = this.ansiToHtml(result.lastFrame);
        }

        // Listen for frame events
        this.frameHandler = (payload: unknown) => {
          const p = payload as { sessionId: string; frame: string };
          if (p.sessionId === this.activeSessionId) {
            this.currentFrame = this.ansiToHtml(p.frame);
          }
        };
        gateway.on('zen.frame', this.frameHandler);
      }
    } catch (err) {
      console.error('Failed to subscribe:', err);
    }
  }

  private async unsubscribe() {
    if (!this.activeSessionId) return;
    try {
      await gateway.call('zen.unsubscribe', { sessionId: this.activeSessionId });
    } catch { /* fine */ }
    if (this.frameHandler) {
      gateway.off('zen.frame', this.frameHandler);
      this.frameHandler = null;
    }
    this.activeSessionId = null;
    this.currentFrame = '';
  }

  /** Convert ANSI escape codes to HTML spans with inline styles. */
  private ansiToHtml(ansi: string): string {
    const colorMap: Record<string, string> = {
      '30': '#000', '31': '#f87171', '32': '#4ade80', '33': '#fbbf24',
      '34': '#60a5fa', '35': '#c084fc', '36': '#22d3ee', '37': '#d1d5db',
      '90': '#6b7280', '91': '#fca5a5', '92': '#86efac', '93': '#fde68a',
      '94': '#93c5fd', '95': '#d8b4fe', '96': '#67e8f9', '97': '#f3f4f6',
    };

    // Escape HTML, then convert ANSI codes
    let html = ansi
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Strip cursor movement codes (moveTo, home, clear, hide/show)
    html = html.replace(/\x1b\[\?25[hl]/g, '');
    html = html.replace(/\x1b\[2J/g, '');
    html = html.replace(/\x1b\[\d+;\d+H/g, '');
    html = html.replace(/\x1b\[H/g, '');

    // Convert color codes to spans
    html = html.replace(/\x1b\[(\d+)m/g, (_match, code) => {
      if (code === '0') return '</span>';
      if (code === '1') return '<span style="font-weight:bold">';
      if (code === '2') return '<span style="opacity:0.5">';
      if (code === '3') return '<span style="font-style:italic">';
      const color = colorMap[code];
      if (color) return `<span style="color:${color}">`;
      return '';
    });

    return html;
  }

  render() {
    if (this.loading) {
      return html`<div class="empty-state">Loading...</div>`;
    }

    return html`
      <div class="page-header">
        <h2>🧘 Zen Viewer</h2>
        <p>Watch live terminal zen screens — ambient AI games streamed from the gateway.</p>
      </div>

      ${this.sessions.length === 0
        ? html`
          <div class="empty-state">
            <div class="emoji">🏓</div>
            <p>No active zen sessions.</p>
            <p>Start one with <code>openrappter --exec Pong</code> or the pong view in the bar.</p>
          </div>
        `
        : html`
          <div class="sessions-grid">
            ${this.sessions.map(s => html`
              <div
                class="session-card ${this.activeSessionId === s.id ? 'active' : ''}"
                @click=${() => this.subscribe(s.id)}
              >
                <div class="session-name">🎮 ${s.name}</div>
                <div class="session-meta">
                  ${s.frameCount} frames ·
                  <span class="viewer-badge">👁 ${s.viewerCount}</span>
                </div>
              </div>
            `)}
          </div>
        `
      }

      ${this.activeSessionId
        ? html`
          <div class="terminal" .innerHTML=${this.currentFrame}></div>
          <button class="disconnect-btn" @click=${() => this.unsubscribe()}>
            Disconnect
          </button>
        `
        : ''
      }
    `;
  }
}
