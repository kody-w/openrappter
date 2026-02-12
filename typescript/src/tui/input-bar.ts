import { EventEmitter } from 'events';

export class InputBar extends EventEmitter {
  private history: string[] = [];
  private historyIndex = -1;
  private widget: unknown = null;

  setWidget(widget: unknown): void {
    this.widget = widget;
    if (widget && typeof (widget as any).on === 'function') {
      (widget as any).on('submit', (value: string) => {
        if (value.trim()) {
          this.history.unshift(value.trim());
          this.historyIndex = -1;
          this.emit('submit', value.trim());
        }
        (widget as any).clearValue();
        (widget as any).focus();
      });
    }
  }

  historyUp(): string | undefined {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      return this.history[this.historyIndex];
    }
    return undefined;
  }

  historyDown(): string | undefined {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      return this.history[this.historyIndex];
    }
    this.historyIndex = -1;
    return '';
  }
}
