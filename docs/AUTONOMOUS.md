# Operating OpenRappter autonomously

Everything OpenRappter does is reachable from a terminal or an HTTP call. The
web UI is a convenience, never a requirement — nothing below opens a browser.

This matters for agents and CI: a capability that can only be exercised by
clicking is a capability that cannot be tested.

## Install without launching anything

The pinned installer never starts anything — it installs a launcher and exits,
which is exactly what you want in CI:

```sh
OPENRAPPTER_COMMIT=<full-40-char-sha> bash install-pinned.sh
```

It refuses a branch name, a short SHA, or `HEAD` by shape, so an unpinned
install is not reachable by accident. `OPENRAPPTER_INSTALL_ROOT` relocates the
installation; uninstalling is `rm -rf` of that one directory.

The launcher it writes is the only entry point you need:

```sh
"$HOME/.local/share/openrappter/bin/openrappter" --status
```

See `RELEASING-PINNED.md` for how to obtain and verify the commit.

## Start and stop the gateway

```sh
# Foreground
openrappter --daemon --port 18790

# Background, logging to a file
nohup openrappter --daemon --port 18790 > /tmp/openrappter.log 2>&1 &

# Confirm it is actually up before doing anything else
curl -fsS http://127.0.0.1:18790/health

# Stop it
kill "$(lsof -nP -iTCP:18790 -sTCP:LISTEN -t)"
```

`/health` returns the version, uptime, and per-subsystem checks:

```json
{"status":"ok","version":"1.10.1","uptime":9,
 "checks":{"gateway":true,"storage":true,"channels":true,"agents":true,"copilot":true}}
```

## Chat over HTTP

`POST /chat` is the single wire every capability rides. It accepts the
canonical `message` key and the RAPP brainstem's `user_input` alias, so one
client works against either runtime:

```sh
curl -sS -X POST http://127.0.0.1:18790/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"List the files in the current directory."}'
```

```json
{
  "schema": "rapp-chat/1.0",
  "status": "success",
  "response": "…",
  "content": "…",
  "session_id": "7fd8dcfb-…",
  "sessionId": "7fd8dcfb-…",
  "agent_logs": "",
  "voice_mode": false,
  "model": "copilot-cli:auto",
  "requested_model": "auto"
}
```

### Multi-turn

Pass the `session_id` you got back and the conversation continues:

```sh
sid=$(curl -sS -X POST http://127.0.0.1:18790/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"My codeword is RAPPTER42. Reply with just OK."}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["session_id"])')

curl -sS -X POST http://127.0.0.1:18790/chat \
  -H 'Content-Type: application/json' \
  -d "{\"message\":\"What was my codeword?\",\"session_id\":\"$sid\"}"
```

### Safe retries

`idempotency_key` makes a retry return the original answer instead of running
the turn twice. Reusing a key with a *different* body is rejected with `409`,
so a bug in the caller surfaces instead of silently duplicating work.

```sh
curl -sS -X POST http://127.0.0.1:18790/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Deploy nothing, just say OK.","idempotency_key":"run-42"}'
```

## JSON-RPC over the same port

```sh
curl -sS -X POST http://127.0.0.1:18790 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"agents.list"}'
```

Useful methods: `agents.list`, `chat.send`, `chat.session`, `chat.list`,
`chat.messages`, `chat.delete`, `config.get`, `config.schema`.

To enumerate everything this build actually registers rather than trusting this
list, ask for a method that cannot exist and read the registry from the source:

```sh
grep -rho "registerMethod[^']*'[a-z][a-zA-Z.]*'" typescript/src/gateway \
  | grep -o "'[a-z][a-zA-Z.]*'" | tr -d "'" | sort -u
```

## Without a running gateway

```sh
openrappter --status          # version, agents, and which Copilot CLI will answer
openrappter --list-agents     # every loaded agent and its description
openrappter --exec Shell      # run one agent directly
openrappter -t "summarise README.md"
openrappter "just a message"  # one-shot chat
```

`--status` reports the Copilot CLI that will actually be used:

```
CLI:      ✅ Pinned in this install v1.0.71
/…/typescript/node_modules/@github/copilot-darwin-arm64/copilot
```

`⚠ Ambient (unpinned)` means it fell back to a machine-wide install whose
version nobody controls — expected in a dev checkout that has not run
`npm ci`, and a warning sign anywhere else.

## Confirming which binary answered

The pin is only meaningful if you can check it. While a request is in flight:

```sh
ps -axo pid,ppid,command | grep 'copilot --prompt' | grep -v grep
```

The path must be inside the installation's `node_modules/@github/`. A path like
`/opt/homebrew/bin/copilot` means an ambient global answered.

A pinned install also records the CLI it installed, so you can check the pin
without a running gateway:

```sh
python3 -m json.tool < "$INSTALL_ROOT/versions/<commit>/.rapp-install.json"
```

The `copilot_cli` object names the package, the path, and the SHA-256 that was
stamped at build time. The installer re-checks that digest on every run and
rebuilds rather than executing a binary that no longer matches.

## Health checks for scripts

```sh
#!/usr/bin/env bash
set -euo pipefail
port="${1:-18790}"

curl -fsS --max-time 5 "http://127.0.0.1:$port/health" >/dev/null \
  || { echo "gateway down on $port" >&2; exit 1; }

reply=$(curl -fsS --max-time 120 -X POST "http://127.0.0.1:$port/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Reply with exactly OK and nothing else."}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["response"].strip())')

[ "$reply" = "OK" ] || { echo "unexpected reply: $reply" >&2; exit 1; }
echo "healthy"
```

## Talking to it as a RAPP peer

A RAPP brainstem reaches OpenRappter through the same endpoint — no bridge and
no extra port. The `user_input` alias and the `response` / `session_id` /
`agent_logs` / `voice_mode` / `model` fields exist precisely so a peer written
against the brainstem works here unchanged:

```sh
curl -sS -X POST http://127.0.0.1:18790/chat \
  -H 'Content-Type: application/json' \
  -d '{"user_input":"Who are you?"}'
```

## Timeouts

The Copilot CLI answers in roughly 10–20s for a simple turn, longer when agents
run. Allow at least 120s in any client; the default gateway ceiling returns
`504` with a `rapp-chat/1.0` error envelope rather than hanging forever.
