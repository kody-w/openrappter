# Git for agents: keeping a running Brainstem intact

`git-molt` applies Git's content-addressed history to one evolving agent at a
time. This proof uses the real RAPP Brainstem as the runtime: its PID is the
heartbeat, and its `/health` response is the pulse. No model call or sign-in is
needed.

The proof never edits `rapp_brainstem/`. It copies the Brainstem into a temporary
root, gives the copy an isolated `AGENTS_PATH`, starts it on a free loopback
port, and deletes the complete root after stopping both test kernels.

## Run it

Requirements:

- Bash 3.2 or newer on macOS or Linux;
- Git and curl;
- the Python 3.11 interpreter at `~/.brainstem/venv/bin/python` with the
  Brainstem dependencies; or set `BRAINSTEM_PYTHON`;
- network access to clone `https://github.com/kody-w/rapp-skills`; or set
  `RAPP_SKILLS_DIR` to an existing clone.

From the repository root:

```bash
bash beta/scripts/gitmolt-runtime-proof.sh
```

To reuse a local corpus:

```bash
RAPP_SKILLS_DIR=/path/to/rapp-skills \
  bash beta/scripts/gitmolt-runtime-proof.sh
```

The run should finish in well under three minutes. The beta test invokes the
same command and skips with a reason if its external prerequisites are absent.

## The three refs for one agent

Each locus is one stable agent identity in a bare Git repository:

| Ref | Meaning |
|---|---|
| `refs/molt/base/<locus>` | Current factory baseline |
| `refs/molt/loci/<locus>` | Newest recorded generation |
| `refs/molt/live/<locus>` | Generation selected for composition |

`record` stores candidate bytes but does not trust them. `verify` runs the
candidate through `beta/scripts/molter-gate.py`, which calls the Frontier
Molter's real `_verify(source)`. A successful verdict creates a new commit with
verification trailers. `activate` moves the live ref, and `compose` atomically
materializes all selected loci into the Brainstem's `AGENTS_PATH`.

That separation is the safety mechanism: recording bad bytes does not expose
the running process to them.

## What the proof does

1. **Establishes the runtime.** It starts a copied kernel with an empty
   composition. An HTTP 200 response with `status=unauthenticated` is expected:
   the proof deliberately supplies no credentials.
2. **Baselines the factory.** Every copied top-level `*_agent.py` becomes a
   locus. The composed files are byte-identical, and `/health` reports exactly
   `ContextMemory,HackerNews,LearnNew,ManageMemory`.
3. **Absorbs a real RAPPID agent.** It takes the 3.2 KB stdlib-only
   `hello_rapp_agent.py` from pinned `kody-w/rapp-skills` commit
   `312617f8479e28c654897d713141573a191d6552`, proves Molter accepts it,
   composes it, and observes exactly one new tool: `HelloRapp`.
4. **Grows the agent.** A marked V2 generation is recorded, verified,
   activated, and byte-checked while the kernel remains alive.
5. **Attempts five scrambles.** Module-level `os._exit(0)`, no `perform`,
   invalid syntax, an import-time exception, and `BasicAgent = object` are each
   recorded. Molter refuses each one; `activate` also refuses; composition
   continues serving the last verified bytes.
6. **Exercises a valid collision.** Molter accepts an individually valid
   generation named `HackerNews`. The kernel sees the whole composition,
   quarantines the later duplicate, and keeps its factory `HackerNews` alive.
   The proof then records and activates a repaired `HelloRapp`.
7. **Time-travels.** `revert` selects the corpus baseline, `restore` selects the
   newest verified safe ring, `pinned` forces baseline bytes, and `mutable`
   permits restoration.
8. **Moves a frame to a second runtime.** A second bare molt repository and a
   second copied kernel receive the lineage. The receiver locally verifies an
   unverified V4 tip before composing `HelloRapp`.
9. **Upgrades the Grail.** The copied factory `hacker_news_agent.py` receives
   new baseline bytes. Its locus ID stays unchanged, its earlier user ring
   remains in the log, and `revert` lands on the new factory bytes.
