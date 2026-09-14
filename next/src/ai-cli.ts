#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadlessRuntime } from './runtime.js';
import { fixtureSigners, FIXTURE_WARNING } from './fixtures.js';
import { isBodyStream } from './canonical.js';
import { AiEndpoint, serveAi } from './ai-endpoint.js';
import { BoundedWriter } from './bounded-stdio.js';
import { publicError, Refusal, requireThat } from './errors.js';

async function main(args: string[]): Promise<void> {
  if (args.includes('--help')) {
    console.log('RAPP Work Bot — provider-neutral authenticated context, proposals and projection\nUsage: node next/dist/ai-cli.js --store <canonical-store> --root <exact-RAPPID> [--mcp|--stdio] [--fixture]\nSupply RAPP_WORK_CAPABILITY through the AI host secret/environment binding, never skill.md or publication text.\nStructured proposals remain review-only; exact confirmation and mutation are owner-only. No HTTP listener, model inference, root administration, native scanning or product UI.');
    return;
  }
  let directory: string | undefined, root: string | undefined;
  let mode: 'mcp' | 'stdio' = 'mcp';
  let fixture = false;
  while (args.length) {
    const option = args.shift();
    if (option === '--store') directory = args.shift();
    else if (option === '--root') root = args.shift();
    else if (option === '--mcp') mode = 'mcp';
    else if (option === '--stdio') mode = 'stdio';
    else if (option === '--fixture') fixture = true;
    else throw new Refusal('cli', 'Unknown or incomplete provider-neutral endpoint option.');
  }
  requireThat(directory && isBodyStream(root), 'client-setup', 'An explicit canonical store and full root GUID are required.');
  const capability = process.env.RAPP_WORK_CAPABILITY;
  requireThat(capability && /^[A-Za-z0-9_-]{43}$/u.test(capability), 'client-setup', 'An independently issued connection capability must be supplied through the host environment.');
  const keys = fixture ? fixtureSigners() : null;
  const runtime = await HeadlessRuntime.open({ directory, ...(keys ? { ...keys, fixture: true } : {}) });
  await runtime.ai.authority.authorize(root, capability, ['projection.read']);
  if (fixture) console.error(FIXTURE_WARNING);
  const writer = new BoundedWriter(process.stdout);
  const endpoint = new AiEndpoint(runtime.ai, root, capability, mode, message => writer.send(message));
  await serveAi(endpoint, process.stdin, writer);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; });
}
