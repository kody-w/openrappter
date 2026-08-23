# CLI commands

Every command `openrappter --help` registers, with what it is for. Generated
from that output and guarded by
`typescript/src/__tests__/integration/docs-command-coverage.test.ts`, which
fails if a registered command is missing here.

Run `openrappter <command> --help` for a command's own options.

| command | arguments | what it does |
|---|---|---|
| `onboard` |  | Interactive setup wizard |
| `service` |  | Manage the launchd-supervised OpenRappter gateway |
| `imessage` |  | Manage the private macOS iMessage service |
| `reset` | `[options]` | Clear all credentials, config, and cached tokens for a fresh start |
| `bar` | `[options]` | Launch the OpenRappter Bar (macOS menu bar app or TUI) |
| `channel` |  | Manage release channels (stable / experimental digital twin) |
| `call` |  | Place and manage phone calls the agent makes on your behalf |
| `twin` | `[options]` | Your digital twin — local-first, never leaves this machine |
| `cron` |  | Manage cron jobs |
| `approvals` |  | Review commands waiting on your approval |
| `backup` |  | Snapshot and restore your OpenRappter data |
| `memory` |  | Search and record what this rappter remembers |
| `sessions` |  | Inspect and manage chat sessions |
| `channels` |  | Inspect and control messaging channels |
| `audit` | `[options]` | Check this installation for security problems |
| `config` |  | Manage configuration |
| `doctor` | `[options]` | Run system diagnostics and health checks |
| `twins` | `[options]` | Which rappters are running on this device |
| `hatch` | `[options] <name>` | Hatch a twin rappter on this device |
| `flight` |  | Inspect the local privacy-aware Flight Recorder |
| `show-and-tell` |  | Learn a reusable skill or automation from a local demonstration |
| `clever-girl` |  | Observe recurring friction in explicit local exports |
| `skills` |  | Manage skills |
| `agents` |  | Manage agents |
| `models` |  | List, get, or set the active LLM model |
| `update` | `[options]` | Check whether a newer openrappter is published |
| `rappterhub` | `[args...]` | Manage RappterHub agents (runs the Python runtime) |
| `clawhub` | `[args...]` | Manage ClawHub skills (runs the Python runtime) |
| `gateway` | `[options]` | Start the gateway server (same runtime as `openrappter --daemon`) |
