#!/usr/bin/env node
// rapp-drill — find work another machine already did, and absorb what is safe.
//
//   node beta/scripts/rapp-drill.mjs status
//   node beta/scripts/rapp-drill.mjs scan    <source>
//   node beta/scripts/rapp-drill.mjs fold    <source>
//   node beta/scripts/rapp-drill.mjs restore
//   node beta/scripts/rapp-drill.mjs log
//
// A source is a path or a URL to a commons document. --root chooses the store
// (default ~/.rapp-drill).
//
// Everything it keeps is plain files. If this command disappears, the record it
// left is still readable with cat.

import { homedir } from "node:os";
import path from "node:path";

import {
  createStore, fold, journal, restore, scan, status,
} from "../electron/drill-app.mjs";

const bold = (t) => `\x1b[1m${t}\x1b[0m`;
const dim = (t) => `\x1b[2m${t}\x1b[0m`;
const green = (t) => `\x1b[32m${t}\x1b[0m`;
const red = (t) => `\x1b[31m${t}\x1b[0m`;
const short = (h) => (h ? String(h).slice(0, 8) : "—");
const COMMANDS = new Set(["status", "scan", "fold", "restore", "log"]);

function usage() {
  process.stdout.write(`${bold("rapp-drill")} — find work another machine already did

  status              what this device holds
  scan    <source>    find what a commons shares with you. Changes nothing.
  fold    <source>    checkpoint, then absorb what is compatible
  restore             return to the last checkpoint
  log                 what has happened here

  --root <dir>        which store to use (default ~/.rapp-drill)

A source is a path or a URL to a commons document.
`);
}

function parse(argv) {
  const args = [...argv];
  let root = path.join(homedir(), ".rapp-drill");
  const rest = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--root") root = args.shift();
    else if (arg === "--help" || arg === "-h") return { command: "help", root, rest };
    else rest.push(arg);
  }
  return { command: rest.shift(), root, rest };
}

async function main() {
  const { command, root, rest } = parse(process.argv.slice(2));
  if (!command || command === "help") {
    usage();
    return 0;
  }
  if (!COMMANDS.has(command)) {
    process.stderr.write(`${red("unknown command")} ${command}\n`);
    usage();
    return 1;
  }
  const store = createStore(root);

  if (command === "status") {
    const s = status(store);
    process.stdout.write(`${bold("store")}       ${s.root}
frames      ${s.frames}
head        ${short(s.head)}
checkpoints ${s.checkpoints}
folds       ${s.folds}
restores    ${s.restores}
`);
    return 0;
  }

  if (command === "log") {
    const entries = journal(store);
    if (!entries.length) {
      process.stdout.write(dim("nothing has happened here yet\n"));
      return 0;
    }
    for (const entry of entries) {
      const merged = Array.isArray(entry.detail?.merged) ? entry.detail.merged.length : 0;
      const refused = Array.isArray(entry.detail?.refused) ? entry.detail.refused.length : 0;
      const rejected = Array.isArray(entry.detail?.rejected) ? entry.detail.rejected.length : 0;
      const detail = entry.event === "fold"
        ? `${merged} merged, ${refused} refused, ${rejected} rejected ${dim(entry.detail.source)}`
        : entry.event === "restore"
          ? `to ${entry.detail.restoredTo}`
          : "";
      process.stdout.write(`${dim(entry.utc)}  ${bold(entry.event.padEnd(8))} ${detail}\n`);
    }
    return 0;
  }

  if (command === "restore") {
    const result = restore(store);
    if (!result.ok) {
      process.stderr.write(`${red("cannot restore")} — ${result.reason}\n`);
      return 1;
    }
    const superseded = result.superseded
      ? dim(`what you stepped away from is kept as superseded/${result.superseded}`)
      : dim("the previous live line was empty");
    process.stdout.write(`${green("restored")} to ${result.restoredTo}
head     ${short(result.head)}
${superseded}
`);
    return 0;
  }

  const source = rest[0];
  if (!source) {
    process.stderr.write(`${red("no source")} — ${command} needs a path or a URL\n`);
    return 1;
  }

  if (command === "scan") {
    const found = await scan(store, source);
    process.stdout.write(`${bold("scanned")} ${found.source}
searched ${found.searched} coordinates, ${found.pairs.length} pair${found.pairs.length === 1 ? "" : "s"}
fixed    ${found.fixedPoints.length} ${dim("(identical bytes, different ancestry)")}
`);
    for (const run of found.runs) {
      process.stdout.write(`  run ticks ${run.startHere}–${run.endHere}: length ${run.length}, substance ${run.substance}\n`);
    }
    process.stdout.write(found.alignment.ok
      ? `align    ratio ${found.alignment.ratio}, ${found.alignment.pins.length} pin${found.alignment.pins.length === 1 ? "" : "s"}\n`
      : `align    ${dim(found.alignment.reason)}\n`);
    for (const bad of found.rejected) {
      process.stdout.write(`  ${red("rejected")} ${short(bad.frame)} ${dim(bad.reason)}\n`);
    }
    process.stdout.write(dim("\nnothing was changed — scanning is safe to run as often as you like\n"));
    return 0;
  }

  if (command === "fold") {
    const result = await fold(store, source);
    const checkpoint = result.checkpoint
      ? dim(`checkpoint ${result.checkpoint} taken before anything was written`)
      : dim("no checkpoint needed — nothing was written");
    process.stdout.write(`${bold("folded")} ${result.source}
${checkpoint}
`);
    for (const frame of result.merged) {
      process.stdout.write(`  ${green("merged  ")} ${short(frame.frame_hash)} ${JSON.stringify(frame.payload?.asserts ?? {})}\n`);
    }
    for (const entry of result.refused) {
      const why = entry.contradicts?.[0];
      const reason = why?.reason || (why ? `${why.key}: needed ${JSON.stringify(why.required)}, offered ${JSON.stringify(why.asserted)}` : "refused");
      process.stdout.write(`  ${red("refused ")} ${short(entry.frame)} ${dim(reason)}\n`);
    }
    if (!result.joined) {
      process.stdout.write(dim("\nnothing new to absorb — the line is unchanged\n"));
      return 0;
    }
    process.stdout.write(`\nhead ${short(result.head)}\n${dim("run `restore` to go back; the fold is recorded either way")}\n`);
    return 0;
  }

  throw new Error(`command ${command} was accepted but not handled`);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // A failure names itself and exits non-zero. Never a silent "nothing found".
    process.stderr.write(`${red("failed")} — ${error.message}\n`);
    process.exit(1);
  });
