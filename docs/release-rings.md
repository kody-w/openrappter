# OpenRappter release rings

Choose a ring without changing the product name:

```sh
curl -fsSL https://kody-w.github.io/openrappter/install.sh |
  bash -s -- --ring stable

OPENRAPPTER_RING=beta \
  bash -c 'curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash'
```

`--ring` wins over `OPENRAPPTER_RING`; the default is always `stable`.
`OPENRAPPTER_CHANNEL` and `--channel` remain deprecated aliases.

| Ring | Meaning |
|---|---|
| `nightly` | vetted snapshot of canonical `main` |
| `alpha` | explicit early promotion from nightly |
| `canary` | exact alpha bytes after real smoke/limited rollout |
| `beta` | prerelease candidate |
| `stable` | canonical production release |

The selector does not resolve npm tags or clone a branch. It fetches only the
allowlisted ring repository's `.ring/manifest.json`, validates the closed
`openrappter-ring/v1` contract, downloads the exact artifact, checks SHA-256,
and installs those verified bytes. Git installs detach at the manifest's exact
40-hex source commit.

Unknown, unreachable, malformed, future-dated, disabled, and unpublished rings
fail closed. Downgrades require `--allow-downgrade` (PowerShell:
`-AllowDowngrade`). A checksum mismatch is fatal. `OPENRAPPTER_VERSION`, when
used for compatibility, must equal the manifest's exact version and cannot
override it.

Inspect pointers with:

```sh
openrappter rings list
openrappter rings status --ring stable --json
openrappter update --ring beta
```

The first-party Configuration screen exposes the same five-value setting as a
small release-ring switcher. Selecting a row only previews its validated exact
version, commit, and status. A separate Apply action is required; non-stable
rings warn, older rings require a downgrade acknowledgement, and disabled or
unpublished rings cannot be applied. The UI never downloads a package itself.

The satellite repositories are maintained pointers, not source forks. Schema,
promotion rules, and append-only receipts are owned by
[`kody-w/openrappter-release-train`](https://github.com/kody-w/openrappter-release-train).
