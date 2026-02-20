# Plan: Port OpenClaw install.sh Functionality to OpenRappter

## Context

The OpenClaw installer (`curl -fsSL https://openclaw.ai/install.sh | bash`) supports npm global install as the default method, build tool auto-detection, npm conflict resolution, gateway daemon restart, and CI automation flags. OpenRappter's current `install.sh` (2002 lines) only supports git clone. This plan ports all missing functionality so OpenRappter has feature parity, then publishes the npm package and pushes to the public repo.

---

## Phase 1: npm Publish Preparation

### 1.1 Fix `typescript/package.json` files field
The current `"files": ["dist/", "bin/"]` includes compiled test files in the npm package (seen in `npm pack --dry-run`). Add exclusion:

```json
"files": ["dist/", "bin/", "!dist/__tests__/"]
```

### 1.2 Verify package is publish-ready
- `npm pack --dry-run` — confirm only production code included
- `npm publish --access public` — first publish of `openrappter` to npm

### 1.3 Verify npm install works
- `npm install -g openrappter && openrappter --version`

---

## Phase 2: install.sh — New Functions

### 2.1 Installation Method Selection
**Function:** `choose_install_method`
- Detect existing installs: npm global vs git clone vs none
- `--method npm|git` flag (default: npm)
- `OPENRAPPTER_INSTALL_METHOD` env var
- Interactive gum chooser when existing install found
- Non-interactive defaults with `--no-prompt`

**Function:** `detect_existing_install` → returns "npm", "git", or "none"

### 2.2 Build Tool Detection (Linux)
**Function:** `ensure_build_tools`
- Check for gcc + make
- Auto-install `build-essential` (apt), `Development Tools` (dnf/yum), `build-base` (apk)
- Only runs on Linux (macOS has Xcode CLT)

### 2.3 npm Global Install
**Function:** `install_via_npm`
- `npm install -g openrappter[@version]`
- Support `OPENRAPPTER_VERSION` and `OPENRAPPTER_BETA=1`
- Retry with build tool auto-fix on gyp errors
- `SHARP_IGNORE_GLOBAL_LIBVIPS=1` default
- Verify binary on PATH after install

### 2.4 npm Conflict Resolution
**Function:** `resolve_npm_conflicts`
- Remove stale launcher scripts from previous git installs
- Remove dangling npm symlinks
- Backup old launchers when switching methods

### 2.5 Gateway Daemon Restart
**Function:** `detect_and_restart_gateway`
- PID file: `~/.openrappter/gateway.pid` (confirmed from `typescript/src/infra/gateway-lock.ts`)
- Check if process alive with `kill -0`
- Interactive prompt to restart (skip with `--no-prompt`)

### 2.6 Doctor/Migration
**Function:** `run_doctor_if_available`
- Run `openrappter doctor --json` on upgrades
- Best-effort, non-fatal

---

## Phase 3: install.sh — Modifications

### 3.1 `parse_args` — Add flags
- `--method npm|git`
- `--no-prompt` (CI/automation mode)
- `--set-npm-prefix` (force npm prefix fix)

### 3.2 `print_usage` — Document new flags and env vars
- `OPENRAPPTER_INSTALL_METHOD`, `OPENRAPPTER_VERSION`, `OPENRAPPTER_BETA`, `SHARP_IGNORE_GLOBAL_LIBVIPS`

### 3.3 `show_install_plan` — Add "Method" row

### 3.4 `INSTALL_STAGE_TOTAL` — Bump 3 → 4

### 3.5 Extract `install_via_git` function
Move current inline git clone + npm install + build logic (lines 1722-1776) into its own function.

### 3.6 Restructure `main()`
Current: prepare → git clone → finalize
New: prepare → choose method → (npm OR git) → gateway restart → finalize

```
Stage 1: Preparing environment (homebrew, node, git, build tools)
Stage 2: Choose install method (interactive or flag-based)
Stage 3: Install openrappter (npm or git branch)
Stage 4: Finalize (launcher for git only, copilot, gateway restart, doctor, onboard)
```

