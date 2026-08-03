# ORDER — remove the work email from openrappter's history (RUN LAST)

## 0. What Kody asked for

> "anything posted under kowildfe@microsoft.com is a mistake and should be cleaned from
> the github repo (start fresh if you need so we wipe all history)"

**Run this LAST**, after round 7 (anatomy + hot-load) and round 8 (Apache 2.0 + naming)
are both committed and pushed. Rewriting history while another round is pushing will
corrupt the result. Do not start until the tree is settled and clean.

## 1. Do the targeted rewrite, not the nuke

He authorised wiping all history *if you need to* — you do not need to. A mailmap
rewrite removes the email completely while keeping 356 commits of real history, which is
an asset for a project that is "building in public". **Preserve the history.**

The 15 commits are all from two days — 2026-03-25 and 2026-04-16 — and every one is
Windows installer / ESM / npm-publishing work on openrappter itself:

```
60ff352 2026-03-25 feat: Windows one-click installer (install.ps1 + install.bat)
...
1bf9c6e 2026-04-16 fix(windows): use pathToFileURL in bin/openrappter.mjs dynamic import
```

Earliest affected: `60ff352`. Every SHA from there forward changes.

## 2. Method

1. **Back up first — this is irreversible.** `git bundle create` a full mirror of every
   ref to `~/.openrappter-history-backup-0802/`, and verify the bundle restores before
   touching anything. Do not skip this.
2. Use **`git filter-repo --mailmap`** (not `filter-branch`), mapping
   `kowildfe@microsoft.com` → `Kody Wildfeuer <kody-w@users.noreply.github.com>`.
   Ask Kody which identity he wants if it should be a different one; `noreply` is the
   safe default because it leaks nothing.
3. Rewrite **all refs, including tags and every branch** — not just `main`. A stray tag
   pointing at an old commit re-exposes the email.
4. Verify: `git log --all --format='%ae%n%ce' | sort -u | grep -i microsoft` returns
   **nothing** — check committer as well as author, they are different fields and the
   mistake is usually in both.
5. Force-push all refs with `--force-with-lease`.

## 3. The complications — handle these, do not discover them later

- **`fix/imessage-tahoe-attributedbody` @ `5953ed8` will be orphaned.** It is unmerged,
  pushed to origin, and holds the signed 1.11.0 DMG plus permission-walkthrough
  onboarding that Kody has not yet decided about. The rewrite invalidates it. **Rewrite
  that branch too and force-push it**, so the work survives with clean authorship. Do
  not delete it and do not merge it.
- **The second checkout** at `~/Documents/GitHub/OpenRappter` has the same 15 commits and
  will be permanently divergent afterwards. Re-clone it fresh from the rewritten origin,
  or delete it — but only **after** confirming the rewritten remote has everything,
  including that branch. Back it up first too.
- **`~/.local/share/openrappter/releases/<sha>`** names releases by sha. Those shas will
  no longer exist upstream. Redeploy after the rewrite and confirm `/chat` still answers.

## 4. What Kody must be told plainly in the report

- **Force-pushing does not erase the old commits from GitHub.** They remain reachable by
  SHA on the remote until GitHub garbage-collects, and anyone who cloned or forked keeps
  them. To actually purge them he must either ask GitHub Support to run gc on the repo,
  or delete and recreate the repository. **State this; do not imply the rewrite made
  them unreachable.**
- **This is a metadata correction, and that is all it is.** Changing an author email does
  not change who owns code. Say so directly. In this case the content is plainly his own
  project — a Windows installer for openrappter — so the email was a misconfigured git
  identity, not a provenance problem. But if he ever has a genuine question about
  work-for-hire ownership, that is a lawyer's question and a rewrite does not answer it.
- Confirm the sweep result: **only** openrappter and its duplicate checkout carry this
  email. `rappdex`, `rapp-pets`, `rapp-twin-hub`, `rapp-dog-hub`, `rapp-constitution`,
  `rapp-mapp`, `chat`, `rapp-secondbrain` and `kody-w.github.io` are all clean.

## 5. Acceptance

1. `git log --all --format='%ae%n%ce' | sort -u` contains no microsoft.com address.
2. Commit count is still 356 — history preserved, not truncated.
3. `fix/imessage-tahoe-attributedbody` still exists on origin with its 6 commits intact.
4. The backup bundle exists and has been test-restored.
5. Redeployed, and `POST :18790/chat {"message":"hello"}` still answers.
6. `git status` clean, everything pushed.

**Stop and ask before doing anything destructive beyond the above.** Do not delete the
GitHub repository. Do not wipe history. Those need Kody's explicit go-ahead on the day.
