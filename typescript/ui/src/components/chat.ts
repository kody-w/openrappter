/**
 * Chat Component
 * Interactive chat interface with markdown rendering, streaming,
 * session picker, message grouping, tool sidebar, focus mode, and attachments.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { gateway } from '../services/gateway.js';
import { renderMarkdown } from '../services/markdown.js';
import type { ChatSessionSummary, Attachment } from '../types.js';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
}

interface MessageGroup {
  role: 'user' | 'assistant' | 'system';
  messages: Message[];
  timestamp: number;
}

interface ToolCall {
  id: string;
  runId: string;
  name: string;
  status: 'running' | 'success' | 'error';
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  timestamp: number;
}

interface AttachmentPreview {
  id: string;
  file: File;
  dataUrl?: string;
  mimeType: string;
  filename: string;
}

@customElement('openrappter-chat')
export class OpenRappterChat extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    /* ── Header / Session Picker ── */

    .chat-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.625rem 1rem;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      min-height: 44px;
    }

    .session-picker {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex: 1;
      min-width: 0;
    }

    .session-picker select {
      flex: 1;
      max-width: 280px;
      padding: 0.375rem 0.625rem;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.8125rem;
      font-family: inherit;
      cursor: pointer;
    }

    .session-picker select:focus {
      outline: none;
      border-color: var(--accent);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .icon-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      padding: 0;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 0.375rem;
      color: var(--text-secondary);
      font-size: 1rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .icon-btn:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .icon-btn.active {
      background: var(--accent);
      color: white;
    }

    .header-btn {
      padding: 0.375rem 0.75rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s ease;
    }

    .header-btn:hover {
      background: var(--accent-hover);
    }

    /* ── Main Layout (chat + tool sidebar) ── */

    .chat-body {
      flex: 1;
      display: flex;
      overflow: hidden;
      position: relative;
    }

    .chat-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    /* ── Messages ── */

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .message-group {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .message-group.user {
      align-self: flex-end;
      align-items: flex-end;
      max-width: 80%;
    }

    .message-group.assistant {
      align-self: flex-start;
      align-items: flex-start;
      max-width: 80%;
    }

    .message-group.system {
      align-self: center;
      align-items: center;
    }

    .group-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
    }

    .group-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      flex-shrink: 0;
    }

    .group-avatar.user {
      background: var(--accent);
      color: white;
    }

    .group-avatar.assistant {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
    }

    .group-name {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: capitalize;
    }

    .group-time {
      font-size: 0.6875rem;
      color: var(--text-secondary);
      opacity: 0.7;
    }

    .message {
      padding: 0.875rem 1rem;
      border-radius: 0.75rem;
      line-height: 1.6;
      font-size: 0.9375rem;
    }

    .message.user {
      background: var(--accent);
      color: white;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .message.assistant {
      background: var(--bg-tertiary);
    }

    .message.system {
      background: transparent;
      color: var(--text-secondary);
      font-size: 0.875rem;
      padding: 0.5rem;
    }

    /* Consecutive messages in a group get tighter radius */
    .message-group .message + .message {
      margin-top: 2px;
    }

    .message-group.user .message:not(:last-child) {
      border-bottom-right-radius: 0.25rem;
    }

    .message-group.user .message:not(:first-child) {
      border-top-right-radius: 0.25rem;
    }

    .message-group.assistant .message:not(:last-child) {
      border-bottom-left-radius: 0.25rem;
    }

    .message-group.assistant .message:not(:first-child) {
      border-top-left-radius: 0.25rem;
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

    /* ── Tool Sidebar ── */

    .tool-sidebar {
      width: 0;
      overflow: hidden;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      transition: width 0.2s ease;
    }

    .tool-sidebar.open {
      width: var(--tool-sidebar-width, 320px);
    }

    .resize-handle {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 5px;
      cursor: col-resize;
      z-index: 10;
      right: var(--tool-sidebar-width, 320px);
      display: none;
    }

    .tool-sidebar.open ~ .resize-handle,
    .resize-handle.visible {
      display: block;
    }

    .resize-handle:hover,
    .resize-handle.dragging {
      background: var(--accent);
      opacity: 0.4;
    }

    .tool-sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid var(--border);
      font-size: 0.8125rem;
      font-weight: 600;
    }

    .tool-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem;
    }

    .tool-item {
      padding: 0.625rem 0.75rem;
      border-radius: 0.375rem;
      margin-bottom: 0.375rem;
      background: var(--bg-tertiary);
      font-size: 0.8125rem;
    }

    .tool-item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
    }

    .tool-name {
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .tool-status {
      font-size: 0.6875rem;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .tool-status.running {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }

    .tool-status.success {
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
    }

    .tool-status.error {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
    }

    .tool-result {
      margin-top: 0.5rem;
      padding: 0.5rem;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 0.25rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.75rem;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
      color: var(--text-secondary);
    }

    .tool-time {
      font-size: 0.6875rem;
      color: var(--text-secondary);
      opacity: 0.7;
      margin-top: 0.25rem;
    }

    .tool-empty {
      padding: 2rem 1rem;
      text-align: center;
      color: var(--text-secondary);
      font-size: 0.8125rem;
    }

    @keyframes tool-spin {
      to { transform: rotate(360deg); }
    }

    .tool-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 1.5px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: tool-spin 0.8s linear infinite;
    }

    /* ── Input Area ── */

    .input-area {
      padding: 1rem 1.5rem;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border);
    }

    .attachment-strip {
      display: flex;
      gap: 0.5rem;
      padding-bottom: 0.75rem;
      overflow-x: auto;
    }

    .attachment-preview {
      position: relative;
      width: 64px;
      height: 64px;
      border-radius: 0.375rem;
      overflow: hidden;
      border: 1px solid var(--border);
      background: var(--bg-tertiary);
      flex-shrink: 0;
    }

    .attachment-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .attachment-preview .file-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      font-size: 1.5rem;
    }

    .attachment-preview .file-name {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 2px 4px;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      font-size: 0.5625rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .attachment-remove {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      border: none;
      cursor: pointer;
      font-size: 0.625rem;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      line-height: 1;
    }

    .attachment-remove:hover {
      background: var(--error);
    }

    .input-container {
      display: flex;
      gap: 0.75rem;
      align-items: flex-end;
    }

    .attach-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 44px;
      padding: 0;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      color: var(--text-secondary);
      font-size: 1.125rem;
      cursor: pointer;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }

    .attach-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
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

    textarea.drag-over {
      border-color: var(--accent);
      background: rgba(99, 102, 241, 0.05);
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

    /* ── Empty / Error States ── */

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

    .loading-sessions {
      font-size: 0.8125rem;
      color: var(--text-secondary);
      padding: 0.375rem 0;
    }

    /* Hide file input */
    .hidden-input {
      display: none;
    }

    /* ── Message Queue ── */

    .chat-queue {
      background: var(--bg-tertiary);
      border-top: 1px solid var(--border);
      padding: 0.5rem 1rem;
      font-size: 0.8125rem;
    }

    .chat-queue-title {
      color: var(--text-secondary);
      font-weight: 600;
      margin-bottom: 0.375rem;
    }

    .chat-queue-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0.25rem 0;
    }

    .chat-queue-text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-secondary);
    }

    .chat-queue-remove {
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.75rem;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
    }

    .chat-queue-remove:hover {
      color: var(--error);
      background: rgba(239, 68, 68, 0.1);
    }

    /* ── New Messages Button ── */

    .new-messages-btn {
      position: absolute;
      bottom: 120px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 1rem;
      padding: 0.375rem 1rem;
      font-size: 0.8125rem;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }

    .new-messages-btn:hover {
      background: var(--accent-hover);
    }

    /* ── Abort Button ── */

    .abort-btn {
      background: var(--error);
      color: white;
      border: none;
      border-radius: 0.375rem;
      padding: 0.375rem 0.75rem;
      font-size: 0.8125rem;
      cursor: pointer;
    }

    .abort-btn:hover {
      opacity: 0.85;
    }

    .btn-kbd {
      font-size: 0.6875rem;
      opacity: 0.6;
      margin-left: 0.25rem;
    }
  `;

  // ── State ──

  @state() private messages: Message[] = [];
  @state() private inputValue = '';
  @state() private sending = false;
  @state() private sessionKey: string | null = null;
  @state() private activeRunId: string | null = null;
  @state() private error: string | null = null;
  @state() private sessions: ChatSessionSummary[] = [];
  @state() private sessionsLoading = false;
  @state() private focusMode = false;
  @state() private toolCalls: ToolCall[] = [];
  @state() private toolSidebarOpen = false;
  @state() private toolExpandedIds = new Set<string>();
  @state() private attachments: AttachmentPreview[] = [];
  @state() private draggingOver = false;
  @state() private messageQueue: Array<{ id: string; text: string; createdAt: number }> = [];
  @state() private showNewMessages = false;
  @state() private userAtBottom = true;

  private toolSidebarWidth = 320;
  private resizing = false;

  @query('textarea') private textarea!: HTMLTextAreaElement;
  @query('.messages') private messagesContainer!: HTMLDivElement;
  @query('.hidden-input') private fileInput!: HTMLInputElement;

  // ── Lifecycle ──

  connectedCallback() {
    super.connectedCallback();
    this.loadSessions();

    // Listen for chat events (streaming deltas + finals)
    gateway.on('chat', this.handleChatEvent);

    // Listen for tool call events
    gateway.on('agent.tool', this.handleToolEvent);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    gateway.off('chat', this.handleChatEvent);
    gateway.off('agent.tool', this.handleToolEvent);
    document.removeEventListener('mousemove', this.handleResizeMove);
    document.removeEventListener('mouseup', this.handleResizeEnd);
  }

  // ── Session Picker ──

  private async loadSessions() {
    this.sessionsLoading = true;
    try {
      this.sessions = await gateway.call<ChatSessionSummary[]>('chat.list');
    } catch {
      this.sessions = [];
    }
    this.sessionsLoading = false;
  }

  private async switchSession(sessionId: string) {
    if (sessionId === this.sessionKey) return;
    this.sessionKey = sessionId;
    this.toolCalls = [];
    this.error = null;

    try {
      const loaded = await gateway.call<Array<{
        id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        timestamp: string;
      }>>('chat.messages', { sessionId, limit: 100 });

      this.messages = loaded.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: new Date(m.timestamp).getTime(),
      }));
      this.scrollToBottom();
    } catch (err) {
      this.error = `Failed to load session: ${(err as Error).message}`;
      this.messages = [];
    }
  }

  private startNewChat() {
    this.sessionKey = null;
    this.messages = [];
    this.toolCalls = [];
    this.activeRunId = null;
    this.sending = false;
    this.error = null;
    this.attachments = [];
  }

  private handleSessionChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const value = select.value;
    if (value === '__new__') {
      this.startNewChat();
    } else if (value) {
      this.switchSession(value);
    }
  }

  // ── Focus Mode ──

  private toggleFocusMode() {
    this.focusMode = !this.focusMode;
    this.dispatchEvent(
      new CustomEvent('toggle-focus', {
        bubbles: true,
        composed: true,
        detail: { focused: this.focusMode },
      }),
    );
  }

  // ── Chat Event Handlers ──

  private handleChatEvent = (payload: unknown) => {
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
  };

  // ── Tool Event Handler ──

  private handleToolEvent = (payload: unknown) => {
    const data = payload as {
      runId?: string;
      toolCallId?: string;
      name?: string;
      status?: 'running' | 'success' | 'error';
      arguments?: Record<string, unknown>;
      result?: unknown;
      error?: string;
    };

    const id = data.toolCallId ?? `tool_${Date.now()}`;
    const idx = this.toolCalls.findIndex((t) => t.id === id);

    if (idx >= 0) {
      const updated = [...this.toolCalls];
      updated[idx] = {
        ...updated[idx],
        status: data.status ?? updated[idx].status,
        result: data.result ?? updated[idx].result,
        error: data.error ?? updated[idx].error,
      };
      this.toolCalls = updated;
    } else {
      this.toolCalls = [
        ...this.toolCalls,
        {
          id,
          runId: data.runId ?? this.activeRunId ?? '',
          name: data.name ?? 'unknown',
          status: data.status ?? 'running',
          arguments: data.arguments,
          result: data.result,
          error: data.error,
          timestamp: Date.now(),
        },
      ];
      // Auto-open sidebar when tool calls arrive
      if (!this.toolSidebarOpen) {
        this.toolSidebarOpen = true;
      }
    }
  };

  // ── Abort / Stop ──

  private async handleAbort() {
    if (!this.activeRunId) return;
    try {
      await gateway.request('chat.abort', { runId: this.activeRunId });
    } catch { /* best effort */ }
    this.finishStreaming(this.activeRunId);
  }

  // ── Message Queue ──

  private enqueueMessage(text: string) {
    this.messageQueue = [
      ...this.messageQueue,
      { id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() },
    ];
  }

  private removeQueuedMessage(id: string) {
    this.messageQueue = this.messageQueue.filter((m) => m.id !== id);
  }

  private async flushQueue() {
    if (this.sending || this.messageQueue.length === 0) return;
    const [next, ...rest] = this.messageQueue;
    this.messageQueue = rest;
    this.inputValue = next.text;
    await this.handleSend();
  }

  // ── Paste to attach ──

  private handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) images.push(items[i]);
    }
    if (images.length === 0) return;
    e.preventDefault();
    for (const item of images) {
      const file = item.getAsFile();
      if (file) this.addFiles([file]);
    }
  }

  // ── Scroll tracking ──

  private handleChatScroll(e: Event) {
    const el = e.target as HTMLElement;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
    this.userAtBottom = atBottom;
    if (atBottom) this.showNewMessages = false;
  }

  private scrollToBottomClicked() {
    this.showNewMessages = false;
    this.scrollToBottom();
  }

  // ── Sending Messages ──

  private async handleSend() {
    const content = this.inputValue.trim();
    // Allow queueing if busy
    if (this.sending && content) {
      this.enqueueMessage(content);
      this.inputValue = '';
      return;
    }
    if (!content) return;

    this.sending = true;
    this.inputValue = '';
    this.error = null;

    if (this.textarea) {
      this.textarea.style.height = 'auto';
    }

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

      // Build attachments payload
      const attachmentPayload: Attachment[] = [];
      for (const a of this.attachments) {
        const data = await this.readFileAsBase64(a.file);
        attachmentPayload.push({
          type: this.getAttachmentType(a.mimeType),
          data,
          mimeType: a.mimeType,
          filename: a.filename,
        });
      }

      const params: Record<string, unknown> = {
        message: content,
        sessionKey,
      };
      if (attachmentPayload.length > 0) {
        params.attachments = attachmentPayload;
      }

      const result = await gateway.request<{
        runId: string;
        sessionKey: string;
        status: string;
      }>('chat.send', params);

      this.sessionKey = result.sessionKey;
      this.activeRunId = result.runId;
      this.attachments = [];

      // Refresh session list if this is a new session
      if (!this.sessions.some((s) => s.id === result.sessionKey)) {
        this.loadSessions();
      }

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
    // Flush queued messages
    if (this.messageQueue.length > 0) {
      setTimeout(() => this.flushQueue(), 100);
    }
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

  // ── Attachments ──

  private handleAttachClick() {
    this.fileInput?.click();
  }

  private handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) {
      this.addFiles(Array.from(input.files));
      input.value = '';
    }
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.draggingOver = true;
  }

  private handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.draggingOver = false;
  }

  private handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.draggingOver = false;
    if (e.dataTransfer?.files) {
      this.addFiles(Array.from(e.dataTransfer.files));
    }
  }

  private addFiles(files: File[]) {
    for (const file of files) {
      const preview: AttachmentPreview = {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        file,
        mimeType: file.type || 'application/octet-stream',
        filename: file.name,
      };

      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          preview.dataUrl = reader.result as string;
          this.requestUpdate();
        };
        reader.readAsDataURL(file);
      }

      this.attachments = [...this.attachments, preview];
    }
  }

  private removeAttachment(id: string) {
    this.attachments = this.attachments.filter((a) => a.id !== id);
  }

  private readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Strip data URL prefix to get raw base64
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  private getAttachmentType(mimeType: string): Attachment['type'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/pdf' ||
      mimeType.includes('document')
    ) {
      return 'document';
    }
    return 'file';
  }

  // ── Tool Sidebar ──

  private toggleToolSidebar() {
    this.toolSidebarOpen = !this.toolSidebarOpen;
  }

  private toggleToolExpanded(id: string) {
    const expanded = new Set(this.toolExpandedIds);
    if (expanded.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
    }
    this.toolExpandedIds = expanded;
  }

  private handleResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    this.resizing = true;
    document.addEventListener('mousemove', this.handleResizeMove);
    document.addEventListener('mouseup', this.handleResizeEnd);
  };

  private handleResizeMove = (e: MouseEvent) => {
    if (!this.resizing) return;
    const hostRect = this.getBoundingClientRect();
    const newWidth = Math.max(200, Math.min(600, hostRect.right - e.clientX));
    this.toolSidebarWidth = newWidth;
    this.style.setProperty('--tool-sidebar-width', `${newWidth}px`);
  };

  private handleResizeEnd = () => {
    this.resizing = false;
    document.removeEventListener('mousemove', this.handleResizeMove);
    document.removeEventListener('mouseup', this.handleResizeEnd);
  };

  // ── Helpers ──

  private scrollToBottom() {
    requestAnimationFrame(() => {
      if (this.messagesContainer) {
        if (this.userAtBottom) {
          this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        } else {
          this.showNewMessages = true;
        }
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

  private getSessionLabel(s: ChatSessionSummary): string {
    return s.label || `${s.agentId} · ${s.messageCount} msgs`;
  }

  // ── Message Grouping ──

  private groupMessages(messages: Message[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    for (const msg of messages) {
      const last = groups[groups.length - 1];
      if (last && last.role === msg.role) {
        last.messages.push(msg);
      } else {
        groups.push({
          role: msg.role,
          messages: [msg],
          timestamp: msg.timestamp,
        });
      }
    }
    return groups;
  }

  // ── Rendering ──

  private renderMessageContent(msg: Message) {
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
      </div>
    `;
  }

  private renderMessageGroup(group: MessageGroup) {
    if (group.role === 'system') {
      return html`
        <div class="message-group system">
          ${group.messages.map((msg) => this.renderMessageContent(msg))}
        </div>
      `;
    }

    const avatar = group.role === 'user' ? '👤' : '🦖';

    return html`
      <div class="message-group ${group.role}">
        <div class="group-header">
          <span class="group-avatar ${group.role}">${avatar}</span>
          <span class="group-name">${group.role}</span>
          <span class="group-time">${this.formatTime(group.timestamp)}</span>
        </div>
        ${group.messages.map((msg) => this.renderMessageContent(msg))}
      </div>
    `;
  }

  private renderToolSidebar() {
    const tools = this.toolCalls.slice().reverse();

    return html`
      <div class="tool-sidebar ${this.toolSidebarOpen ? 'open' : ''}"
           style="width: ${this.toolSidebarOpen ? this.toolSidebarWidth + 'px' : '0'}">
        <div class="tool-sidebar-header">
          <span>🔧 Tool Calls (${this.toolCalls.length})</span>
          <button class="icon-btn" @click=${this.toggleToolSidebar} title="Close">✕</button>
        </div>
        <div class="tool-list">
          ${tools.length === 0
            ? html`<div class="tool-empty">No tool calls yet</div>`
            : tools.map((tool) => this.renderToolItem(tool))}
        </div>
      </div>
    `;
  }

  private renderToolItem(tool: ToolCall) {
    const expanded = this.toolExpandedIds.has(tool.id);
    const statusIcon =
      tool.status === 'running' ? html`<span class="tool-spinner"></span>` :
      tool.status === 'success' ? '✓' : '✗';

    const resultText = tool.error
      ? tool.error
      : tool.result != null
        ? typeof tool.result === 'string'
          ? tool.result
          : JSON.stringify(tool.result, null, 2)
        : null;

    return html`
      <div class="tool-item">
        <div class="tool-item-header" @click=${() => this.toggleToolExpanded(tool.id)}>
          <span class="tool-name">
            ${expanded ? '▾' : '▸'}
            ${tool.name}
          </span>
          <span class="tool-status ${tool.status}">
            ${statusIcon} ${tool.status}
          </span>
        </div>
        ${expanded
          ? html`
              ${resultText != null
                ? html`<div class="tool-result">${resultText}</div>`
                : nothing}
              <div class="tool-time">${this.formatTime(tool.timestamp)}</div>
            `
          : nothing}
      </div>
    `;
  }

  private renderAttachmentStrip() {
    if (this.attachments.length === 0) return nothing;

    return html`
      <div class="attachment-strip">
        ${this.attachments.map(
          (att) => html`
            <div class="attachment-preview">
              ${att.dataUrl
                ? html`<img src=${att.dataUrl} alt=${att.filename} />`
                : html`<div class="file-icon">📄</div>`}
              <div class="file-name">${att.filename}</div>
              <button
                class="attachment-remove"
                @click=${() => this.removeAttachment(att.id)}
                title="Remove"
              >✕</button>
            </div>
          `,
        )}
      </div>
    `;
  }

  private renderSessionPicker() {
    return html`
      <div class="session-picker">
        ${this.sessionsLoading
          ? html`<span class="loading-sessions">Loading…</span>`
          : html`
              <select @change=${this.handleSessionChange} .value=${this.sessionKey ?? '__new__'}>
                <option value="__new__">✨ New Chat</option>
                ${this.sessions.map(
                  (s) => html`
                    <option value=${s.id} ?selected=${s.id === this.sessionKey}>
                      ${this.getSessionLabel(s)}
                    </option>
                  `,
                )}
              </select>
            `}
        <button
          class="icon-btn"
          @click=${() => this.loadSessions()}
          title="Refresh sessions"
        >↻</button>
      </div>
    `;
  }

  render() {
    const groups = this.groupMessages(this.messages);
    const hasToolCalls = this.toolCalls.length > 0;

    return html`
      <!-- Header -->
      <div class="chat-header">
        ${this.renderSessionPicker()}
        <div class="header-actions">
          <button
            class="icon-btn ${this.focusMode ? 'active' : ''}"
            @click=${this.toggleFocusMode}
            title="${this.focusMode ? 'Exit focus mode' : 'Focus mode'}"
          >⛶</button>
          <button
            class="icon-btn ${this.toolSidebarOpen ? 'active' : ''}"
            @click=${this.toggleToolSidebar}
            title="Tool calls${hasToolCalls ? ` (${this.toolCalls.length})` : ''}"
          >🔧${hasToolCalls
            ? html`<sup style="font-size:0.5625rem;margin-left:-2px">${this.toolCalls.length}</sup>`
            : nothing}</button>
          <button class="header-btn" @click=${this.startNewChat}>+ New</button>
        </div>
      </div>

      ${this.error
        ? html`<div class="error-toast">
            ${this.error}
            <button @click=${() => (this.error = null)}>✕</button>
          </div>`
        : nothing}

      <!-- Body: messages + tool sidebar -->
      <div class="chat-body">
        <div class="chat-main" style="position: relative;">
          <div class="messages" @scroll=${this.handleChatScroll}>
            ${groups.length === 0
              ? html`
                  <div class="empty-state">
                    <div class="empty-state-icon">🦖</div>
                    <div class="empty-state-text">
                      Start a conversation with OpenRappter.<br />
                      Ask questions, run commands, or just chat!
                    </div>
                  </div>
                `
              : groups.map((g) => this.renderMessageGroup(g))}
          </div>

          ${this.showNewMessages
            ? html`<button class="new-messages-btn" @click=${this.scrollToBottomClicked}>
                New messages ↓
              </button>`
            : nothing}

          ${this.messageQueue.length > 0
            ? html`
                <div class="chat-queue">
                  <div class="chat-queue-title">Queued (${this.messageQueue.length})</div>
                  ${this.messageQueue.map(
                    (item) => html`
                      <div class="chat-queue-item">
                        <div class="chat-queue-text">${item.text}</div>
                        <button
                          class="chat-queue-remove"
                          @click=${() => this.removeQueuedMessage(item.id)}
                        >✕</button>
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing}

          <div class="input-area">
            ${this.renderAttachmentStrip()}
            <div class="input-container">
              <button
                class="attach-btn"
                @click=${this.handleAttachClick}
                title="Attach files"
              >📎</button>
              <input
                class="hidden-input"
                type="file"
                multiple
                @change=${this.handleFileSelect}
              />
              <textarea
                class="${this.draggingOver ? 'drag-over' : ''}"
                placeholder=${this.sending ? 'Type to queue a message...' : 'Message (↩ to send, Shift+↩ for line breaks, paste images)'}
                .value=${this.inputValue}
                @input=${this.handleInput}
                @keydown=${this.handleKeyDown}
                @paste=${this.handlePaste}
                @dragover=${this.handleDragOver}
                @dragleave=${this.handleDragLeave}
                @drop=${this.handleDrop}
                rows="1"
              ></textarea>
              ${this.sending && this.activeRunId
                ? html`<button class="abort-btn" @click=${this.handleAbort}>Stop</button>`
                : nothing}
              <button
                class="send-btn"
                @click=${this.handleSend}
                ?disabled=${!this.inputValue.trim() && !this.sending}
              >
                ${this.sending ? 'Queue' : 'Send'}<span class="btn-kbd">↵</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Resize handle -->
        ${this.toolSidebarOpen
          ? html`<div
              class="resize-handle visible ${this.resizing ? 'dragging' : ''}"
              @mousedown=${this.handleResizeStart}
            ></div>`
          : nothing}

        <!-- Tool sidebar -->
        ${this.renderToolSidebar()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-chat': OpenRappterChat;
  }
}
