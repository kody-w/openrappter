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

## Known gap: v3 is not self-hosting yet

`beta/install.cmd` and `beta/install.sh` do two different jobs with **one** URL:

1. bootstrap the shared global Brainstem kernel, by downloading the **root `install.ps1` / `install.sh`**
   from `REPO_URL` and running it with `--no-launch`;
2. fetch the Frontier itself (`beta/`) from that same `REPO_URL`.

Upstream those coincide, because that repository hosts both. Here they do not: this repository's
root `install.ps1` is openrappter's own installer, an unrelated program that has no `--no-launch`
parameter. Repointing `REPO_URL` at this repository therefore fetches the right Frontier and the
wrong kernel bootstrap, and the install fails at step one with:

```
A parameter cannot be found that matches parameter name '-no-launch'.
```

Found by running the real installer on a real Windows machine against this repository. Cloning and
running `npm ci` never reaches this code path, which is why it survived every earlier check.

**The fix is a decision, not a patch.** One URL is doing two jobs and they have come apart:

- **Split them.** A `KERNEL_REPO_URL` for the Brainstem bootstrap and a `REPO_URL` for the Frontier.
  This is the architecturally honest option — the kernel and the Frontier are separate artifacts with
  separate homes, and conflating them is what broke.
- **Or make this repository's root installer honour the same contract**, so one URL keeps working.

Until one is chosen, installing v3 through `beta/install.*` requires pointing `REPO_URL` at a
repository whose root installer accepts `--no-launch`.
