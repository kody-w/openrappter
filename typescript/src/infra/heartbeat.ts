export class HeartbeatService {
  private intervalHandle: NodeJS.Timeout | null = null;

  start(intervalMs: number, callback: () => void | Promise<void>): void {
    if (this.intervalHandle) {
      this.stop();
    }

    this.intervalHandle = setInterval(async () => {
      try {
        await callback();
      } catch (error) {
        // Silently catch errors to prevent interval from stopping
        console.error('Heartbeat callback error:', error);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isRunning(): boolean {
    return this.intervalHandle !== null;
  }
}
