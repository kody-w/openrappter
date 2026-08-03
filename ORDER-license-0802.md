# ORDER — relicense openrappter to match Buzz

## 0. What Kody asked for

> "then for openrappter utilize the same terms of service that jack dorsey's buzz uses
> to make it able to still be a startup while still building in public."

## 1. What Buzz actually uses — researched, not assumed

Block released **Buzz** on 2026-07-21: an open-source, agent-first workspace built on
Nostr, hosted at `buzz.xyz`, source at `github.com/block/buzz`. Dorsey's framing was
"model-agnostic, decentralized, self-sovereign, and open source."

**The licence is Apache 2.0.**

Before writing anything, **fetch `github.com/block/buzz` and read its actual `LICENSE`,
`NOTICE`, and any `CONTRIBUTING`/CLA or DCO file.** Confirm Apache-2.0 from the repo
itself rather than from reporting, and mirror the *structure* they use — a licence alone
is not what they shipped. If what you find differs from the above, **the repo wins** and
you tell me.

## 2. Why this actually serves "startup while building in public"

Kody's goal is the reasoning, so get the mechanism right. openrappter is **MIT** today.
The move to Apache 2.0 buys three things MIT does not have:

- **§3 express patent grant + retaliation.** Contributors grant patent rights, and the
  grant terminates for anyone who sues you over patents. MIT is silent on patents
  entirely. For a company building in the open, this is the whole ballgame.
- **§6 explicit trademark non-grant.** The licence gives away the code and *not* the
  name. This pairs exactly with the existing `TRADEMARK.md` ("integration is the
  license") — keep that file; Apache §6 backs it rather than replacing it.
- **NOTICE preservation + change notices.** Attribution survives redistribution, which
  MIT only weakly achieves.

It is also the license enterprise buyers and acquirers expect, which is the "still be a
startup" half of the sentence.

## 2b. The copyright holder becomes Wildhaven Homes LLC

Kody: *"then assign openrappter rights to wildhaven homes llc"*

Today `LICENSE` reads `Copyright (c) 2025 Kody W`. Every attribution surface must name
the entity instead:

- `LICENSE` — Apache 2.0's copyright line: `Copyright 2026 Wildhaven Homes LLC`
- `NOTICE` — `openrappter` / `Copyright 2026 Wildhaven Homes LLC`
- `package.json` / `pyproject.toml` — `author` (or `holder`) set to `Wildhaven Homes LLC`
- `TRADEMARK.md` — the marks are held by the entity now; update the holder, keep the
  "integration is the license" substance exactly as written
- `README.md` footer, if it names a copyright holder

Keep Kody's personal authorship in git history and in any AUTHORS/contributors list —
**ownership moving to the LLC does not erase who wrote it**, and rewriting authorship
would defeat the point of the history work in `ORDER-history-0802.md`.

**State this in the report, do not skip it:** editing a `LICENSE` file **declares** the
holder, it does not **transfer** anything. Under 17 U.S.C. §204(a) a transfer of
copyright ownership is only effective in a **signed written instrument** from the owner.
So Kody needs a one-page IP assignment — Kody Wildfeuer (individual) assigning the
openrappter copyright and related IP to Wildhaven Homes LLC, dated and signed — for the
repo text to be true. That is standard formation paperwork and cheap, but **it is not
something an agent should draft or that a commit can substitute for.** Flag it; do not
write it.

## 3. Do it properly

1. Replace `LICENSE` with the full, unmodified Apache 2.0 text. Do not edit the body of
   an OSI licence — that voids the point of using a standard one.
2. Add a `NOTICE` file (Apache expects one): project name, copyright, attributions.
3. Apply the standard Apache header to source files, or — if the codebase has no headers
   today — add a single clear statement in `README.md` and skip mass header churn.
   Prefer not touching 500 files.
4. Keep `TRADEMARK.md` exactly as it is. It is good and Apache §6 supports it.
5. Update `README.md`, `package.json` (`"license": "Apache-2.0"`), `pyproject.toml`, and
   any `setup.py`/manifest that declares MIT. **Grep for every occurrence of "MIT"** —
   a half-relicensed repo is worse than either state.
6. Commit as a deliberate, clearly-messaged licence change, not folded into feature work.

## 4. Facts Kody needs stated, not buried

- **A relicense is not retroactive.** Every copy already published under MIT stays
  MIT-licensed forever; anyone who took it under MIT keeps those rights, and that cannot
  be revoked. Apache 2.0 governs from this commit forward. This is fine and normal —
  but say it in the report rather than implying the past changed.
- **Contributor provenance is clean, with one asterisk.** Every author is one of Kody's
  own identities (`kwildfeuer@me.com`, `kody-w@users.noreply`, `wildfeuer05@gmail.com`,
  `wildhavenhomesllc@gmail.com`) or his machine identities (`rappter1`, `rappter2-ux`).
  No third party to chase. **But 15 commits are authored as `kowildfe@microsoft.com`.**
  Commits authored under an employer email in a personal repo are exactly what startup
  IP diligence flags. Do **not** rewrite history and do **not** try to fix it — just
  report the count and the shas so Kody can decide. It may be nothing; it is his call
  and possibly his lawyer's.
- **Apache 2.0 is a licence, not a Terms of Service.** They are different documents.
  Buzz has a licence for the source and, for the hosted `buzz.xyz` service, separate
  terms. If Kody wants hosted ToS for openrappter, that is a lawyer's document —
  **do not draft binding service terms.** Say so plainly instead.

## 5. Acceptance

1. `LICENSE` is the verbatim Apache 2.0 text; `NOTICE` exists.
2. `grep -ri "MIT" .` (excluding `node_modules`, `.git`, vendored code) returns nothing
   claiming the project is MIT-licensed.
3. Manifests declare `Apache-2.0`; the builds and tests still pass.
4. `TRADEMARK.md` is unchanged.
5. Report the Buzz repo's actual licence as you found it, and whether it also ships a
   CLA or DCO — if Buzz requires a DCO sign-off from contributors and Kody wants full
   parity, tell me; that is a separate decision.
