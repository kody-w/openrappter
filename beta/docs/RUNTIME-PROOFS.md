# The Frontier runtime

The Frontier runtime is the live composition of RAPP agents over an
unchanged Grail Brainstem kernel. The Grail still discovers ordinary
`*_agent.py` files from one `AGENTS_PATH` and still exposes the RAPP/1 chat
wire. Frontier supplies the runtime around it: sha-pinned acquisition,
stack-scoped composition, Molt Lineage, isolated workers, environment HEADs,
and observable recovery.

The runtime proof is `beta/scripts/frontier-runtime-proof.mjs`. It copies the
Grail into a disposable root, uses the configured Brainstem Python and the real
Molter verifier, starts real Grail workers through `BetaRouteManager`, and
observes each live generation through `/health` and the materialized agents
directory. It makes no model calls and removes every worker and scratch byte
when it finishes.

## Why an agent cannot make the runtime fail unsafely

The safety ladder is deliberately layered:

1. **Acquisition and gate.** `RappStoreClient` verifies catalog sha256 pins
   before source reaches the scoped install path. The real Molter rejects
   lethal import-time behavior such as `os._exit`.
2. **Composition fail-safe.** The Grail dry-load checks the complete candidate
   tool set. A ring that collides with a factory tool is isolated to its locus;
   its HEAD rewinds while siblings and the last-good worker remain live.
3. **Data-integrity fallback.** Truncated source and corrupt metadata resolve
   to a valid predecessor or the Grail baseline instead of reaching a worker.
   A fresh validation trial prevents one transient validator failure from
   demoting a healthy HEAD.
4. **Operator recovery.** `baseline` and `restore` move lineage pointers without
   modifying memories. Named environments, fast-forward promotion, conflict
   refusal, drift reporting, and the hash-chained promotion journal make
   release state explicit.
5. **Memory boundary.** Lineage, routing, compositions, objects, eggs, and twin
   bookkeeping live outside `.brainstem_data`. The proof seeds a memory file
   and byte-compares it after rollback, restore, promotion, and migration.
6. **Persistence.** HEADs and composition hashes survive a new route-manager
   instance. Twin cleanup retains roots owned by a live process and reaps only
   abandoned roots. Legacy lineage migration preserves user-authored growth.

## Real proof output

Run on 2026-08-20 with
`/Users/kodywildfeuer/.brainstem/venv/bin/python`. The two FAIL rows are product
findings, not relaxed or simulated assertions.

