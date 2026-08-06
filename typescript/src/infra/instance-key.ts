/**
 * A name becomes a key here, and nowhere else.
 *
 * This lived in `gateway-lock.ts`, which is the right place conceptually and
 * the wrong place structurally: that module `require`s `better-sqlite3` at
 * module scope for the runtime lock. So importing one pure string function
 * dragged a native dependency behind it, and the Dashboard UI suite — which
 * imports `GatewayServer`, which knows which rappter it is — died on a runner
 * that has no such dependency:
 *
 *     Error: Cannot find module 'better-sqlite3'
 *     Require stack: typescript/src/infra/gateway-lock.ts
 *     Test Files  1 failed | 7 passed (8)
 *
 * Splitting it out keeps ONE implementation while removing the edge. Everything
 * that imported it from `gateway-lock` still can — that module re-exports it —
 * so this is not a second derivation, it is the same one with a lighter home.
 */

/**
 * The single canonical form of an instance name.
 *
 * `canonicalInstanceKey` decides what an instance's directory, its lock and its
 * port are called, so anything that compares names must use it or it is
 * comparing two different facts. #142 was exactly that: a gateway published its
 * raw `--instance` string while the roster looked for the canonical key, and a
 * live twin was reported dead.
 */
export function canonicalInstanceKey(name: string): string {
  const raw = name.trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (/^\.+$/.test(cleaned) || cleaned === '') {
    return `_${Buffer.from(raw).toString('hex')}`;
  }
  return cleaned;
}
