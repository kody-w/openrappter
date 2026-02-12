/**
 * Logs RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// In-memory log buffer
const logBuffer: LogEntry[] = [];
const MAX_LOG_ENTRIES = 1000;

// Hook into console to capture logs
function captureLog(
  level: LogEntry['level'],
  category: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level,
    category,
    message,
    metadata,
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
}

export function registerLogsMethods(server: MethodRegistrar): void {
  server.registerMethod<
    { limit?: number; since?: number; level?: string },
    { entries: LogEntry[] }
  >('logs.tail', async (params) => {
    const { limit = 100, since, level } = params;

    let entries = [...logBuffer];

    if (since) {
      entries = entries.filter((e) => e.timestamp >= since);
    }

    if (level) {
      entries = entries.filter((e) => e.level === level);
    }

    entries = entries.slice(-limit);

    return { entries };
  });
}

// Export utility for other modules to push logs
export function pushLog(
  level: LogEntry['level'],
  category: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  captureLog(level, category, message, metadata);
}
