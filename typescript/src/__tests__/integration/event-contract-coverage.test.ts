import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { GatewayEvents } from '../../gateway/types.js';

/**
 * Events, checked the way #181 checks methods.
 *
 * The macOS Bar listened for an `approval` event for its entire life and the
 * gateway never sent one. A command would sit in the approval queue with the
 * screen showing nothing. It was fixed in #192 — but only because an agent
 * happened to notice while doing something else. Nothing compared the two
 * sides, exactly as nothing compared method names before #181.
 *
 * Three things are pinned here:
 *
 *  1. Every event a client listens for is actually emitted. That is the
 *     #192 bug, and it is the assertion that matters.
 *  2. Every emitted event name exists in `GatewayEvents`, so the catalogue
 *     stays the description of reality rather than a subset of it.
 *  3. Catalogue entries that nothing emits are listed, and the list may only
 *     shrink — the same discipline as `KNOWN_MISSING` in #181.
 */

const TS_SRC = resolve(__dirname, '../..');
const REPO = resolve(TS_SRC, '../..');
const BAR_VIEWMODEL = join(REPO, 'macos/Sources/OpenRappterBar/ViewModels/AppViewModel.swift');
const UI_SRC = join(REPO, 'typescript/ui/src');

/**
 * Emitted without a `GatewayEvents` member.
 *
 * Not permission — a name that only exists as a string literal cannot be
 * found by anyone reading the catalogue, which is how a subscriber ends up
 * waiting for something that never arrives.
 */
const EMITTED_OUTSIDE_CATALOGUE = new Set([
  'stream.block',
  'zen.session.start',
  'zen.session.end',
  'zen.frame',
]);

/**
 * `gateway/methods/*.ts` modules that `GatewayServer` actually invokes.
 *
 * The other twenty are dormant (see #190). `twin-methods.ts` broadcasts
 * `twin.message` and `twin.status`, but nothing registers it, so those are not
 * emissions — counting them would report a wire that does not exist.
 */
function invokedMethodModules(): Set<string> {
  const server = readFileSync(join(TS_SRC, 'gateway/server.ts'), 'utf-8');
  const invoked = new Set<string>();
  for (const file of readdirSync(join(TS_SRC, 'gateway/methods'))) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const source = readFileSync(join(TS_SRC, 'gateway/methods', file), 'utf-8');
    const fn = source.match(/export function (register[A-Za-z]+)/)?.[1];
    if (fn && new RegExp(`\\b${fn}\\s*\\(`).test(server)) invoked.add(file);
  }
  return invoked;
}

/**
 * Declared but never emitted. Anyone subscribing to one of these waits
 * forever. This list may only shrink: either start emitting it, or delete it.
 */
const DECLARED_BUT_NEVER_EMITTED = new Set([
  'agent.stream',
  'agent.tool',
  'channel',
  'channel.message',
  'channel.status',
  'chat.message',
  'cron',
  'cron.complete',
  'cron.run',
  'error',
  'rappter',
  'rappter.summon',
]);

function sourceFiles(dir: string, extensions: string[]): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && entry !== '__tests__') walk(full);
        continue;
      }
      if (extensions.some((ext) => entry.endsWith(ext)) && !entry.includes('.test.')) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

/** Event names the gateway can actually put on the wire. */
function emittedEvents(): Set<string> {
  const emitted = new Set<string>();
  const methodsDir = join(TS_SRC, 'gateway/methods');
  const invoked = invokedMethodModules();
  for (const file of sourceFiles(TS_SRC, ['.ts'])) {
    // A broadcast inside a module nothing registers never reaches a client.
    if (file.startsWith(methodsDir) && !invoked.has(file.slice(methodsDir.length + 1))) continue;
    const source = readFileSync(file, 'utf-8');
    for (const match of source.matchAll(
      /\b(?:broadcastEvent|broadcast)\(\s*GatewayEvents\.([A-Z_]+)/g,
    )) {
      const value = (GatewayEvents as Record<string, string>)[match[1]];
      if (value) emitted.add(value);
    }
    for (const match of source.matchAll(
      /\b(?:broadcastEvent|broadcast)\(\s*['"]([a-z][a-z.]+)['"]/g,
    )) {
      emitted.add(match[1]);
    }
  }
  return emitted;
}

/** Event names the macOS Bar dispatches on. */
function barListeners(): Map<string, string> {
  const listeners = new Map<string, string>();
  const bar = readFileSync(BAR_VIEWMODEL, 'utf-8');
  const handleEvent = bar.slice(bar.indexOf('func handleEvent'));
  for (const match of handleEvent.matchAll(/case\s+"([a-z][a-z.]*)"/g)) {
    listeners.set(match[1], 'macOS Bar AppViewModel.handleEvent');
  }
  return listeners;
}

/** Event names the web UI subscribes to. */
function uiListeners(): Map<string, string> {
  const listeners = new Map<string, string>();
  for (const file of sourceFiles(UI_SRC, ['.ts'])) {
    const source = readFileSync(file, 'utf-8');
    for (const call of source.matchAll(/\.subscribe\(\s*\[([^\]]+)\]/g)) {
      for (const name of call[1].matchAll(/['"]([a-z][a-z.]*)['"]/g)) {
        listeners.set(name[1], file.replace(`${REPO}/`, ''));
      }
    }
  }
  return listeners;
}

/** Every client listener, from both clients. */
function listenedEvents(): Map<string, string> {
  return new Map([...barListeners(), ...uiListeners()]);
}

describe('every event a client waits for is one the gateway sends', () => {
  it('finds listeners and emitters on both sides', () => {
    // Guards the parsers. Asserted per source on purpose: a combined count
    // hides one parser breaking, because the other keeps the total up. That
    // is exactly what happened to the first version of this test — breaking
    // the Bar regex changed nothing, since the UI parser still found four.
    expect(barListeners().size).toBeGreaterThan(0);
    expect(uiListeners().size).toBeGreaterThan(0);
    expect(emittedEvents().size).toBeGreaterThan(4);
  });

  it('no client waits for an event nothing emits', () => {
    const emitted = emittedEvents();
    const orphans = [...listenedEvents().entries()]
      .filter(([name]) => !emitted.has(name))
      .map(([name, where]) => `${name} (listened for in ${where})`)
      .sort();
    expect(orphans).toEqual([]);
  });

  it('every emitted name is in the catalogue, or listed as an exception', () => {
    const known = new Set(Object.values(GatewayEvents) as string[]);
    const strays = [...emittedEvents()]
      .filter((name) => !known.has(name) && !EMITTED_OUTSIDE_CATALOGUE.has(name))
      .sort();
    expect(strays).toEqual([]);
  });

  it('the never-emitted list contains nothing that is now emitted', () => {
    // Makes the list self-cleaning: wiring one up fails here until it is
    // removed, so the list cannot rot into a permanent excuse.
    const emitted = emittedEvents();
    const stale = [...DECLARED_BUT_NEVER_EMITTED].filter((name) => emitted.has(name)).sort();
    expect(stale).toEqual([]);
  });

  it('the never-emitted list still describes the catalogue', () => {
    // If one is deleted from GatewayEvents, this list should lose it too,
    // rather than keep naming something that no longer exists.
    const known = new Set(Object.values(GatewayEvents) as string[]);
    const ghosts = [...DECLARED_BUT_NEVER_EMITTED].filter((name) => !known.has(name)).sort();
    expect(ghosts).toEqual([]);
  });
});
