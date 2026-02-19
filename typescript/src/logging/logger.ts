/**
 * Structured logging with multiple transports.
 *
 * Design principles:
 *  - One global Logger instance (exported as `logger`), plus per-component
 *    child loggers created via logger.child('component').
 *  - Log entries carry: level, message, ISO 8601 timestamp, optional
 *    component, correlationId, arbitrary data, and structured error info.
 *  - Transports are pluggable: ConsoleTransport (colored), FileTransport
 *    (append with optional rotation), JsonTransport (JSON-lines).
 *  - chalk is already a project dependency; we use it for ConsoleTransport.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

// ── Log level ordering ────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

// ── Log entry ─────────────────────────────────────────────────────────────

export interface LogEntry {
  level: LogLevel;
  message: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** e.g. 'gateway', 'agent:ShellAgent', 'channel:telegram' */
  component?: string;
  /** Trace identifier across related operations */
  correlationId?: string;
  /** Arbitrary structured data */
  data?: Record<string, unknown>;
  /** Structured error info */
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

// ── Transport interface ───────────────────────────────────────────────────

export interface Transport {
  write(entry: LogEntry): void;
}

// ── ConsoleTransport ──────────────────────────────────────────────────────

const LEVEL_COLOR: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
  fatal: chalk.bgRed.white,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: ' INFO',
  warn: ' WARN',
  error: 'ERROR',
  fatal: 'FATAL',
};

export class ConsoleTransport implements Transport {
  write(entry: LogEntry): void {
    const colorize = LEVEL_COLOR[entry.level];
    const label = colorize(LEVEL_LABEL[entry.level]);
    const ts = chalk.dim(entry.timestamp);
    const comp = entry.component ? chalk.blue(` [${entry.component}]`) : '';
    const cid = entry.correlationId ? chalk.dim(` {${entry.correlationId}}`) : '';

    let line = `${ts} ${label}${comp}${cid} ${entry.message}`;

    if (entry.data && Object.keys(entry.data).length > 0) {
      line += ' ' + chalk.dim(JSON.stringify(entry.data));
    }

    if (entry.error) {
      const errMsg = chalk.red(` | ${entry.error.message}`);
      line += errMsg;
      if (entry.error.stack) {
        line += '\n' + chalk.dim(entry.error.stack);
      }
    }

    if (entry.level === 'error' || entry.level === 'fatal') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

// ── FileTransport ─────────────────────────────────────────────────────────

export interface FileTransportOptions {
  filePath: string;
  /** Max file size in bytes before rotation. Default: 10 MB */
  maxSize?: number;
  /** Number of rotated files to keep. Default: 5 */
  maxFiles?: number;
}

export class FileTransport implements Transport {
  private filePath: string;
  private maxSize: number;
  private maxFiles: number;

  constructor(options: FileTransportOptions) {
    this.filePath = options.filePath;
    this.maxSize = options.maxSize ?? 10 * 1024 * 1024; // 10 MB
    this.maxFiles = options.maxFiles ?? 5;

    // Ensure parent directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  write(entry: LogEntry): void {
    this.maybeRotate();

    const parts: string[] = [
      `[${entry.timestamp}]`,
      `[${entry.level.toUpperCase()}]`,
    ];

    if (entry.component) parts.push(`[${entry.component}]`);
    if (entry.correlationId) parts.push(`{${entry.correlationId}}`);

    parts.push(entry.message);

    if (entry.data && Object.keys(entry.data).length > 0) {
      parts.push(JSON.stringify(entry.data));
    }

    if (entry.error) {
      parts.push(`ERROR: ${entry.error.message}`);
      if (entry.error.code) parts.push(`(code: ${entry.error.code})`);
    }

    try {
      fs.appendFileSync(this.filePath, parts.join(' ') + '\n', 'utf-8');
    } catch { /* ignore write errors */ }
  }

  private maybeRotate(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stat = fs.statSync(this.filePath);
      if (stat.size < this.maxSize) return;

      // Rotate: shift existing rotated files
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const old = `${this.filePath}.${i}`;
        const newer = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(old)) {
          fs.renameSync(old, newer);
        }
      }
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch { /* ignore rotation errors */ }
  }
}