10. **Corrupts the object store.** The active agent commit is truncated.
    Native `git fsck` reports the empty loose object, compose falls back to that
    locus's baseline, and both kernels still answer `/health`.

Every mutation step records both pulse and heartbeat.

## Findings that matter

The proof found three boundaries worth preserving or fixing:

1. **Molter and the kernel disagree on name collisions.** Molter verifies one
   source file and accepts the valid `HackerNews` generation. Only the kernel
   can see that another file already registered that tool name, so it
   quarantines the later file. This disagreement is safe because Brainstem's
   per-file quarantine keeps the factory tool and process alive.
2. **Foreign verification authority used to transfer — fixed.** Frame import
   parked the live ref at baseline, but `activate` trusted only the
   `Molt-Verified: yes` commit trailer, which travels inside the commit; a
   ring verified on machine A activated on machine B before B's gate ever
   ran (observed: receiver `activate` rc=0). The fix makes the verdict a
   **local ref** (`refs/molt/verified/<ring>`) that `verify` writes and that
   frames never carry; the trailer remains provenance (`log` marks it
   `[foreign]`). The proof now asserts the spec: the receiver refuses the
   foreign-verified ring until its own gate passes.
3. **Frames omitted locus pathname metadata — fixed.** The path lived in
   bare-repository Git config, which a bundle does not carry, so the receiver
   looked for `agent.py` instead of `hello_rapp_agent.py` and compose omitted
   the agent while still exiting zero. Frames now carry the path in a
   metadata commit (`refs/molt/meta/<locus>`) and import restores it.

Both fixes live in the vendored, pinned tool (`beta/tools/git-molt/`, see its
README) on the git-molt branch `fix/local-verdicts-and-frame-path` (51/51
upstream tests); the upstream pull request is pending.

Molter is also intentionally stricter than the kernel for an ordinary
import-time exception: Brainstem would catch and skip that file, while Molter
refuses to mark it verified at all.

## Real run

This run used `rapp-skills` commit `312617f8479e` and the Brainstem venv:

