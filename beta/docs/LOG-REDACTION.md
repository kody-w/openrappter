# Frontier log and export redaction

OpenRappter treats the Grail kernel's stdout and stderr as
untrusted, credential-bearing text. Frontier does not change the kernel. It
filters both streams before appending them to shared, routed-worker, or twin
logs.

## Persistent logs

Frontier creates each log directory with mode `0700` and each log file with
mode `0600`. On POSIX, it also reapplies those modes whenever a log is opened,
so an existing world-readable file is repaired. Windows does not enforce POSIX
mode bits, but uses the same redaction pipeline.

The pipeline buffers each stdout and stderr stream independently through line
boundaries, honors Node stream back-pressure, and flushes an unterminated final
line when the child exits. A line without a sensitive match is written using
its original bytes.

The Electron bootstrap installs that pipeline before loading the main process,
so output redirected by a fresh install into `launcher.log` is scrubbed across
split writes. The detached update runner stages the same redaction module,
captures forward and rollback installer output, and scrubs it before appending
to the private `update.log`.

Sensitive values are replaced in place with a typed marker:

| Shape | Marker |
| --- | --- |
| `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` | `[redacted:github-token]` |
| `Authorization:` or standalone `Bearer` values | `[redacted:authorization]` or `[redacted:bearer]` |
| `api_key`, `api-key`, `secret`, `token`, `password`, `passwd`, `client_secret` fields | `[redacted:<field-kind>]` |
| JWT-shaped base64url triples | `[redacted:jwt]` |
| Azure Function URL `code=` query values (or Azure/Function-labeled values) | `[redacted:function-key]` |
| Login codes near `code`, `enter`, or `login` | `[redacted:device-code]` |

The same credential scrub is applied to copied route telemetry and twin work
log events. The explicit login response remains available to the live login
flow; only duplicate log and telemetry copies are redacted.

## Frontier exports

The Frontier frame bridge scrubs JSON blobs before the browser receives them.
This covers the raw `book.json` diagnostic export and chat transcript export.
It recursively removes secret-bearing and private identity fields, then mirrors
the kernel support-report protections for credentials, local user paths, email
addresses, IP addresses, and URL query strings. The "Share with admin" report
continues to use the kernel's already-scrubbed `/diagnostics/report` path.

Agent source exports and encrypted voice configuration exports are not raw
diagnostic exports and retain their functional bytes.

## What the kernel still emits

The unchanged Grail kernel can still place sensitive text on its own process
streams or in its raw in-memory recorder. Frontier protects the copies it owns,
but another host that launches the kernel directly must provide equivalent
controls.

## Upstream note for the release train

Line numbers below refer to the kernel version reviewed with this change and
may move. The function and statement anchors are the durable references.

1. `rapp_brainstem/brainstem.py:1363-1372`,
   `_start_device_code_login()`: `_pending_login` receives `device_code` and
   `user_code`; line 1371 records `user_code`, and line 1372 prints the raw user
   code. The recorder and stdout message should contain a typed redaction rather
   than the code.
2. `rapp_brainstem/brainstem.py:2180-2217`, `run_tool_calls()`: line 2208 prints
   the first 200 characters of raw JSON tool arguments. Apply the kernel's
   recursive secret scrub before formatting this line, including `passwd`,
   `client_secret`, GitHub-token, JWT, Function-key, and login-code shapes.
3. `rapp_brainstem/brainstem.py:3248-3285`, `diagnostics_export()`: line 3277
   inserts raw recorder events into `book.json`. Pass each event through
   `_scrub_diagnostic_value`, as `/diagnostics/report` already does at lines
   3339-3341, before serializing the book.
4. Keep `_scrub_secrets()` and `_scrub_diagnostic_value()` as the source-side
   authority, add regression vectors for every shape listed above, and retain
   Frontier filtering as defense in depth for older kernels.
