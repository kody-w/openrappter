#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseJson } from './canonical.js';
import { label, object, text } from './contract.js';
import { CopilotSdkProvider } from './copilot.js';
import { Refusal, publicError, requireThat } from './errors.js';
import { FIXTURE_WARNING, FixtureBrainstem, FixtureCopilotTransport, fixtureSigners, SyntheticIMessage } from './fixtures.js';
import { HeadlessRuntime } from './runtime.js';

export async function request(runtime: HeadlessRuntime, source: string): Promise<unknown> {
  let id: string | null = null;
  try {
    requireThat(Buffer.byteLength(source, 'utf8') <= 65_536, 'request-size', 'Stdio requests are bounded to 64 KiB.');
    const envelope = object(parseJson(source), ['id', 'method', 'params']);
    id = label(envelope.id);
    return { interface: 'rapp-work.stdio/1', id, result: await runtime.dispatch(text(envelope.method, 100), envelope.params, id) };
  } catch (error) { return { interface: 'rapp-work.stdio/1', id, error: publicError(error) }; }
}

export async function serve(runtime: HeadlessRuntime, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  let buffer = '';
  for await (const chunk of input) {
    buffer += String(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) output.write(JSON.stringify(await request(runtime, line)) + '\n');
    }
    requireThat(Buffer.byteLength(buffer, 'utf8') <= 65_536, 'request-size', 'The unframed stdio input exceeded 64 KiB.');
  }
  if (buffer.trim()) output.write(JSON.stringify(await request(runtime, buffer)) + '\n');
}

async function main(args: string[]): Promise<void> {
  if (args.includes('--help') || args.length === 0) {
    console.log('RAPP Work next — headless canonical core\nUsage: node next/dist/cli.js --store <dedicated-directory> [--fixture] [--id request-id] stdio\n   or: node next/dist/cli.js --store <dedicated-directory> [--fixture] [--id request-id] <method> \'<JSON params>\'\nMethods and safety contracts: next/docs/INTERACTION_CONTRACT.md\nNo profile discovery, UI, shell, deletion or fallback model. --fixture explicitly selects synthetic adapters.');
    return;
  }
  let directory: string | undefined;
  let fixture = false;
  let id: string = randomUUID();
  const positional: string[] = [];
  while (args.length) {
    const arg = args.shift()!;
    if (arg === '--store') directory = args.shift();
    else if (arg === '--fixture') fixture = true;
    else if (arg === '--id') id = args.shift() ?? '';
    else if (arg.startsWith('--')) throw new Refusal('cli', 'Unknown CLI option.');
    else positional.push(arg);
  }
  requireThat(directory && positional.length >= 1 && positional.length <= 2, 'cli', 'An explicit store and one method or stdio command are required.');
  label(id);
  const synthetic = fixture ? fixtureSigners() : null;
  const runtime = await HeadlessRuntime.open({
    directory,
    ...(synthetic ? {
      ...synthetic, fixture: true, brainstem: new FixtureBrainstem(),
      provider: new CopilotSdkProvider(new FixtureCopilotTransport(), { mode: 'empty', sessionStorage: 'memory-only', canonicalContextOnly: true }),
      channel: new SyntheticIMessage(),
    } : {}),
  });
  if (fixture) console.error(FIXTURE_WARNING);
  if (positional[0] === 'stdio') {
    requireThat(positional.length === 1, 'cli', 'Stdio does not take inline parameters.');
    process.stdin.setEncoding('utf8');
    await serve(runtime, process.stdin, process.stdout);
  } else {
    const response = await request(runtime, JSON.stringify({ id, method: positional[0], params: parseJson(positional[1] ?? '{}') }));
    console.log(JSON.stringify(response, null, 2));
    if ('error' in (response as object)) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; });
}
