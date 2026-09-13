import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { boundedLines } from '../dist/bounded-stdio.js';
import { canonicalJson } from '../dist/canonical.js';
import { migrationDisplay } from '../dist/migration-endpoint.js';

export class MigrationProjectionConsumer {
  constructor() { this.cursor = null; this.state = null; this.observed = []; }
  accept(event) {
    assert.equal(event.schema, 'rapp-work.migration-event/1');
    if (event.type === 'update') assert.equal(event.previousCursorHash, this.cursor);
    const previousItems = new Set(this.state?.items.map(i => i.id) ?? []);
    const previousRoots = new Set(this.state?.roots.map(r => r.root) ?? []);
    const previousScopes = new Set(this.state?.roots.flatMap(r => r.scopes.map(s => `${r.root}:${s.id}`)) ?? []);
    this.cursor = event.cursorHash;
    this.state = migrationDisplay(event.snapshot);
    const additions = [
      ...this.state.roots.filter(r => !previousRoots.has(r.root)).map(r => ({ kind: 'root', id: r.root, title: r.name })),
      ...this.state.roots.flatMap(r => r.scopes.filter(s => !previousScopes.has(`${r.root}:${s.id}`))
        .map(s => ({ kind: s.kind === 'world' ? 'world' : 'hidden-scope', id: `${r.root}:${s.id}`, title: s.name }))),
      ...this.state.items.filter(i => !previousItems.has(i.id)).map(i => ({ kind: i.kind, id: i.id, title: i.title })),
    ];
    this.observed.push({ cursorHash: this.cursor, additions, counts: this.state.counts });
    return additions;
  }
}

async function main() {
  const consumer = new MigrationProjectionConsumer();
  for await (const line of boundedLines(process.stdin, 1_048_576)) {
    const event = JSON.parse(line);
    const additions = consumer.accept(event);
    const display = { schema: 'rapp-work.passive-migration-display/1', cursorHash: consumer.cursor, additions, state: consumer.state };
    process.stdout.write(canonicalJson(display) + '\n');
    process.stderr.write(`LIVE ${consumer.state.counts.roots} bots · ${consumer.state.counts.scopes} scoped organs · ${consumer.state.counts.pointers} pointers${additions.length ? ' · ' + additions.map(a => a.title).join(', ') : ''}\n`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
