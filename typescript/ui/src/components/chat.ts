/**
 * Chat Component
 * Interactive chat interface with markdown rendering and streaming
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { gateway } from '../services/gateway.js';
import { renderMarkdown } from '../services/markdown.js';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
}

@customElement('openrappter-chat')
export class OpenRappterChat extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .message {
      max-width: 80%;
      padding: 0.875rem 1rem;
      border-radius: 0.75rem;
      line-height: 1.6;
      font-size: 0.9375rem;
    }

    .message.user {
      align-self: flex-end;
      background: var(--accent);
      color: white;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .message.assistant {
      align-self: flex-start;
      background: var(--bg-tertiary);
    }

    .message.system {
      align-self: center;
      background: transparent;
      color: var(--text-secondary);
      font-size: 0.875rem;
      padding: 0.5rem;
    }

    /* Markdown styles for assistant messages */
    .message.assistant .message-content {
      overflow-wrap: break-word;
    }

    .message.assistant .message-content p {
      margin: 0 0 0.75rem 0;
    }

    .message.assistant .message-content p:last-child {
      margin-bottom: 0;
    }

    .message.assistant .message-content code {
      background: rgba(0, 0, 0, 0.25);
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.85em;
    }

    .message.assistant .message-content pre {
      background: rgba(0, 0, 0, 0.3);
      padding: 0.875rem 1rem;
      border-radius: 0.5rem;
      overflow-x: auto;
      margin: 0.75rem 0;
      border: 1px solid var(--border);
    }

    .message.assistant .message-content pre code {
      background: transparent;
      padding: 0;
      font-size: 0.8125rem;
      line-height: 1.5;
    }

    .message.assistant .message-content ul,
    .message.assistant .message-content ol {
      margin: 0.5rem 0;
      padding-left: 1.5rem;
    }

    .message.assistant .message-content li {
      margin-bottom: 0.25rem;
    }

    .message.assistant .message-content blockquote {
      border-left: 3px solid var(--accent);
      margin: 0.5rem 0;
      padding: 0.25rem 0.75rem;
      color: var(--text-secondary);
    }

    .message.assistant .message-content h1,
    .message.assistant .message-content h2,
    .message.assistant .message-content h3 {
      margin: 1rem 0 0.5rem;
    }

    .message.assistant .message-content h1 { font-size: 1.25rem; }
    .message.assistant .message-content h2 { font-size: 1.125rem; }
    .message.assistant .message-content h3 { font-size: 1rem; }

    .message.assistant .message-content a {
      color: var(--accent);
      text-decoration: none;
    }

    .message.assistant .message-content a:hover {
      text-decoration: underline;
    }

    .message.assistant .message-content table {
      border-collapse: collapse;
      margin: 0.75rem 0;
      font-size: 0.875rem;
    }

    .message.assistant .message-content th,
    .message.assistant .message-content td {
      border: 1px solid var(--border);
      padding: 0.375rem 0.625rem;
    }

    .message.assistant .message-content th {
      background: rgba(0, 0, 0, 0.15);
      font-weight: 600;
    }

    .message-time {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-top: 0.375rem;
    }

    .message.user .message-time {
      color: rgba(255, 255, 255, 0.7);
    }

    .streaming-indicator {
      display: inline-flex;
      gap: 4px;
      margin-left: 4px;
      vertical-align: middle;
    }

    .streaming-indicator span {
      width: 6px;
      height: 6px;
      background: var(--accent);
      border-radius: 50%;
      animation: bounce 1.2s infinite ease-in-out;
    }

    .streaming-indicator span:nth-child(2) { animation-delay: 0.15s; }
    .streaming-indicator span:nth-child(3) { animation-delay: 0.3s; }

    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1); opacity: 1; }
    }

    .input-area {
      padding: 1rem 1.5rem;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border);
    }

    .input-container {
      display: flex;
      gap: 0.75rem;
      align-items: flex-end;
    }

    textarea {
      flex: 1;
      padding: 0.75rem 1rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      color: var(--text-primary);
      font-size: 0.9375rem;
      font-family: inherit;
      resize: none;
      min-height: 44px;
      max-height: 200px;
      transition: border-color 0.15s ease;
    }

    textarea:focus {
      outline: none;
      border-color: var(--accent);
    }

    textarea::placeholder {
      color: var(--text-secondary);
    }

    button.send-btn {
      padding: 0.75rem 1.25rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.9375rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease;
      white-space: nowrap;
    }

    button.send-btn:hover:not(:disabled) {
      background: var(--accent-hover);
    }

    button.send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-secondary);
      text-align: center;
      gap: 1rem;
    }

    .empty-state-icon {
      font-size: 4rem;
    }

    .empty-state-text {
      max-width: 400px;
      line-height: 1.6;
      font-size: 0.9375rem;
    }

    .error-toast {
      background: var(--error);
      color: white;
      padding: 0.625rem 1rem;
      border-radius: 0.5rem;
      margin: 0 1.5rem 0.5rem;
      font-size: 0.875rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .error-toast button {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      font-size: 1rem;
      padding: 0 0.25rem;
    }
  `;

  @state() private messages: Message[] = [];
  @state() private inputValue = '';
  @state() private sending = false;
  @state() private sessionKey: string | null = null;
  @state() private activeRunId: string | null = null;
  @state() private error: string | null = null;

  @query('textarea') private textarea!: HTMLTextAreaElement;
  @query('.messages') private messagesContainer!: HTMLDivElement;

  connectedCallback() {
    super.connectedCallback();

    // Listen for chat events (streaming deltas + finals)
    gateway.on('chat', (payload) => {
      const data = payload as {
        runId: string;
        sessionKey: string;
        state: 'delta' | 'final' | 'error';
        message?: { role: string; content: Array<{ type: string; text?: string }> };
        errorMessage?: string;
      };

      if (data.state === 'delta' || data.state === 'final') {
        const text = data.message?.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('') ?? '';

        if (text) {
          this.updateStreamingMessage(data.runId, text);
        }

        if (data.state === 'final') {
          this.finishStreaming(data.runId);
        }
      }

      if (data.state === 'error') {
        this.handleStreamError(data.runId, data.errorMessage ?? 'Unknown error');
      }
    });
  }

  private async handleSend() {
    const content = this.inputValue.trim();
    if (!content || this.sending) return;

    this.sending = true;
    this.inputValue = '';
    this.error = null;

    // Reset textarea height
    if (this.textarea) {
      this.textarea.style.height = 'auto';
    }

    // Add user message
    const userMessage: Message = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    this.messages = [...this.messages, userMessage];
    this.scrollToBottom();

    try {
      const sessionKey = this.sessionKey ?? `session_${Date.now()}`;
      const result = await gateway.request<{
        runId: string;
        sessionKey: string;
        status: string;
      }>('chat.send', {
        message: content,
        sessionKey,
      });

      this.sessionKey = result.sessionKey;
      this.activeRunId = result.runId;

      // Add placeholder for assistant response
      const assistantMessage: Message = {
        id: result.runId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
      };
      this.messages = [...this.messages, assistantMessage];
      this.scrollToBottom();
    } catch (err) {
      this.error = (err as Error).message;
      this.sending = false;
    }
  }

  private updateStreamingMessage(runId: string, text: string) {
    const idx = this.messages.findIndex((m) => m.id === runId);
    if (idx < 0) return;

    const messages = [...this.messages];
    messages[idx] = { ...messages[idx], content: text };
    this.messages = messages;
    this.scrollToBottom();
  }

  private finishStreaming(runId: string) {
    const idx = this.messages.findIndex((m) => m.id === runId);
    if (idx < 0) return;

    const messages = [...this.messages];
    messages[idx] = { ...messages[idx], streaming: false };
    this.messages = messages;
    this.sending = false;
    this.activeRunId = null;
  }

  private handleStreamError(runId: string, errorMessage: string) {
    const idx = this.messages.findIndex((m) => m.id === runId);
    if (idx >= 0) {
      const messages = [...this.messages];
      messages[idx] = {
        ...messages[idx],
        content: `⚠️ ${errorMessage}`,
        streaming: false,
      };
      this.messages = messages;
    }
    this.sending = false;
    this.activeRunId = null;
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      if (this.messagesContainer) {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
      }
    });
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.handleSend();
    }
  }

  private handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    this.inputValue = target.value;
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
  }

  private formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private renderMessage(msg: Message) {
    const isAssistant = msg.role === 'assistant';
    return html`
      <div class="message ${msg.role}">
        <div class="message-content">
          ${isAssistant && msg.content
            ? unsafeHTML(renderMarkdown(msg.content))
            : msg.content}
          ${msg.streaming
            ? html`<span class="streaming-indicator"><span></span><span></span><span></span></span>`
            : nothing}
        </div>
        <div class="message-time">${this.formatTime(msg.timestamp)}</div>
      </div>
    `;
  }

  render() {
    return html`
      ${this.error
        ? html`<div class="error-toast">
            ${this.error}
            <button @click=${() => (this.error = null)}>✕</button>
          </div>`
        : nothing}

      <div class="messages">
        ${this.messages.length === 0
          ? html`
              <div class="empty-state">
                <div class="empty-state-icon">🦖</div>
                <div class="empty-state-text">
                  Start a conversation with OpenRappter.<br />
                  Ask questions, run commands, or just chat!
                </div>
              </div>
            `
          : this.messages.map((msg) => this.renderMessage(msg))}
      </div>

      <div class="input-area">
        <div class="input-container">
          <textarea
            placeholder=${this.sending ? 'Waiting for response...' : 'Type a message... (Enter to send, Shift+Enter for newline)'}
            .value=${this.inputValue}
            @input=${this.handleInput}
            @keydown=${this.handleKeyDown}
            ?disabled=${this.sending}
            rows="1"
          ></textarea>
          <button
            class="send-btn"
            @click=${this.handleSend}
            ?disabled=${this.sending || !this.inputValue.trim()}
          >
            ${this.sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-chat': OpenRappterChat;
  }
}