// ── JsonTransport ─────────────────────────────────────────────────────────

export interface JsonTransportOptions {
  filePath: string;
  /** Max file size in bytes before rotation. Default: 10 MB */
  maxSize?: number;
  /** Number of rotated files to keep. Default: 5 */
  maxFiles?: number;
}

export class JsonTransport implements Transport {
  private filePath: string;
  private maxSize: number;
  private maxFiles: number;

  constructor(options: JsonTransportOptions) {
    this.filePath = options.filePath;
    this.maxSize = options.maxSize ?? 10 * 1024 * 1024; // 10 MB
    this.maxFiles = options.maxFiles ?? 5;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  write(entry: LogEntry): void {
    this.maybeRotate();
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* ignore write errors */ }
  }

  private maybeRotate(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stat = fs.statSync(this.filePath);
      if (stat.size < this.maxSize) return;

      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const old = `${this.filePath}.${i}`;
        const newer = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(old)) {
          fs.renameSync(old, newer);
        }
      }
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch { /* ignore rotation errors */ }
  }
}

// ── Logger ────────────────────────────────────────────────────────────────

export class Logger {
  private level: LogLevel;
  private transports: Transport[];
  private component?: string;
  private correlationId?: string;

  constructor(options?: {
    level?: LogLevel;
    transports?: Transport[];
    component?: string;
    correlationId?: string;
  }) {
    this.level = options?.level ?? 'info';
    this.transports = options?.transports ?? [new ConsoleTransport()];
    this.component = options?.component;
    this.correlationId = options?.correlationId;
  }

  // ── Level control ──────────────────────────────────────────────────────

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  // ── Transport management ───────────────────────────────────────────────

  addTransport(transport: Transport): void {
    this.transports.push(transport);
  }

  removeTransport(transport: Transport): void {
    const idx = this.transports.indexOf(transport);
    if (idx >= 0) this.transports.splice(idx, 1);
  }

  clearTransports(): void {
    this.transports = [];
  }

  // ── Child loggers ──────────────────────────────────────────────────────

  /**
   * Create a child logger that inherits the parent's level and transports
   * but stamps every entry with the given component name.
   */
  child(component: string, correlationId?: string): Logger {
    const child = new Logger({
      level: this.level,
      // Share the transport array reference so addTransport on parent
      // propagates. This is intentional: the array is the same object.
      transports: this.transports,
      component,
      correlationId: correlationId ?? this.correlationId,
    });
    return child;
  }

  /** Return a new logger bound to a specific correlation id. */
  withCorrelation(correlationId: string): Logger {
    return new Logger({
      level: this.level,
      transports: this.transports,
      component: this.component,
      correlationId,
    });
  }

  // ── Logging methods ────────────────────────────────────────────────────

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, errorOrData?: Error | Record<string, unknown>, data?: Record<string, unknown>): void {
    if (errorOrData instanceof Error) {
      this.logWithError('error', message, errorOrData, data);
    } else {
      this.log('error', message, errorOrData);
    }
  }

  fatal(message: string, errorOrData?: Error | Record<string, unknown>, data?: Record<string, unknown>): void {
    if (errorOrData instanceof Error) {
      this.logWithError('fatal', message, errorOrData, data);
    } else {
      this.log('fatal', message, errorOrData);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      component: this.component,
      correlationId: this.correlationId,
      data,
    };

    this.dispatch(entry);
  }

  private logWithError(level: LogLevel, message: string, err: Error, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      component: this.component,
      correlationId: this.correlationId,
      data,
      error: {
        message: err.message,
        stack: err.stack,
        code: (err as NodeJS.ErrnoException).code,
      },
    };

    this.dispatch(entry);
  }

  private dispatch(entry: LogEntry): void {
    for (const transport of this.transports) {
      try { transport.write(entry); } catch { /* isolate transport errors */ }
    }
  }
}

// ── Global singleton ──────────────────────────────────────────────────────

/**
 * Global logger instance. Components should call `logger.child('name')` to
 * create namespaced sub-loggers rather than using this directly.
 */
export const logger = new Logger({
  level: (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info',
  transports: [new ConsoleTransport()],
});
