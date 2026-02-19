/**
 * Tests for the structured Logger — log levels, transports, child loggers,
 * error logging, and correlation ids.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Logger,
  ConsoleTransport,
  FileTransport,
  JsonTransport,
  logger,
} from '../logger.js';
import type { LogEntry, Transport, LogLevel } from '../logger.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Capture transport for testing ─────────────────────────────────────────

class CaptureTransport implements Transport {
  entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

// ── Logger construction ───────────────────────────────────────────────────

describe('Logger — construction', () => {
  it('defaults to info level and a ConsoleTransport', () => {
    const log = new Logger();
    expect(log.getLevel()).toBe('info');
  });

  it('accepts custom level and transports', () => {
    const cap = new CaptureTransport();
    const log = new Logger({ level: 'debug', transports: [cap] });
    expect(log.getLevel()).toBe('debug');
    log.debug('hello');
    expect(cap.entries).toHaveLength(1);
  });
});

// ── Log levels ────────────────────────────────────────────────────────────

describe('Logger — level filtering', () => {
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];

  for (const minLevel of levels) {
    it(`level=${minLevel} suppresses lower-level messages`, () => {
      const cap = new CaptureTransport();
      const log = new Logger({ level: minLevel, transports: [cap] });

      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      log.fatal('f');

      const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
      const minOrder = levelOrder[minLevel];

      for (const entry of cap.entries) {
        expect(levelOrder[entry.level]).toBeGreaterThanOrEqual(minOrder);
      }
    });
  }

  it('setLevel changes the minimum level', () => {
    const cap = new CaptureTransport();
    const log = new Logger({ level: 'error', transports: [cap] });
    log.info('suppressed');
    expect(cap.entries).toHaveLength(0);
    log.setLevel('debug');
    log.info('now visible');
    expect(cap.entries).toHaveLength(1);
  });
});

// ── Log entry shape ───────────────────────────────────────────────────────

describe('Logger — entry shape', () => {
  let cap: CaptureTransport;
  let log: Logger;

  beforeEach(() => {
    cap = new CaptureTransport();
    log = new Logger({ level: 'debug', transports: [cap] });
  });

  it('includes level, message, ISO timestamp', () => {
    log.info('test message');
    const entry = cap.entries[0];
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('test message');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('includes data when provided', () => {
    log.info('with data', { userId: 'u1', count: 3 });
    expect(cap.entries[0].data).toEqual({ userId: 'u1', count: 3 });
  });

  it('omits data when not provided', () => {
    log.info('no data');
    expect(cap.entries[0].data).toBeUndefined();
  });

  it('error() with Error object populates entry.error', () => {
    const err = new Error('something broke');
    log.error('caught error', err);
    const entry = cap.entries[0];
    expect(entry.error).toBeDefined();
    expect(entry.error!.message).toBe('something broke');
    expect(entry.error!.stack).toBeDefined();
  });

  it('error() with data-only does not set entry.error', () => {
    log.error('context error', { code: 'E001' });
    const entry = cap.entries[0];
    expect(entry.error).toBeUndefined();
    expect(entry.data).toEqual({ code: 'E001' });
  });

  it('fatal() with Error object populates entry.error', () => {
    const err = new Error('fatal boom');
    log.fatal('fatal hit', err);
    const entry = cap.entries[0];
    expect(entry.level).toBe('fatal');
    expect(entry.error!.message).toBe('fatal boom');
  });
});

// ── Child loggers ─────────────────────────────────────────────────────────

describe('Logger — child loggers', () => {
  it('child inherits parent level', () => {
    const cap = new CaptureTransport();
    const parent = new Logger({ level: 'warn', transports: [cap] });
    const child = parent.child('gateway');
    child.info('suppressed by level');
    expect(cap.entries).toHaveLength(0);
    child.warn('passes');
    expect(cap.entries).toHaveLength(1);
  });

  it('child stamps component on every entry', () => {
    const cap = new CaptureTransport();
    const parent = new Logger({ level: 'debug', transports: [cap] });
    const child = parent.child('agent:ShellAgent');
    child.info('ran shell');
    expect(cap.entries[0].component).toBe('agent:ShellAgent');
  });

  it('parent entries have no component when not set', () => {
    const cap = new CaptureTransport();
    const parent = new Logger({ level: 'debug', transports: [cap] });
    parent.info('parent log');
    expect(cap.entries[0].component).toBeUndefined();
  });

  it('child shares the transport array with parent', () => {
    const cap = new CaptureTransport();
    const parent = new Logger({ level: 'debug', transports: [cap] });
    const child = parent.child('sub');
    const extra = new CaptureTransport();
    parent.addTransport(extra);
    child.info('shared transport test');
    // Both original cap and extra should have received the entry
    expect(cap.entries.length + extra.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('nested child logger carries component name', () => {
    const cap = new CaptureTransport();
    const root = new Logger({ level: 'debug', transports: [cap] });
    const child = root.child('channel:telegram');
    child.debug('message received');
    expect(cap.entries[0].component).toBe('channel:telegram');
  });
});

// ── Correlation id ────────────────────────────────────────────────────────

describe('Logger — correlationId', () => {
  it('withCorrelation stamps all entries with correlationId', () => {
    const cap = new CaptureTransport();
    const log = new Logger({ level: 'debug', transports: [cap] });
    const correlated = log.withCorrelation('req-abc');
    correlated.info('start');
    correlated.info('end');
    expect(cap.entries[0].correlationId).toBe('req-abc');
    expect(cap.entries[1].correlationId).toBe('req-abc');
  });

  it('child logger can carry correlation id from parent', () => {
    const cap = new CaptureTransport();
    const log = new Logger({ level: 'debug', transports: [cap] });
    const correlated = log.withCorrelation('trace-xyz');
    const child = correlated.child('gateway');
    child.info('traced');
    expect(cap.entries[0].correlationId).toBe('trace-xyz');
    expect(cap.entries[0].component).toBe('gateway');
  });
});

// ── Transport management ──────────────────────────────────────────────────

describe('Logger — transport management', () => {
  it('addTransport adds a new output', () => {
    const cap1 = new CaptureTransport();
    const cap2 = new CaptureTransport();
    const log = new Logger({ level: 'debug', transports: [cap1] });
    log.addTransport(cap2);
    log.info('dual');
    expect(cap1.entries).toHaveLength(1);
    expect(cap2.entries).toHaveLength(1);
  });

  it('removeTransport stops delivery to that transport', () => {
    const cap = new CaptureTransport();
    const log = new Logger({ level: 'debug', transports: [cap] });
    log.removeTransport(cap);
    log.info('gone');
    expect(cap.entries).toHaveLength(0);
  });

  it('clearTransports removes all outputs', () => {
    const cap = new CaptureTransport();
    const log = new Logger({ level: 'debug', transports: [cap] });
    log.clearTransports();
    log.info('silent');
    expect(cap.entries).toHaveLength(0);
  });

  it('isolates transport errors — other transports still receive', () => {
    const boom: Transport = { write: () => { throw new Error('transport error'); } };
    const cap = new CaptureTransport();
    const log = new Logger({ level: 'debug', transports: [boom, cap] });
    expect(() => log.info('resilient')).not.toThrow();
    expect(cap.entries).toHaveLength(1);
  });
});

// ── ConsoleTransport ──────────────────────────────────────────────────────

describe('ConsoleTransport', () => {
  it('writes to stdout for debug/info/warn without throwing', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const transport = new ConsoleTransport();

    transport.write({ level: 'debug', message: 'dbg', timestamp: new Date().toISOString() });
    transport.write({ level: 'info', message: 'inf', timestamp: new Date().toISOString() });
    transport.write({ level: 'warn', message: 'wrn', timestamp: new Date().toISOString() });

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('writes to stderr for error/fatal', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const transport = new ConsoleTransport();

    transport.write({ level: 'error', message: 'err', timestamp: new Date().toISOString() });
    transport.write({ level: 'fatal', message: 'ftl', timestamp: new Date().toISOString() });

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

// ── FileTransport ─────────────────────────────────────────────────────────

describe('FileTransport', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `openrappter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  });

  it('creates the log file and appends entries', () => {
    const transport = new FileTransport({ filePath: tmpFile });
    transport.write({ level: 'info', message: 'first', timestamp: new Date().toISOString() });
    transport.write({ level: 'warn', message: 'second', timestamp: new Date().toISOString() });
    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content).toContain('first');
    expect(content).toContain('second');
  });

  it('includes component in log line', () => {
    const transport = new FileTransport({ filePath: tmpFile });
    transport.write({
      level: 'info',
      message: 'with component',
      timestamp: new Date().toISOString(),
      component: 'gateway',
    });
    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content).toContain('[gateway]');
  });

  it('rotates file when maxSize is exceeded', () => {
    const transport = new FileTransport({ filePath: tmpFile, maxSize: 10, maxFiles: 2 });
    // Write enough to exceed 10 bytes
    transport.write({ level: 'info', message: 'A'.repeat(50), timestamp: new Date().toISOString() });
    transport.write({ level: 'info', message: 'B'.repeat(50), timestamp: new Date().toISOString() });
    // Rotated file should exist
    expect(fs.existsSync(`${tmpFile}.1`)).toBe(true);
    // Cleanup
    try { fs.unlinkSync(`${tmpFile}.1`); } catch { /* ignore */ }
  });
});

