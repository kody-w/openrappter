import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The Frontier is the exploratory surface. It lives under beta/ and the mainline
// library never points at it — see beta/FRONTIER-BOUNDARY.md. These tests read
// mainline files and never modify them; they fail when a link creeps across.

const betaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(betaRoot, "..");

function mainlinePages() {
  const pages = ["index.html", "README.md"];
  const docs = path.join(repositoryRoot, "docs");
  if (existsSync(docs)) {
    for (const entry of readdirSync(docs)) {
      if (entry.endsWith(".html") || entry.endsWith(".md")) pages.push(path.join("docs", entry));
    }
  }
  return pages.filter((page) => existsSync(path.join(repositoryRoot, page)));
}

// A link INTO the Frontier: an href/src/markdown target that resolves under beta/,
// or a raw GitHub URL that walks into it. The English word "beta" is not a link —
// the landing page legitimately says the project is in beta — so only paths count.
// CHANGED 2026-08-21, deliberately, as the graduation record this test asks for.
// See "Graduation in this distribution" in beta/FRONTIER-BOUNDARY.md.
//
// The boundary exists to keep exploratory work out of a MICROSOFT-FACING library.
// This distribution has no such mainline — its landing page and README are the
// Frontier's own — so the published beta page may be linked from them.
//
// What is still refused is a link into the beta/ SOURCE tree. Pointing a reader
// at docs/beta/ sends them to a published, parity-checked page; pointing them at
// beta/ sends them into a working tree that changes hourly, which is the failure
// this test was written for and still catches.
const FRONTIER_LINK = /(?:href|src)\s*=\s*["'](?:\.{0,2}\/)*beta\/(?!\s*")|\]\((?:\.{0,2}\/)*beta\/|githubusercontent\.com\/[^"'\s]*\/beta\/|github\.io\/[^"'\s]*\/beta\/(?!\s*\))/i;

/** A link to the PUBLISHED page, which is allowed here. Not a link into beta/. */
const PUBLISHED_BETA = /(?:href\s*=\s*["']beta\/["']|github\.io\/openrappter\/beta\/)/i;

test("no mainline page links into the Frontier", () => {
  const offenders = [];
  for (const page of mainlinePages()) {
    const body = readFileSync(path.join(repositoryRoot, page), "utf8");
    for (const [index, line] of body.split("\n").entries()) {
      if (PUBLISHED_BETA.test(line)) continue;
      if (FRONTIER_LINK.test(line)) {
        offenders.push(`${page}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "The mainline library must not link into beta/ (see beta/FRONTIER-BOUNDARY.md).\n"
      + "If something graduated off the Frontier, move it out of beta/ and change this\n"
      + "test in the same commit, with the reason.\n"
      + offenders.join("\n"),
  );
});

test("Frontier documents live under beta/, not in the library's docs", () => {
  const docs = path.join(repositoryRoot, "docs");
  if (!existsSync(docs)) return;
  // A document is the Frontier's when its own text says so: it describes the
  // Frontier shell, its tiles, its arena, or its protocols by name.
  const FRONTIER_SUBJECT = /RAPP Brainstem Frontier|dimension tile|rappid tile|Agent Arena|rappid-tile\/|rar-card\//i;
  const strays = readdirSync(docs)
    .filter((entry) => entry.endsWith(".html") || entry.endsWith(".md"))
    .filter((entry) => FRONTIER_SUBJECT.test(readFileSync(path.join(docs, entry), "utf8")))
    .map((entry) => `docs/${entry}`);
  assert.deepEqual(
    strays,
    [],
    "These documents are about the Frontier and belong under beta/docs/:\n" + strays.join("\n"),
  );
});
