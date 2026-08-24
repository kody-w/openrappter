import { describe, expect, it } from 'vitest';

import { runBoundedMediaProcess } from './process.js';

describe('bounded media child processes', () => {
  it('captures bounded output without invoking a shell', async () => {
    const result = await runBoundedMediaProcess(
      process.execPath,
      ['-e', 'process.stdout.write("ok")'],
      { timeoutMs: 2_000, maxStdoutBytes: 16, maxStderrBytes: 16 },
    );
    expect(result.stdout.toString()).toBe('ok');
  });

  it('kills processes that exceed output or time limits', async () => {
    await expect(runBoundedMediaProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(1024))'],
      { timeoutMs: 2_000, maxStdoutBytes: 32, maxStderrBytes: 32 },
    )).rejects.toThrow(/stdout exceeded/);
    await expect(runBoundedMediaProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 25, maxStdoutBytes: 32, maxStderrBytes: 32 },
    )).rejects.toThrow(/exceeded 25 ms/);
  });
});