// ── JsonTransport ─────────────────────────────────────────────────────────

describe('JsonTransport', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `openrappter-json-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  });

  it('writes valid JSON lines', () => {
    const transport = new JsonTransport({ filePath: tmpFile });
    transport.write({ level: 'info', message: 'json entry', timestamp: '2026-02-19T00:00:00.000Z' });
    const content = fs.readFileSync(tmpFile, 'utf-8').trim();
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['message']).toBe('json entry');
    expect(parsed['timestamp']).toBe('2026-02-19T00:00:00.000Z');
  });

  it('preserves data and error fields', () => {
    const transport = new JsonTransport({ filePath: tmpFile });
    transport.write({
      level: 'error',
      message: 'with error',
      timestamp: new Date().toISOString(),
      data: { key: 'value' },
      error: { message: 'oops', code: 'E42' },
    });
    const lines = fs.readFileSync(tmpFile, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry['data']).toEqual({ key: 'value' });
    expect((entry['error'] as Record<string, unknown>)['code']).toBe('E42');
  });

  it('rotates file when maxSize is exceeded', () => {
    const transport = new JsonTransport({ filePath: tmpFile, maxSize: 10, maxFiles: 2 });
    transport.write({ level: 'info', message: 'A'.repeat(50), timestamp: new Date().toISOString() });
    transport.write({ level: 'info', message: 'B'.repeat(50), timestamp: new Date().toISOString() });
    expect(fs.existsSync(`${tmpFile}.1`)).toBe(true);
    try { fs.unlinkSync(`${tmpFile}.1`); } catch { /* ignore */ }
  });
});

// ── Global singleton ──────────────────────────────────────────────────────

describe('logger singleton', () => {
  it('is exported and is a Logger instance', () => {
    expect(logger).toBeInstanceOf(Logger);
  });

  it('can create children', () => {
    const child = logger.child('test-component');
    expect(child).toBeInstanceOf(Logger);
  });
});
