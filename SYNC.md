# Syncing v3 from upstream

The `beta/` Frontier and the `rapp_brainstem/` kernel are imported from
`microsoft/aibast-agents-library` under the MIT licence. Bringing in later upstream work is a
file-level sync, and two classes of file must survive it.

## Distribution-specific — never overwrite

These differ here **on purpose** and are excluded from any sync:

| Path | Why it differs |
|---|---|
| `beta/install.sh`, `beta/install.cmd`, `beta/install.ps1` | they must install *this* distribution, so their default repository is `kody-w/openrappter` |
| `.gitguardian.yaml` | scoped to this repository's scanner configuration |
| `NOTICE`, `licenses/` | attribution for the import |
| `.gitignore` | carries the `beta/build/` negation this repository needs |
| `beta/tests/installer-contract.test.mjs` | asserts the installers point at **this** distribution, so it moves with them |

## Local patches — reapply after a sync

`rapp_brainstem/tests/test_security_hardening.py` needs `rapp-keyring: allow` annotations on its
credential fixtures for conformance R9. That file is kept byte-identical to the Grail upstream, so
the annotation cannot live there and must be reapplied here after each sync.

The equivalent `beta/` fixtures **are** annotated upstream, so those survive automatically.

## The sync, in order

```bash
rsync -a --delete --exclude node_modules \
      --exclude install.sh --exclude install.cmd --exclude install.ps1 \
      <upstream>/beta/ ./beta/
rsync -a --delete --exclude __pycache__ <upstream>/rapp_brainstem/ ./rapp_brainstem/
rsync -a <upstream>/tools/rapp1/ ./tools/rapp1/
# reapply the local patch, then verify
python3 conformance.py          # expect 9 passed, 0 failed
cd beta && npm test             # expect 0 failing
```

**Verify before pushing.** The first sync silently wiped the fixture annotations and took
conformance from clean to eleven findings; it was caught by running the check rather than by
reading the diff.
