/**
 * The one place that decides where OpenRappter keeps its data.
 *
 * `OPENRAPPTER_HOME` is a documented relocation (README), but it was honoured
 * in 4 places and ignored by 46 that spelled `path.join(os.homedir(),
 * '.openrappter')` inline. Setting it therefore half-moved an installation:
 * the invocation journal, hubs and the iMessage proxy followed it, while
 * sessions, config, backups, the gateway lock, audit config and pairing
 * stayed behind. A backup taken in that state silently omits whatever moved.
 *
 * Splitting the directory is worse than ignoring the variable outright, so
 * every caller resolves through here.
 */
import os from 'os';
import path from 'path';

/** The OpenRappter data directory: `$OPENRAPPTER_HOME`, else `~/.openrappter`. */
export function openrappterHome(): string {
  // Read at call time, not at import time: tests (and `openrappter reset`)
  // change this after modules are loaded, and a captured constant would
  // silently keep pointing at the old directory.
  const override = process.env.OPENRAPPTER_HOME;
  if (override && override.trim() !== '') return override;
  return path.join(os.homedir(), '.openrappter');
}

/** A path inside the data directory. */
export function openrappterPath(...segments: string[]): string {
  return path.join(openrappterHome(), ...segments);
}
