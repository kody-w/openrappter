/**
 * Which rappter is this process? — #129
 *
 * A hatched twin ran the Neighbor agent and told the peer it was the alpha:
 *
 *   $ openrappter hatch pebble        -> pebble is up on :19057 (pid 24359)
 *   (pebble sends)
 *   POST /twin  {"from_rappid":"rappid:@kody-w/alpha:f245acdb...", ...}
 *
 * `NeighborAgent` had a literal `deviceRappid('kody-w', 'alpha')`, because the
 * agent registry constructs agents with NO arguments — an agent cannot be told
 * anything at construction, so it had nothing else to say.
 *
 * The value was never unknown. `index.ts` resolves it at startup from
 * `--instance` or `OPENRAPPTER_INSTANCE` in order to pick the lock and the
 * port. This module exists so that ONE derivation is published rather than a
 * second one being invented somewhere else — the failure that produced #101
 * (lock and port derived apart) and #118 (roster and sender derived apart) was
 * exactly two derivations of one fact drifting.
 *
 * Undeclared is not the same as alpha. A process that never declared is a
 * process that did not go through gateway startup, and guessing "alpha" there
 * is how the original defect read: a confident answer nobody had checked.
 * Callers are expected to handle `undefined` by refusing, not by defaulting.
 */

let current: string | undefined;
let declared = false;

/**
 * Record which rappter this process is serving as. `undefined` means the
 * alpha, which is a real answer — distinct from never having declared.
 */
export function declareCurrentInstance(instance: string | undefined): void {
  current = instance && instance.trim() ? instance.trim() : undefined;
  declared = true;
}

/** The declared instance name, or `undefined` for the alpha. */
export function currentInstanceName(): string | undefined {
  return current;
}

/**
 * Has anything declared? False means this process is not a gateway, and no
 * caller should assume which rappter it is.
 */
export function currentInstanceDeclared(): boolean {
  return declared;
}

/** Test seam only: forget the declaration. */
export function __resetCurrentInstanceForTest(): void {
  current = undefined;
  declared = false;
}