```text
$ RAPP_SKILLS_DIR=/path/to/rapp-skills bash beta/scripts/gitmolt-runtime-proof.sh
OBSERVE initialized              pulse(status=unauthenticated agents=[] quarantined=none); heartbeat=alive
OBSERVE factory-baseline         pulse(status=unauthenticated agents=[ContextMemory,HackerNews,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE absorbed-corpus          pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE grown-v2                 pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE lethal-os-exit           pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE nonfunctional-no-perform pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE syntax-error             pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE import-exception         pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE decoy-basic-agent        pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE valid-name-collision     pulse(status=unauthenticated agents=[ContextMemory,HackerNews,LearnNew,ManageMemory] quarantined=hello_rapp_agent.py:distinct duplicate registered name 'HackerNews'; already registered by an earlier file); heartbeat=alive
OBSERVE collision-recovery       pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive

## Agent locus log
* d76f65cce1d8 [ok] molt: verified generation for hello_rapp_agent.py
  860e238c6347 [ok] molt: verified generation for hello_rapp_agent.py
  b93fd200b43a [--] molt: generation for hello_rapp_agent.py
  87c6adfb1950 [--] molt: generation for hello_rapp_agent.py
  61e9c2f03cb8 [--] molt: generation for hello_rapp_agent.py
  df10f9498e38 [--] molt: generation for hello_rapp_agent.py
  f9e804f346df [--] molt: generation for hello_rapp_agent.py
  33d1e8484c4c [ok] molt: verified generation for hello_rapp_agent.py
  22232dd1119d [ok] molt: baseline hello_rapp_agent.py

OBSERVE locus-log                pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE time-travel-revert       pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE time-travel-restore      pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE policy-pinned            pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE policy-mutable           pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE frame-export             pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE frame-import-primary-alive pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE second-runtime          pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE grail-user-ring          pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE grail-upgrade-revert     pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE tampered-ring-fallback   pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE final-primary            pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive
OBSERVE final-secondary          pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive

## PASS/FAIL table

| Claim | Result | Evidence |
|---|---|---|
| copied kernel starts without sign-in | PASS | pulse(status=unauthenticated agents=[] quarantined=none); heartbeat=alive |
| factory agents compose exactly | PASS | 5 byte-identical loci; tools=[ContextMemory,HackerNews,LearnNew,ManageMemory]; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| runtime absorbs one stdlib RAPPID agent | PASS | rapp-skills@312617f8479e; verified class=HelloRapp tool=HelloRapp; non_stdlib=[]; tools=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory]; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| verified generation grows live runtime | PASS | recorded, Molter-verified, activated; marker=GIT_MOLT_GENERATION_V2; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| scramble refused: lethal-os-exit | PASS | Molter: module-level os._exit() can terminate the Brainstem or mutate its process lifecycle on import; a molt must stay safe to load in a plain Grail brainstem; verify_rc=1; activate_rc=1; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| scramble refused: nonfunctional-no-perform | PASS | Molter: HelloRapp does not define perform() — a molt must be able to act; verify_rc=1; activate_rc=1; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| scramble refused: syntax-error | PASS | Molter: SyntaxError: expected ':' at line 3; verify_rc=1; activate_rc=1; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| scramble refused: import-exception | PASS | Molter: candidate failed to load cleanly: RuntimeError: GIT_MOLT_IMPORT_BOOM; verify_rc=1; activate_rc=1; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| scramble refused: decoy-basic-agent | PASS | Molter: BasicAgent must be imported from agents.basic_agent and its name never reassigned (the base must be the real kernel class); verify_rc=1; activate_rc=1; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| valid collision exposes gate/kernel disagreement | PASS | Molter accepted (verified class=HelloRapp tool=HackerNews); kernel quarantined the later duplicate (pulse(status=unauthenticated agents=[ContextMemory,HackerNews,LearnNew,ManageMemory] quarantined=hello_rapp_agent.py:distinct duplicate registered name 'HackerNews'; already registered by an earlier file); heartbeat=alive); recovered last good generation (pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive) |
| locus log retains good and refused history | PASS | 9 entries with verified and unverified rings; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| revert returns to absorbed corpus baseline | PASS | composed bytes match hello_rapp_agent.py at rapp-skills@312617f8479e; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| restore selects newest verified safe generation | PASS | marker=GIT_MOLT_RECOVERY_V3; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| pinned policy forces baseline | PASS | newer verified rings retained but baseline bytes composed; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| mutable policy restores evolution | PASS | newest verified safe bytes active again; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| frame exports full locus without changing live runtime | PASS | frame written; unverified transfer tip recorded; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| a foreign verified trailer does not transfer authority | PASS | receiver activate rc=1 before local verification (want non-zero); pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| unverified transfer tip is parked and the frame carried its path | PASS | activate rc=1 (fatal: refusing to activate an unverified generation); imported path=hello_rapp_agent.py; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| same gate admits agent into second runtime | PASS | verified class=HelloRapp tool=HelloRapp; files=[basic_agent.py,context_memory_agent.py,hacker_news_agent.py,hello_rapp_agent.py,manage_memory_agent.py,rar_rapp_learn_new_agent.py]; marker=GIT_MOLT_TRANSFER_V4; loader=[[brainstem] Agent loaded: HelloRapp [brainstem] Agent loaded: HelloRapp [brainstem] Agent loaded: HelloRapp ]; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| Grail re-baseline preserves locus and rings | PASS | locus=hacker_news_agent.py unchanged; earlier verified ring 9da18d3ac32e retained; revert composed current factory marker; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| tampered loose object is detected and contained | PASS | git fsck rc=3 (reported the active loose object as empty); compose rc=0 fell back to agent baseline; pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| primary runtime finishes alive | PASS | pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |
| second runtime finishes alive | PASS | pulse(status=unauthenticated agents=[ContextMemory,HackerNews,HelloRapp,LearnNew,ManageMemory] quarantined=none); heartbeat=alive |

Summary: 23 claim(s), 0 failure(s)
```
