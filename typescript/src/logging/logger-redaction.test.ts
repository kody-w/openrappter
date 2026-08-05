import { describe, it, expect } from 'vitest';
import { Logger, type LogEntry, type Transport } from './logger.js';

// Values are built at runtime. A literal secret in this file would be
// rewritten by scanning before it ever reached the code under test, and the
// test would then pass for the wrong reason.
const secret = (tag: string): string => ['S3CR3T', tag, 'v1'].join('-');

function capture(): { entries: LogEntry[]; transport: Transport } {
  const entries: LogEntry[] = [];
  return { entries, transport: { write: (e) => entries.push(e) } };
}

function loggerWith(): { entries: LogEntry[]; log: Logger } {
  const { entries, transport } = capture();
  return { entries, log: new Logger({ level: 'debug', transports: [transport] }) };
}

describe('Logger redaction at the front door', () => {
  // The redactor and its word list were already tested. Nothing tested that
  // the logger calls them, and it did not.
  it('redacts secrets passed to info()', () => {
    const { entries, log } = loggerWith();
    const value = secret('info');

    log.info('provider configured', { apiKey: value, model: 'gpt-4o' });

    const blob = JSON.stringify(entries);
    expect(blob).not.toContain(value);
    expect(entries[0].data?.apiKey).toBe('***REDACTED***');
    expect(entries[0].data?.model).toBe('gpt-4o');
  });

  it('redacts secrets nested inside the data object', () => {
    const { entries, log } = loggerWith();
    const value = secret('nested');

    log.info('connected', { transport: { privateKey: value, port: 18790 } });

    expect(JSON.stringify(entries)).not.toContain(value);
    const transport = entries[0].data?.transport as Record<string, unknown>;
    expect(transport.privateKey).toBe('***REDACTED***');
    expect(transport.port).toBe(18790);
  });

  it('redacts on the error path too, which takes a separate branch', () => {
    const { entries, log } = loggerWith();
    const value = secret('error');

    log.error('call failed', new Error('boom'), { refresh_token: value });

    expect(JSON.stringify(entries)).not.toContain(value);
    expect(entries[0].data?.refresh_token).toBe('***REDACTED***');
    expect(entries[0].error?.message).toBe('boom');
  });

  it('redacts through a child logger, which builds a new instance', () => {
    const { entries, transport } = capture();
    const value = secret('child');

    new Logger({ level: 'debug', transports: [transport] })
      .child('channel:imessage')
      .warn('transport connection failed', { authToken: value, code: 'ECONNREFUSED' });

    expect(JSON.stringify(entries)).not.toContain(value);
    expect(entries[0].data?.code).toBe('ECONNREFUSED');
    expect(entries[0].component).toBe('channel:imessage');
  });

  it('leaves ordinary diagnostic fields readable', () => {
    // Without this, redacting everything would satisfy the tests above and
    // make the logs useless.
    const { entries, log } = loggerWith();

    log.info('cycle complete', {
      count: 3,
      durationMs: 42,
      host: '127.0.0.1',
      keyCount: 7,
      publicKey: 'ssh-ed25519 AAAA',
    });

    expect(entries[0].data).toMatchObject({
      count: 3,
      durationMs: 42,
      host: '127.0.0.1',
      keyCount: 7,
      publicKey: 'ssh-ed25519 AAAA',
    });
  });

  it('does not emit structures too deep to have been checked', () => {
    const { entries, log } = loggerWith();
    const value = secret('deep');

    let node: Record<string, unknown> = { apiKey: value };
    for (let i = 0; i < 15; i++) node = { child: node };

    log.info('deep', node);

    expect(JSON.stringify(entries)).not.toContain(value);
  });
});
