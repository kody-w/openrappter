import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "..");
const target = path.join(packageRoot, "dist", "clever-girl");
const assets = [
  ["scripts/rapter-clever-girl.mjs", "rapter-clever-girl.mjs"],
  ["scripts/rapter-clever-girl-context.mjs", "rapter-clever-girl-context.mjs"],
  ["scripts/rapter-clever-girl-reader.mjs", "rapter-clever-girl-reader.mjs"],
  [
    "scripts/rapter-clever-girl-schema-validator.mjs",
    "rapter-clever-girl-schema-validator.mjs",
  ],
  [
    "contracts/rapter-clever-girl-observe-v2.json",
    "rapter-clever-girl-observe-v2.json",
  ],
  [
    "contracts/rapter-clever-girl-observe-v3.json",
    "rapter-clever-girl-observe-v3.json",
  ],
  [
    "contracts/rapter-clever-girl-capability-catalog-v2.json",
    "rapter-clever-girl-capability-catalog-v2.json",
  ],
  [
    "contracts/rapter-clever-girl-repair-assignments-v1.json",
    "rapter-clever-girl-repair-assignments-v1.json",
  ],
  [".claude/skills/rapter-clever-girl-observe/SKILL.md", "SKILL.md"],
];

const contract = JSON.parse(
  readFileSync(
    path.join(
      repositoryRoot,
      "contracts",
      "rapter-clever-girl-observe-v2.json",
    ),
    "utf8",
  ),
);
const v3Contract = JSON.parse(
  readFileSync(
    path.join(
      repositoryRoot,
      "contracts",
      "rapter-clever-girl-observe-v3.json",
    ),
    "utf8",
  ),
);
if (
  contract.properties?.schemaVersion?.const !== "rapter-clever-girl.observe.v2"
) {
  throw new Error("Clever Girl package contract is not Observe Mode v2.");
}
if (
  v3Contract.properties?.schemaVersion?.const !==
  "rapter-clever-girl.observe.v3"
) {
  throw new Error("Clever Girl package contract is not Observe Mode v3.");
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const [source, destination] of assets) {
  copyFileSync(
    path.join(repositoryRoot, source),
    path.join(target, destination),
  );
}
