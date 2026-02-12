export class StatusBar {
  private widget: unknown = null;
  private state = { connected: false, model: 'default', agent: 'default', session: 'default' };

  setWidget(widget: unknown): void { this.widget = widget; this.render(); }

  update(partial: Partial<typeof this.state>): void {
    Object.assign(this.state, partial);
    this.render();
  }

  private render(): void {
    if (!this.widget) return;
    const status = this.state.connected ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
    const text = ` ${status} ${this.state.model} | Agent: ${this.state.agent} | Session: ${this.state.session}`;
    if (typeof (this.widget as any).setContent === 'function') {
      (this.widget as any).setContent(text);
    }
  }
}