```text
| Check | Result | Detail |
|---|---|---|
| preflight: configured Brainstem Python exists | PASS | /Users/kodywildfeuer/.brainstem/venv/bin/python |
| preflight: pristine Grail is present | PASS | /private/tmp/claude-501/-Users-kodywildfeuer-Documents-GitHub-aibast-agents-library/deb65d5f-5b3d-4968-873f-991e3e27fe8f/scratchpad/wt-orgB/rapp_brainstem |
| runtime: real Molter seeds Frontier ring-1 | PASS | rappid:@frontier/context-memory-ring:ce875bf2f61f15ed5cc9cf1f57eded6357bfe2bc44fa8f47674cf71a76ef2fbb |
| runtime: real Grail worker starts and exposes tools | PASS | pid=82077; status=unauthenticated; tools=ContextMemory,HackerNews,ManageMemory,LearnNew |
| absorb: sha-pinned fixture agent becomes a live tool | PASS | catalog=http://127.0.0.1:64971/index.json; sha256=fc738f2d5abb32e7eac16d453f43aa565c7d8843e809b2772e3626fc037f4d51; pid=82106; tool=FixtureAgent |
| absorb: same-filename agent collision fails closed | PASS | Refusing to install fixture_agent.py: Agent composition collision for fixture_agent.py; explicit override policy is required.; first-sha=fc738f2d5abb32e7eac16d453f43aa565c7d8843e809b2772e3626fc037f4d51; pid=82127 |
| absorb: optional live AIBAST catalog agent | PASS | id=prior-authorization; sha256=4136fa7302c291c434ac8a356acb1289e8427f37e3b0bea5667baca50bde7c1f; pid=82213; tool=PriorAuthorizationAgent |
| grow: verified ring restore moves HEAD and live worker serves it | PASS | ring=rappid:@frontier/hacker-news-ring:8ac86e975173225ece276f55d34f5650aa69caf72686cc4fe3e4591a195da094; composed-sha=3f347d7b477e8220101a53858888baa439723e15d14d9fa167a3ed132d08994b; pid=82217; tool=HackerNews |
| scramble: lethal os._exit molt is refused without moving HEAD | PASS | gate=module-level os._exit() can terminate the Brainstem or mutate its process lifecycle on import; a molt must stay safe to load in a plain Grail brainstem; head=rappid:@frontier/hacker-news-ring:8ac86e975173225ece276f55d34f5650aa69caf72686cc4fe3e4591a195da094; pid=82217 |
| scramble: colliding verified ring rewinds only its locus | PASS | rejected=rappid:@frontier/hacker-news-ring:aa79a5f4f1f397a73355be344e4c98125c4543c088cefb32f9689cf2a6f2ffc6; rewound=rappid:@frontier/hacker-news-ring:8ac86e975173225ece276f55d34f5650aa69caf72686cc4fe3e4591a195da094; sibling=rappid:@frontier/context-memory-ring:ce875bf2f61f15ed5cc9cf1f57eded6357bfe2bc44fa8f47674cf71a76ef2fbb; pid=82217 |
| scramble: truncated live ring resolves to baseline and worker survives | PASS | corrupt-head=rappid:@frontier/rar-rapp-learn-new-ring:2e3278b2b4375d393610da4a3cb54c4cf203a7035d61626a5d458fec0c753503; resolved=rappid:@grail/rar-rapp-learn-new:b100efe0470e0a5e41bcd3ecea953b1e794ca815a79c117c76bd4bb8d3e29433; replacement-pid=82293; alive=true |
| scramble: oversized ring is refused at ingest | FAIL | DEFECT: accepted 600593 bytes as rappid:@frontier/hacker-news-ring:d72afabedf112e7e2bb36a7868cb1f10ae813dea0e11518bbfc8dcce9098612f; worker pid=82293 alive=true |
| scramble: transient validator failure never demotes healthy HEAD | PASS | head=rappid:@frontier/hacker-news-ring:20388ccd2ebb6e99a24a6d87faad406adb4374e14ffa65c0ac3fbaec6fe8e2b4; accepted=rappid:@frontier/hacker-news-ring:20388ccd2ebb6e99a24a6d87faad406adb4374e14ffa65c0ac3fbaec6fe8e2b4; pid=82327 |
| scramble: corrupt ring meta.json is skipped without killing worker | PASS | corrupt-head=rappid:@frontier/hacker-news-ring:696136c784cffe575e738ff92372444407be35ff1c4098659c142d3af3360801; resolved=rappid:@grail/hacker-news:89be9861a4ca6bfd253a88268e916bd726f608b9eb1e26beaa918eff0fd98509; corrupt-rings=1; replacement-pid=82432; alive=true |
| words: baseline serves factory behavior and preserves memory | PASS | Reverted to Grail baseline — your memories are intact.; all-heads-baseline=true; factory-sha=314cb08b0dc1167e3fc6799160fd178c54dfb0edc13d83c656b07b56a56620e9; pid=82464; memory=identical |
| words: restore brings verified rings back and preserves memory | PASS | Restored the latest verified molts — your memories are intact.; all-heads-restored=true; hacker-head=rappid:@frontier/hacker-news-ring:20388ccd2ebb6e99a24a6d87faad406adb4374e14ffa65c0ac3fbaec6fe8e2b4; pid=82479; memory=identical |
| words: environments reports named HEADs | PASS | hacker=default:rappid:@frontier/hacker-news-ring:20388ccd2ebb6e99a24a6d87faad406adb4374e14ffa65c0ac3fbaec6fe8e2b4,prod:rappid:@grail/hacker-news:89be9861a4ca6bfd253a88268e916bd726f608b9eb1e26beaa918eff0fd98509; memory=identical |
| words: promote default prod fast-forwards and preserves memory | PASS | Promoted 2 agents to prod.; changed=2; all-heads-promoted=true; prod=rappid:@frontier/hacker-news-ring:20388ccd2ebb6e99a24a6d87faad406adb4374e14ffa65c0ac3fbaec6fe8e2b4; memory=identical |
| words: prod-only ring makes promote return CONFLICT and moves nothing | PASS | CONFLICT on hacker_news_agent.py: prod has a molt default never built on — nothing moved.; prod=rappid:@frontier/hacker-news-ring:d811dfc6354b92cdae702ac4a919cf5fd353a356d6c9062b9e2c646fd9edb611; memory=identical |
| words: drift prod reports the divergent agent | PASS | Drift detected in prod against default: hacker_news_agent.py.; actual=rappid:@frontier/hacker-news-ring:d811dfc6354b92cdae702ac4a919cf5fd353a356d6c9062b9e2c646fd9edb611; expected=rappid:@frontier/hacker-news-ring:20388ccd2ebb6e99a24a6d87faad406adb4374e14ffa65c0ac3fbaec6fe8e2b4 |
| words: corrupt promotions journal refuses without touching bytes | PASS | promotion journal is corrupt — refusing to trust or extend it; head=rappid:@frontier/hacker-news-ring:d811dfc6354b92cdae702ac4a919cf5fd353a356d6c9062b9e2c646fd9edb611; journal=byte-identical; memory=identical |
| memory: every rollback restore promote path kept bytes identical | PASS | sha256=1e64db5e96545d06f8c12f10c18d85e480b993aa5612f348461efee6dc26e353; /var/folders/kr/3w4vbrls2gxbtxrfx8gl82y40000gn/T/rapp-frontier-runtime-proof-ug0kFc/rapp_brainstem/.brainstem_data/memory/runtime-proof/user_memory.json |
| persistence: legacy lineage migration preserves memory | PASS | migrated=rappid:@grail/manage-memory:bde0766164556d741b956a89d8bfaf157b01a3b2598ac86f5854e30a6e2ac283; head=rappid:@frontier/manage-memory-ring:c866750546a63203e3b05800633b72e3a139d2a9256db101be5a2432fefb94bd; memory=identical |
| persistence: new route manager keeps HEADs and composition hash | PASS | requested-hash=399a7d5f8a3e41d5072f9c9a692e59941e575de00af32a58e1f169a6d32d1ddf; live-hash=399a7d5f8a3e41d5072f9c9a692e59941e575de00af32a58e1f169a6d32d1ddf; heads=5; fallback=none; pid=82513; memory=identical |
| persistence: two twin managers keep live owner and reap abandoned root | PASS | twin-dir-kept pid=82513; abandoned-reaped=true; shared-root=/var/folders/kr/3w4vbrls2gxbtxrfx8gl82y40000gn/T/rapp-frontier-runtime-proof-ug0kFc/beta-home/twins |
| Grail upgrade: Frontier ring-1 is not served across baseline drift | FAIL | locus-stable=true; rings=2; requested-ring=rappid:@frontier/context-memory-ring:ce875bf2f61f15ed5cc9cf1f57eded6357bfe2bc44fa8f47674cf71a76ef2fbb; live-ring=rappid:@frontier/context-memory-ring:ce875bf2f61f15ed5cc9cf1f57eded6357bfe2bc44fa8f47674cf71a76ef2fbb; frontier-ring-served=true; drift-telemetry=true; pid=82527; memory=identical |
| Grail upgrade: user-authored ring still serves on live worker | PASS | ring=rappid:@frontier/hacker-news-ring:20388ccd2ebb6e99a24a6d87faad406adb4374e14ffa65c0ac3fbaec6fe8e2b4; composed-sha=552d1359633ddb1bcfdcf5ffcd7fb4f6c3e4669d1a04ef3823996542b15ece82; pid=82527; memory=identical |
| isolation: all configured writable roots are inside scratch | PASS | scratch=/var/folders/kr/3w4vbrls2gxbtxrfx8gl82y40000gn/T/rapp-frontier-runtime-proof-ug0kFc; roots=9; python-packages-unchanged=true; python-env-sha=fc32993dbc395438300ac854238f9e292a015459f592e383c58fa4db113b5a47 |
| cleanup: every worker stopped and scratch root removed | PASS | workers=14; scratch-removed=true |
```

## Findings

1. **Oversized lineage ingest is not bounded.** A 600,593-byte candidate passes
   the real Molter and `LineageStore.appendRing` persists it. The 512 KiB guard
   exists later in `BetaRouteManager.resolveLineageEntry`, so serving fails
   safely, but ingest does not meet the fail-closed claim. Reproduce with the
   `scramble: oversized ring is refused at ingest` row.
2. **A stale Frontier-authored ring remains live after baseline drift.** A Grail
   upgrade changes `context_memory_agent.py`; the stable locus and rings survive
   and `lineage-default-skipped` telemetry correctly records the baseline hash
   mismatch, but the existing default HEAD still overlays ring-1. Reproduce
   with `Grail upgrade: Frontier ring-1 is not served across baseline drift`.

The proof intentionally exits non-zero while either finding exists.
