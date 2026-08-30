import { createHash } from 'node:crypto';

import { isRappid } from '../rappids/identity.js';
import { CURRENT_PROCESS_START_MARKER } from './process-incarnation.js';

const LIVE_ID_DOMAIN = 'openrappter/live-rappid/1';
const LIVE_ID_SUFFIX_LENGTH = 16;

export interface LiveRappIdentity {
  /** Stable logical identity. This survives process restarts. */
  rappid: string;
  /** PID-linked identity for exactly this process incarnation. */
  liveId: string;
  pid: number;
  incarnation: string;
}

export interface LiveIdentityMetadata {
  rappid: string;
  live_id: string;
  pid: number;
  incarnation: string;
}

export interface DeclareLiveIdentityOptions {
  /** Test seam for a known process start marker. */
  incarnation?: string;
  /** Best-effort process-title writer; injectable so tests do not rename the runner. */
  setProcessTitle?: (liveId: string) => void;
}

let current: Readonly<LiveRappIdentity> | undefined;

export function deriveLiveId(
  rappid: string,
  pid: number,
  incarnation: string,
): string {
  if (!isRappid(rappid)) {
    throw new Error(`Cannot derive a live identity from invalid RAPPID ${JSON.stringify(rappid)}.`);
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Cannot derive a live identity from invalid PID ${JSON.stringify(pid)}.`);
  }
  if (!incarnation.trim()) {
    throw new Error('Cannot derive a live identity without a process incarnation.');
  }
  const suffix = createHash('sha256')
    .update(LIVE_ID_DOMAIN)
    .update('\0')
    .update(rappid)
    .update('\0')
    .update(String(pid))
    .update('\0')
    .update(incarnation)
    .digest('hex')
    .slice(0, LIVE_ID_SUFFIX_LENGTH);
  return `rapp-${pid}-${suffix}`;
}

/**
 * Prove that a live identity binds the stable RAPPID to this exact process.
 */
export function assertIdentityBinding(identity: LiveRappIdentity): LiveRappIdentity {
  if (identity.pid !== process.pid) {
    throw new Error(
      `Live identity PID ${identity.pid} does not match current process PID ${process.pid}.`,
    );
  }
  const expected = deriveLiveId(
    identity.rappid,
    identity.pid,
    identity.incarnation,
  );
  if (identity.liveId !== expected) {
    throw new Error(
      `Live identity ${identity.liveId} is not bound to ${identity.rappid} and PID ${identity.pid}.`,
    );
  }
  return identity;
}

/**
 * Declare the one stable-RAPPID/process binding owned by this process.
 *
 * Repeating the same declaration is idempotent. Any attempt to change the
 * stable RAPPID or incarnation after declaration is identity drift and fails.
 */
export function declareCurrentLiveIdentity(
  rappid: string,
  options: DeclareLiveIdentityOptions = {},
): LiveRappIdentity {
  const incarnation = options.incarnation ?? CURRENT_PROCESS_START_MARKER;
  const candidate = Object.freeze({
    rappid,
    liveId: deriveLiveId(rappid, process.pid, incarnation),
    pid: process.pid,
    incarnation,
  });
  assertIdentityBinding(candidate);

  if (current) {
    if (
      current.rappid !== candidate.rappid
      || current.liveId !== candidate.liveId
      || current.pid !== candidate.pid
      || current.incarnation !== candidate.incarnation
    ) {
      throw new Error(
        `Live identity drift: process ${process.pid} is already bound to ${current.rappid} as ${current.liveId}.`,
      );
    }
    return current;
  }

  current = candidate;
  try {
    (options.setProcessTitle ?? ((liveId: string) => {
      process.title = liveId;
    }))(candidate.liveId);
  } catch {
    // The binding is authoritative; process-title support is only diagnostic.
  }
  return candidate;
}

export function currentLiveIdentity(): LiveRappIdentity | undefined {
  return current;
}

export function liveIdentityMetadata(
  identity: LiveRappIdentity | undefined = currentLiveIdentity(),
): LiveIdentityMetadata | undefined {
  if (!identity) return undefined;
  assertIdentityBinding(identity);
  return {
    rappid: identity.rappid,
    live_id: identity.liveId,
    pid: identity.pid,
    incarnation: identity.incarnation,
  };
}

/** Test seam only: forget the process binding. */
export function __resetCurrentLiveIdentityForTest(): void {
  current = undefined;
}
