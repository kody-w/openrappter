import { renderMarkdown } from './markdown.js';
import { theme } from './theme.js';

export class ChatView {
  private messages: Array<{ role: string; content: string }> = [];
  private widget: unknown = null;

  setWidget(widget: unknown): void { this.widget = widget; }

  appendMessage(role: string, content: string): void {
    this.messages.push({ role, content });
    const prefix = role === 'user' ? '\x1b[36mYou\x1b[0m' : role === 'assistant' ? '\x1b[32mAssistant\x1b[0m' : '\x1b[33mSystem\x1b[0m';
    const rendered = renderMarkdown(content);
    const line = `${prefix}: ${rendered}`;
    if (this.widget && typeof (this.widget as any).log === 'function') {
      (this.widget as any).log(line);
    }
  }

  appendStreamDelta(text: string): void {
    if (this.widget && typeof (this.widget as any).setContent === 'function') {
      const current = (this.widget as any).getContent() || '';
      (this.widget as any).setContent(current + text);
    }
  }

  clear(): void {
    this.messages = [];
    if (this.widget && typeof (this.widget as any).setContent === 'function') {
      (this.widget as any).setContent('');
    }
  }
}
