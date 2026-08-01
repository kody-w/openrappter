/**
 * Inheriting a twin archetype.
 *
 * An archetype says HOW a twin behaves — voice, working habits, the mandate it
 * must stay inside. It never says WHO it is. So inheritance only ever flows
 * hub → device: this module reads archetypes and writes the local profile, and
 * there is deliberately no function here that sends a profile anywhere.
 *
 * Kept in step with the Python implementation in kody-w/rapp-twin-hub — both
 * are checked against the same archetypes and must produce identical output.
 *
 * https://github.com/kody-w/rapp-twin-hub
 */

import type { TwinProfile } from './types.js';

export const ARCHETYPE_SCHEMA = 'rapp-twin-archetype/1.0';
export const DEFAULT_HUB = 'https://kody-w.github.io/rapp-twin-hub';

const MAX_DEPTH = 8;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

const ALLOWED_TOP = new Set([
  'schema', 'id', 'name', 'summary', 'extends',
  'voice', 'boundaries', 'practices', 'prompts', 'tags', 'author', 'version',
]);
const ALLOWED_VOICE = new Set(['tone', 'avoid', 'signatures']);
const ALLOWED_BOUNDARIES = new Set(['mayDo', 'mustAsk', 'neverDo']);

export interface Archetype {
  schema: string;
  id: string;
  name: string;
  summary: string;
  extends?: string;
  voice?: { tone?: string[]; avoid?: string[]; signatures?: string[] };
  boundaries: { mayDo?: string[]; mustAsk: string[]; neverDo: string[] };
  practices?: string[];
  prompts?: string[];
  tags?: string[];
  author?: string;
  version?: string;
}

export interface ResolvedArchetype extends Archetype {
  /** Root first, this archetype last. */
  lineage: string[];
}

export class ArchetypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchetypeError';
  }
}

/**
 * Reject anything that does not conform, rather than half-loading it.
 *
 * The unknown-field check is the anti-smuggling rule: without it a crafted
 * archetype could carry a field an older client stores blindly.
 */
export function validateArchetype(value: unknown, source: string): Archetype {
  if (typeof value !== 'object' || value === null) {
    throw new ArchetypeError(`${source}: not an object`);
  }
  const data = value as Record<string, unknown>;

  if (data.schema !== ARCHETYPE_SCHEMA) {
    throw new ArchetypeError(`${source}: expected schema ${ARCHETYPE_SCHEMA}, got ${JSON.stringify(data.schema)}`);
  }

  const unknown = Object.keys(data).filter((key) => !ALLOWED_TOP.has(key));
  if (unknown.length > 0) {
    throw new ArchetypeError(`${source}: unknown field(s) ${unknown.sort().join(', ')} — refusing to load`);
  }

  if (typeof data.id !== 'string' || !ID_PATTERN.test(data.id)) {
    throw new ArchetypeError(`${source}: invalid id ${JSON.stringify(data.id)}`);
  }
  for (const key of ['name', 'summary'] as const) {
    if (typeof data[key] !== 'string' || !(data[key] as string).trim()) {
      throw new ArchetypeError(`${source}: ${key} is required`);
    }
  }

  const voice = (data.voice ?? {}) as Record<string, unknown>;
  if (typeof voice !== 'object' || Object.keys(voice).some((k) => !ALLOWED_VOICE.has(k))) {
    throw new ArchetypeError(`${source}: invalid voice section`);
  }

  const boundaries = (data.boundaries ?? {}) as Record<string, unknown>;
  if (typeof boundaries !== 'object' || Object.keys(boundaries).some((k) => !ALLOWED_BOUNDARIES.has(k))) {
    throw new ArchetypeError(`${source}: invalid boundaries section`);
  }
  for (const required of ['mustAsk', 'neverDo'] as const) {
    if (!(required in boundaries)) {
      throw new ArchetypeError(`${source}: boundaries.${required} is required`);
    }
  }

  for (const section of [voice, boundaries]) {
    for (const [key, entry] of Object.entries(section)) {
      if (!Array.isArray(entry) || entry.some((v) => typeof v !== 'string')) {
        throw new ArchetypeError(`${source}: ${key} must be a list of strings`);
      }
    }
  }

  return data as unknown as Archetype;
}

/** Order-preserving, case-insensitive de-duplication. */
export function union(...lists: (string[] | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = item.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
    }
  }
  return out;
}

export type ArchetypeLoader = (id: string) => Promise<unknown>;

/**
 * Walk `extends` to the root and merge back down.
 *
 * Boundaries are additive: a child can add a restriction but never remove one,
 * and a `mayDo` that contradicts an ancestor is dropped. That rule is what
 * makes it safe to inherit an archetype a stranger published.
 */