### 3.7 `create_launcher` — Only for git method
npm creates bin symlinks automatically via package.json `"bin"` field.

### 3.8 `resolve_openrappter_version` — Handle npm installs
Try `openrappter --version` first, fall back to package.json.

### 3.9 Add ~12 new taglines (reach ~48 total)

### 3.10 Set `SHARP_IGNORE_GLOBAL_LIBVIPS=1` at top of script

---

## Phase 4: Test Cases

### 4.1 Unit tests: `tests/install/test-install-functions.sh`
Source install.sh with `OPENRAPPTER_INSTALL_SH_NO_RUN=1` and test:
- `parse_args` flag parsing (--method, --no-prompt, --verbose)
- `detect_existing_install` returns "none" on fresh system
- `path_has_dir` positive/negative
- `pick_tagline` returns non-empty
- `gum_detect_os` / `gum_detect_arch` return valid values
- `get_bin_dir` returns writable directory
- `resolve_npm_conflicts` handles missing/stale files gracefully

### 4.2 Docker smoke test (npm method, root): `tests/install/docker/smoke/`
- Installs Node 22 base image
- Runs `curl ... | bash -s -- --no-onboard --no-copilot`
- Verifies `openrappter` on PATH and `--version` works

### 4.3 Docker non-root test: `tests/install/docker/nonroot/`
- Ubuntu base, non-root user with sudo
- Verifies git auto-install, npm prefix fix, openrappter on PATH

### 4.4 Docker git method test: `tests/install/docker/git-method/`
- `--method git --no-onboard --no-copilot`
- Verifies launcher script created, binary works

### 4.5 Method switch test: git → npm upgrade
- Install via git first, then re-install via npm with `--method npm --no-prompt`
- Verify npm version on PATH

### 4.6 Test runner: `tests/install/run-docker-tests.sh`
Builds and runs all Docker test images, exits non-zero on any failure.

### 4.7 shellcheck
- `shellcheck install.sh` must pass clean

### 4.8 GitHub Actions: `.github/workflows/install-smoke.yml`
- Runs Docker tests on push to main and PRs
- Verifies `docs/install.sh` stays in sync with root `install.sh`

---

## Phase 5: Publish and Deploy

### 5.1 npm publish
```bash
cd typescript && npm publish --access public
```

### 5.2 Sync install.sh → docs/install.sh
Copy updated `install.sh` to `docs/install.sh` for GitHub Pages serving.

### 5.3 Push to public repo
```bash
git add install.sh docs/install.sh tests/ .github/ typescript/package.json
git commit -m "feat: Add npm install method and full installer feature parity with openclaw"
git push origin main
```

### 5.4 End-to-end verification
1. `npm install -g openrappter` — direct npm
2. `curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- --no-onboard` — npm via installer
3. `curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- --method git --no-onboard` — git via installer

---

## Critical Files

| File | Action |
|------|--------|
| `install.sh` | Major modification — add npm method, build tools, conflict resolution, gateway restart, new flags |
| `docs/install.sh` | Sync copy of root install.sh |
| `typescript/package.json` | Fix files field to exclude tests from npm package |
| `tests/install/test-install-functions.sh` | New — unit tests for install.sh functions |
| `tests/install/docker/smoke/` | New — Docker smoke test (npm method) |
| `tests/install/docker/nonroot/` | New — Docker non-root test |
| `tests/install/docker/git-method/` | New — Docker git method test |
| `tests/install/run-docker-tests.sh` | New — test runner |
| `.github/workflows/install-smoke.yml` | New — CI for install tests |

---

## Risks

| Risk | Mitigation |
|------|-----------|
| npm package not yet published | Phase 1 completes first; git method works as fallback |
| Native module build failures | `ensure_build_tools` + retry + `SHARP_IGNORE_GLOBAL_LIBVIPS=1` |
| Breaking existing git-clone users | `--method git` preserves exact current behavior |
| npm EACCES on Linux | `fix_npm_prefix_if_needed` runs before install |
| CI/non-interactive breaks | `--no-prompt` + env var forces defaults |
