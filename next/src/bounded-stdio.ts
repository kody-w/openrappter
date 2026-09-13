import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { canonicalJson } from './canonical.js';
import { Refusal, requireThat } from './errors.js';
import { AI_LIMITS } from './ai-contract.js';

export async function* boundedLines(input: Readable, maxBytes = 65_536): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      requireThat(Buffer.byteLength(line) <= maxBytes, 'transport-size', 'The framed request exceeded its byte bound.');
      if (line.trim()) yield line;
    }
    requireThat(Buffer.byteLength(buffer) <= maxBytes, 'transport-size', 'The unframed request exceeded its byte bound.');
  }
  buffer += decoder.end();
  requireThat(Buffer.byteLength(buffer) <= maxBytes, 'transport-size', 'The final request exceeded its byte bound.');
  if (buffer.trim()) yield buffer;
}

export class BoundedWriter {
  readonly #queue: string[] = [];
  #bytes = 0;
  #draining: Promise<void> | null = null;
  #failed: Error | null = null;
  constructor(readonly output: Writable, readonly byteLimit: number = AI_LIMITS.outputBytes, readonly drainMs: number = 2_000) {
    requireThat(byteLimit >= 1_024 && byteLimit <= AI_LIMITS.outputBytes && drainMs > 0 && drainMs <= 5_000,
      'transport-bounds', 'Transport bounds may not exceed the hard byte/deadline limits.');
    output.on('error', error => { this.#failed = error; this.#queue.length = 0; this.#bytes = 0; });
  }
  send(message: unknown): void {
    requireThat(!this.#failed && !this.output.destroyed, 'transport-closed', 'The bounded output transport is closed.');
    const line = canonicalJson(message) + '\n';
    const bytes = Buffer.byteLength(line);
    requireThat(this.#queue.length < 64 && this.#bytes + this.output.writableLength + bytes <= this.byteLimit,
      'transport-backpressure', 'The subscriber exceeded the output bound. Reconnect using the last applied canonical cursor.');
    this.#queue.push(line);
    this.#bytes += bytes;
    this.#start();
  }
  #start(): void {
    if (this.#draining) return;
    this.#draining = this.#drain().catch(error => {
      this.#failed = error instanceof Error ? error : new Refusal('transport-closed', 'Output failed.');
      this.#queue.length = 0;
      this.#bytes = 0;
    }).finally(() => {
      this.#draining = null;
      if (this.#queue.length && !this.#failed) this.#start();
    });
  }
  async #drain(): Promise<void> {
    while (this.#queue.length) {
      const line = this.#queue.shift()!;
      this.#bytes -= Buffer.byteLength(line);
      if (!this.output.write(line)) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.drainMs);
        try { await once(this.output, 'drain', { signal: abort.signal }); }
        finally { clearTimeout(timer); }
      }
    }
  }
  async flush(): Promise<void> {
    if (this.#queue.length && !this.#draining) this.#start();
    while (this.#draining) await this.#draining;
    requireThat(!this.#failed, 'transport-backpressure', 'Output could not drain within the bounded deadline; canonical work was retained.');
  }
  status(): { bytes: number; messages: number; failed: boolean } {
    return { bytes: this.#bytes + this.output.writableLength, messages: this.#queue.length, failed: this.#failed !== null };
  }
}