export async function resolveArchetype(
  id: string,
  load: ArchetypeLoader,
  chain: string[] = [],
): Promise<ResolvedArchetype> {
  if (chain.includes(id)) {
    throw new ArchetypeError(`archetype cycle: ${[...chain, id].join(' -> ')}`);
  }
  if (chain.length >= MAX_DEPTH) {
    throw new ArchetypeError(`archetype chain deeper than ${MAX_DEPTH}: ${chain.join(' -> ')}`);
  }

  const node = validateArchetype(await load(id), id);

  if (!node.extends) {
    return { ...node, voice: node.voice ?? {}, boundaries: node.boundaries, lineage: [id] };
  }

  const parent = await resolveArchetype(node.extends, load, [...chain, id]);

  const mustAsk = union(parent.boundaries.mustAsk, node.boundaries.mustAsk);
  const neverDo = union(parent.boundaries.neverDo, node.boundaries.neverDo);
  const restricted = new Set([...mustAsk, ...neverDo].map((p) => p.trim().toLowerCase()));
  const mayDo = union(parent.boundaries.mayDo, node.boundaries.mayDo).filter(
    (entry) => !restricted.has(entry.trim().toLowerCase()),
  );

  const voice: ResolvedArchetype['voice'] = {};
  for (const key of ['tone', 'avoid', 'signatures'] as const) {
    const merged = union(parent.voice?.[key], node.voice?.[key]);
    if (merged.length > 0) voice[key] = merged;
  }

  return {
    schema: ARCHETYPE_SCHEMA,
    id: node.id,
    name: node.name,
    summary: node.summary,
    extends: node.extends,
    lineage: [...parent.lineage, node.id],
    voice,
    boundaries: {
      ...(mayDo.length > 0 ? { mayDo } : {}),
      mustAsk,
      neverDo,
    },
    practices: union(parent.practices, node.practices),
    prompts: union(parent.prompts, node.prompts),
    tags: union(parent.tags, node.tags),
  };
}

/** Fetch archetypes from a hub over HTTPS. Read-only: no request ever carries a body. */
export function httpLoader(hub: string = DEFAULT_HUB, fetchImpl: typeof fetch = globalThis.fetch): ArchetypeLoader {
  return async (id: string) => {
    if (!ID_PATTERN.test(id)) throw new ArchetypeError(`invalid archetype id ${JSON.stringify(id)}`);

    const url = `${hub.replace(/\/$/, '')}/archetypes/${id}.json`;
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new ArchetypeError(
        response.status === 404
          ? `no archetype "${id}" at ${hub}`
          : `${url}: HTTP ${response.status}`,
      );
    }
    return response.json();
  };
}

export interface InheritResult {
  profile: TwinProfile;
  lineage: string[];
  changed: boolean;
  counts: { voice: Record<string, number>; boundaries: Record<string, number> };
}

/**
 * Add an archetype to a profile.
 *
 * Additive and idempotent. `identity`, `roles`, `context` and `accounts` are
 * never touched — an archetype has no business supplying who someone is — and
 * the owner's own words come first in every merged list.
 */
export function inherit(profile: TwinProfile, resolved: ResolvedArchetype): InheritResult {
  const updated: TwinProfile & { inherits?: string[] } = JSON.parse(JSON.stringify(profile));
  const before = JSON.stringify(updated);

  updated.voice = {
    tone: union(updated.voice?.tone, resolved.voice?.tone),
    avoid: union(updated.voice?.avoid, resolved.voice?.avoid),
    signatures: union(updated.voice?.signatures, resolved.voice?.signatures),
  };

  updated.boundaries = {
    mayDo: union(updated.boundaries?.mayDo, resolved.boundaries.mayDo),
    mustAsk: union(updated.boundaries?.mustAsk, resolved.boundaries.mustAsk),
    neverDo: union(updated.boundaries?.neverDo, resolved.boundaries.neverDo),
  };

  const inherits = updated.inherits ?? [];
  for (const ancestor of resolved.lineage) {
    if (!inherits.includes(ancestor)) inherits.push(ancestor);
  }
  updated.inherits = inherits;

  return {
    profile: updated,
    lineage: resolved.lineage,
    changed: JSON.stringify(updated) !== before,
    counts: {
      voice: Object.fromEntries(Object.entries(updated.voice).map(([k, v]) => [k, v.length])),
      boundaries: Object.fromEntries(Object.entries(updated.boundaries).map(([k, v]) => [k, v.length])),
    },
  };
}
