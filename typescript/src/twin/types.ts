/**
 * The digital twin — who the rappter is when it is being you.
 *
 * Everything in this file is *shape*. Not one value defined here is personal.
 * The content lives on the device, in a vault that refuses to sit inside a git
 * working tree, so the public repo carries the schema and the machinery and
 * never the person.
 *
 *   The engine is public. The consciousness is local.
 *
 * That is not a policy note — `vault.ts` enforces it and `twin.test.ts` proves
 * it on every run.
 */

/** Bump when the on-disk shape changes; the vault migrates forward. */
export const TWIN_SCHEMA_VERSION = 1;

export interface TwinIdentity {
  /** What to call them. */
  name: string;
  /** What the twin answers to in chat. */
  shortName?: string;
  pronouns?: string;
  timezone?: string;
  locale?: string;
}

export interface TwinRole {
  title: string;
  org?: string;
  /** What they actually spend time on in this role. */
  focus?: string;
}

export interface TwinVoice {
  /** How they sound: "direct", "dry", "concise". */
  tone: string[];
  /** Habits to suppress: "hedging", "corporate filler", "restating the question". */
  avoid: string[];
  /** Turns of phrase and tells that make it recognisably them. */
  signatures: string[];
}

export interface TwinProject {
  name: string;
  what: string;
  /** Where it lives — a repo, a folder, a URL. */
  where?: string;
}

export interface TwinPerson {
  name: string;
  relationship: string;
  notes?: string;
}

export interface TwinContext {
  projects: TwinProject[];
  people: TwinPerson[];
  tools: string[];
  /** Standing facts the twin should never have to be told twice. */
  facts: string[];
}

/**
 * The mandate. Same shape as the phone agent's constraints, for the same
 * reason: the twin is autonomous inside this and never outside it.
 */
export interface TwinBoundaries {
  mayDo: string[];
  mustAsk: string[];
  neverDo: string[];
}

export interface TwinProfile {
  version: number;
  /** Local identifier. Not a secret, but not published either. */
  id: string;
  createdAt: string;
  updatedAt: string;
  identity: TwinIdentity;
  roles: TwinRole[];
  voice: TwinVoice;
  context: TwinContext;
  boundaries: TwinBoundaries;
  /**
   * Archetype ids this twin has inherited, root first.
   *
   * Provenance: it should always be possible to see where a boundary came
   * from, rather than wondering why the twin refuses to do something.
   */
  inherits?: string[];
  /**
   * Handles, addresses, numbers.
   *
   * Never exported and never printed unless explicitly asked for. Present so
   * the twin can *act*, not so it can talk about them.
   */
  accounts: Record<string, string>;
}

/**
 * What may leave the device: counts and field names, never a value.
 *
 * The rule is deliberately blunt. A per-field "is this one sensitive?" list is
 * a rule someone forgets to update when they add a field; "no values, ever" is
 * a rule that stays true as the schema grows.
 */
export interface TwinShape {
  schema: 'rapp-twin-shape/1.0';
  version: number;
  present: {
    identity: string[];
    roles: number;
    voice: { tone: number; avoid: number; signatures: number };
    context: { projects: number; people: number; tools: number; facts: number };
    boundaries: { mayDo: number; mustAsk: number; neverDo: number };
    accounts: number;
  };
  /** Lets two machines tell whether they hold the same twin without sharing it. */
  fingerprint: string;
}

export function emptyProfile(id: string, name: string, now: string): TwinProfile {
  return {
    version: TWIN_SCHEMA_VERSION,
    id,
    createdAt: now,
    updatedAt: now,
    identity: { name },
    roles: [],
    voice: { tone: [], avoid: [], signatures: [] },
    context: { projects: [], people: [], tools: [], facts: [] },
    boundaries: {
      mayDo: [],
      // A twin with no stated limits must still not be able to commit you.
      mustAsk: [
        'spend money or agree to a price',
        'commit to a meeting, a date or a deadline',
        'send anything to someone outside the household or company',
        'publish anything publicly',
      ],
      neverDo: [
        'share personal details, addresses, account handles or phone numbers',
        'speak for anyone other than the owner',
        'claim to be a human being',
      ],
    },
    accounts: {},
  };
}
