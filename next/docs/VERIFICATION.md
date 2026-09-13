# Verified headless milestone

This is verified **synthetic headless behavior with fail-closed production
bindings**, not a production cutover or live inference claim.

## Commands and results

- `npm --prefix next run check` — strict new-core typecheck, build, **47 tests
  passed**, zero failed/skipped, dependency-direction gate and canonical E2E gate.
- `npm test --workspace @rapp-work/rapp1` — **90 adopted primitive tests passed**.
- `git diff --check` — passed.
- Exact rev-15 `rapp_check.py` + its reference detached-JWS callback — **38/38
  signed emitted frames**, 7 streams, `COMPLIANT`, no findings; all **16 authority
  frames** also verified. A separate keyless foundation proof scans 3 frames.
- Real CLI/stdio child processes passed, including simultaneous processes
  idempotently appending the same operation.
- Retained legacy source and release-constitution gates passed on exact clean
  baseline `d8601aa91c10f3330ea10b7fa31382137d981dfd`: 270 source files, 14 workspaces.
  These do **not** qualify the new product for the old release artifact.

The new E2E scenario covers Copilot Builder, RAPP Up and all five native pointer
providers, a complete reviewed Monday intent, correction, preserved alternate
branch, two signed public bot perspectives, a synthetic iMessage outage/recap/
explicit retry, gated external work, clear/restore and deterministic restart.

Measured results:

- 2 exact persistent root GUIDs and exactly one Librarian per root;
- 1 alternative canonical branch retained without selecting or rewriting it;
- 0 canonical mutations from observation/orientation;
- 0 dormant model calls, 0 live model calls, and **0 model replay on restart**;
- 6 explicitly injected synthetic SDK calls, always Astra max/long;
- 0 source/native-store writes and 0 real external effects;
- 1 idempotent synthetic iMessage delivery after explicit retry;
- all 9 GODD/DOGG/both transfer variants refused without mutation;
- unadopted Private Hive authority refused even after exact local consent.

Canonical transcript SHA-256:
`a3249f5072af0ccc0d399a57464ec630df1f654ba1861e5f9465cea87a3a3c19`.
The committed transcript and outage fixtures are compared to regenerated output
by the E2E gate. Evidence and exact receipts are in `verification/headless.json`
and its referenced `next/.test-scratch/` directory.

## Honest limits

The unchanged legacy **whole-tree** gate rejects seven intentional `.py` files
under `next/`, including the exact canonical checker and target-owned contract.
The release constitution invokes that gate and likewise refuses. Neither the
legacy rules nor artifact allowlists were relaxed. The old application's source
diff is empty; only the root dependency-cache ignore rule changed.

The immutable external Brainstem was not modified, imported or launched. Actual
root-isolated hotload, authenticated memory-only SDK hosting, persistent signer
custody, signed rooted domain/Hive adoption and optional local iMessage
permission/contact bridge remain integration gates. The recurring capability is
a bounded canonical recap, not an arbitrary scheduler/executor or installed
daemon. Whole-store rollback and hostile same-UID mutation require independent
signed checkpoints/enforced isolation before production.

No push, merge, publication, dependency installation, application installation,
live-profile mutation or UI implementation was performed.
