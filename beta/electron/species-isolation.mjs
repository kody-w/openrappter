import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

function canonical(value) {
  const resolved = path.resolve(String(value || ""));
  if (existsSync(resolved)) return realpathSync(resolved);
  const suffix = [];
  let ancestor = resolved;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return resolved;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(realpathSync(ancestor), ...suffix);
}

function contains(parent, child) {
  const root = canonical(parent);
  const target = canonical(child);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export function assertOpenRappterSpeciesIsolation({
  home,
  openRappterHome,
  betaHome,
  brainstemHome,
  brainstemDir,
} = {}) {
  if (!home || !openRappterHome || !betaHome || !brainstemHome || !brainstemDir) {
    throw new Error("Species isolation requires all OpenRappter and Brainstem roots.");
  }
  const roots = {
    openRappterHome: canonical(openRappterHome),
    betaHome: canonical(betaHome),
    brainstemHome: canonical(brainstemHome),
    brainstemDir: canonical(brainstemDir),
    standaloneBrainstemHome: canonical(path.join(home, ".brainstem")),
  };
  if (
    contains(roots.standaloneBrainstemHome, roots.openRappterHome)
    || contains(roots.standaloneBrainstemHome, roots.betaHome)
    || contains(roots.standaloneBrainstemHome, roots.brainstemHome)
    || contains(roots.standaloneBrainstemHome, roots.brainstemDir)
  ) {
    throw new Error(
      "Refusing species driftback: OpenRappter mutable state cannot share bare Brainstem paths.",
    );
  }
  if (
    !contains(roots.openRappterHome, roots.brainstemHome)
    || !contains(roots.openRappterHome, roots.betaHome)
    || !contains(roots.brainstemHome, roots.brainstemDir)
  ) {
    throw new Error(
      "Refusing species driftback: OpenRappter Brainstem paths must stay inside its own home.",
    );
  }
  return roots;
}
