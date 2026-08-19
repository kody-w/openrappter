# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Parity vector `history-carried-to-model`, the only one that reaches the model
  carrying a valid `conversation_history`. Every other vector arrived with an
  empty transcript -- the one vector that carries history is rejected 400
  before the model is called -- so the corpus could not detect a runtime that
  dropped, reordered or truncated a transcript, and the harness's
  `outbound_history_roles` assertion was declared by no vector at all.
- `parity_harness.py` now checks the outbound user message on **every** vector
  that reaches the model, defaulting to the request's `user_input`, instead of
  only on the single vector that opted in (#250).
- `openrappter service status` reports whether launchd actually supervises the gateway that is answering. The two can disagree permanently and nothing said so: on the machine that prompted this, a gateway started outside launchd had held the port for 13 days, so all 29 supervised starts exited 1 with `EADDRINUSE` while `/health` returned 200 and `doctor` reported the same message it reports when supervision is correct.
- `openrappter audit` runs the security auditor and exits non-zero on high or critical findings. `SecurityAuditor` had five checks and was constructed by nothing but its own test.
- The gateway now emits `agent.tool` as each tool call finishes, so tool use appears in chat. The chat UI has registered a listener for it since it was written and the event had no emit site anywhere, so the feature had never worked. The payload carries the tool's name, outcome and duration -- never its arguments, which can hold secrets.

- **`openrappter memory`** — search, record and forget what a rappter remembers.
  The module was complete and had never been registered, so `openrappter memory`
  fell through to the `[message]` positional and went to the model as a chat
  prompt. It was left unregistered deliberately, because it built a
  `MemoryManager` that holds everything in `Map`s and performs no file I/O: `add`
  printed an id and discarded it on exit, and `list` reported nothing afterwards.
  It now drives `MemoryAgent`, which is the memory the product actually keeps in
  `~/.openrappter/memory.json` — the same file `anatomy` reads and `doctor`
  inspects — so what one invocation records, the next one finds. There is no
  `clear`: `MemoryAgent` forgets by query, and a command that said "delete all"
  while doing nothing of the sort is the mistake this module already made once.

- **`openrappter backup`** — create, list, restore and delete snapshots of
  `~/.openrappter/` from the terminal. The gateway has served all four
  operations since the feature landed and the code behind them does real work,
  but nothing shipped ever called them: an update could snapshot before it ran
  and the user still had no way to reach that snapshot afterwards. A backup you
  cannot restore is not a backup. `restore` overwrites the live files in place
  and keeps no copy of what it replaced, so it requires an explicit `--yes`.
- **`openrappter approvals`** — list, approve and deny commands the safety
  policy has gated, from the terminal. The gateway has served `exec.pending`
  and `exec.respond` for some time and the only client calling them was the
  macOS menu bar app, so on Linux and Windows a gated command could be
  requested and never granted: the agent hands back an approval id and there
  was nowhere to take it. `approvals list` shows the command *and why it needs
  a person*, since `LD_PRELOAD=… ls` reads as an ordinary `ls` otherwise.
- **A slow machine can start the desktop app** — the app waits for the gateway
  it spawned to report ready and then kills it. That budget only ever runs out
  when the gateway is alive and merely slow (a genuine startup failure is
  reported immediately by its exit), which is a cold first run, an antivirus
  scan or a loaded machine. `OPENRAPPTER_GATEWAY_READY_TIMEOUT_MS` now sets it;
  the 30-second default is unchanged. A malformed value is ignored rather than
  fatal, and the accepted maximum is ten minutes.

- **One chat, both brains** — the brainstem runs as its own process speaking
  `POST /chat` while the OpenRappter runtime answers `chat.send`, so holding a
  conversation across both used to mean two chat windows. `chat.send` now takes
  an optional `target` (`openrappter` by default, or `brainstem`), and the web
  dashboard and the macOS Bar each carry a selector that remembers the choice.
  This works because both runtimes already return the same
  `rapp-runtime-parity/1.0` §2.4 envelope, so a reply from either renders
  identically. An unrecognised target is refused rather than defaulted: the two
  brains know different things and their replies are the same shape, so a typo
  that quietly answered from the wrong one would be indistinguishable.
  `OPENRAPPTER_BRAINSTEM_URL` overrides the address; otherwise both the
  documented port and the RAPP drop-in slot are probed.

- **A `Brainstem` agent in both runtimes** — the selector lets a person switch
  brains, which still leaves them relaying answers by hand. The agent gives the
  assistant the same reach, dispatched like any other tool through the ordinary
  chat endpoint, so "ask the brainstem what it knows about this and compare it
  to your own view" works in one turn. Declares exactly the `network`
  capability its syntax tree can reach, per the RAPP agent contract.

### Fixed

- The brainstem saved your Copilot credential world-readable. `_save_token_file`
  used `Path.write_text`, which takes the process umask, so
  `~/.openrappter/brainstem/.copilot_token` landed at mode 0644 inside a 0755
  directory -- every account on the machine could read it. The file holds both
  `access_token` and the long-lived `refresh_token`, so one read outlives the
  access token's expiry. Under a permissive umask (0o000, as some container
  images set) it was 0666: another account could *replace* the credential.
  Now written 0600 into a 0700 directory, and a token left over from an older
  build is tightened on the next read rather than waiting for the next login.
  Two things made this unambiguous: the flight recorder already redacts
  `.copilot_token` out of captured logs, so the codebase knew the file was
  sensitive; and the TypeScript runtime already writes the same credential with
  `mode: 0o600`. Every other secret in the Python tree used the strict pattern
  too -- this was the one place that did not.

- Saving that credential was not atomic. `write_text` truncates before it
  writes, so a crash or a full disk part-way through left a half-written token,
  which reads back as "not logged in" with nothing to explain why. It is now a
  rename over a fully-written temporary file, so a reader sees either the old
  credential or the new one, never a fragment. Agent files imported through
  `/agents/import` go through the same path, so a truncated upload can no
  longer be loaded as a broken agent, and they are no longer written
  world-readable either.

- `test_all_core_agents_importable` ended in `assert True`, so it only proved
  the imports resolved -- renaming `ShellAgent.perform` left it green. It now
  asserts the contract its name implies.

- `python3 -m nanorappter` did not work. Both the module docstring and the
  CLI's own help text advertise it, but there was no `__main__.py`, so the
  documented command failed with "No module named nanorappter.__main__" -- the
  `if __name__ == "__main__"` guard in `__init__.py` only fires for
  `python3 nanorappter/__init__.py`, which nothing documents. The whole CLI,
  including `serve`, was unreachable by its own instructions.

- Every malformed request to the nanorappter gateway crashed its handler and
  returned nothing at all: a non-numeric `Content-Length`, a body that was not
  JSON, and a body that was valid JSON but not an object (`[1,2]`, `"x"`, `42`,
  `null` all raise `AttributeError` on `.get()`). Each now gets a 400.

- A single connection could take the whole nanorappter gateway offline. A
  negative `Content-Length` was passed straight to `rfile.read(-1)`, which
  means "read until EOF", and the server was a single-threaded `HTTPServer`, so
  one caller sending `Content-Length: -1` and a single byte -- then simply not
  closing the socket -- blocked the accept loop and every other caller timed
  out until it disconnected. Content-Length is now validated, the server is
  threading so no one caller can stall the rest, and a stalled request cannot
  hold its thread past the socket timeout. The gateway also now caps request
  bodies at the same 2 MB the other two runtimes use.

- The brainstem drained an over-sized body before refusing it even when the
  declared size was far past the cap, so a caller could claim a gigabyte, send
  nothing, and hold a thread for the full 30-second timeout to receive a refusal
  it had already earned. Draining exists to make the 413 readable rather than a
  connection reset, which is only worth doing for a body that is about to
  arrive; past `8 x` the cap the refusal now goes out immediately.

- The brainstem read a POST body of any size a caller cared to declare. It
  buffered exactly `Content-Length` bytes with no ceiling, and the existing
  30-second stall budget did not cover it -- that guard bounds a caller which
  claims bytes and never sends them, and the dangerous caller is the opposite
  one, which sends everything it claims as fast as the socket allows. Measured
  against a real brainstem, with no credential: one 64 MB POST took peak RSS
  from 33 MB to 180 MB in 0.04s, and six concurrent 16 MB POSTs added 113 MB,
  because the read is per connection and `ThreadingHTTPServer` gives every
  request a thread. Now capped at 2 MB with an `OPENRAPPTER_MAX_BODY_BYTES`
  override, answering 413; both figures are the TypeScript gateway's, whose own
  comment recorded the gap and asked this runtime to close it. Peak RSS is now
  flat regardless of what is offered. The oversized body is drained and
  discarded before the refusal is sent, because answering while the caller is
  still uploading resets the connection and it gets no readable response.

- The TypeScript gateway answered its `/chat` 413 with a bare `{error}`, the one
  `/chat` rejection whose shape differed from every other -- its own 401 and 503
  on that path, and everything the brainstem sends, use the `rapp-chat/1.0`
  error envelope required by `contracts/rapp-chat-v1.json`. It was written that
  way deliberately, because at the time the brainstem had no body cap and so no
  counterpart to agree with. It has one now, so both runtimes answer the same
  status and the same envelope.

- A field named `cookies` was written to the structured log in the clear, while
  `cookie` was redacted. The same held for `signatures` and `jwts` -- and for
  `sessionCookies` and `setCookies`, which is the shape a `Set-Cookie` header or
  a cookie jar actually arrives in. Plurals looked handled because `tokens`,
  `secrets` and `credentials` were all caught, but those are caught by the
  substring fragment pass rather than by being listed as words: a word survived
  pluralisation only if it happened to also be a fragment. `cookie`, `jwt` and
  `signature` are words only, so their plurals fell through every branch. Fixed
  in both runtimes as a rule rather than three more words. The test that pins
  the two runtimes to each other compares the word tables, which cannot see a
  rule -- it stayed green through the whole bug, and would have stayed green
  with one runtime fixed and the other not, so it now pins the rule as well.

- The flight recorder's excluded-path list covered `.env`, `.ssh`, `.aws/credentials`
  and `.pem`/`.key`/`.p12`, but not `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`,
  `.htpasswd`, `.gnupg`, `.docker/config.json`, `.kube/config`, private keys
  copied out of `~/.ssh`, or the `.pfx`/`.jks`/`.keystore` siblings of `.p12`.
  Exclusion blanks every sibling field of a recorded file locator, so an absent
  pattern meant those files' **contents** were recorded — an `.npmrc` auth token
  and a `.pgpass` line were written verbatim. Both runtimes now share
  `contracts/excluded-path-corpus.json`. Public keys outside `~/.ssh`
  (`id_rsa.pub`) stay readable.

- The flight recorder wrote 19 secret-bearing field names to disk in the clear,
  in both runtimes. Its redaction rules matched `token`, `secret` and
  `authorization` as exact words while matching `password`, `credential` and
  `cookie` as prefixes, so `secrets`, `tokens`, `clientSecrets` and `apiTokens`
  were recorded verbatim while their singulars were redacted; a separate fixed
  substring list held `apikey` and `privatekey` but not `sshKey`, `signingKey`,
  `masterKey`, `encryptionKey`, `sessionKey` or `clientKey`. Field names are now
  matched consistently, and `contracts/key-redaction-corpus.json` holds the
  agreed list for both runtimes. The recorder's deliberate conservatism is
  unchanged: `key`, `auth`, `salt`, `nonce` and `bearer` stay readable, and a
  numeric `inputTokens` is still a count rather than a credential.

- Two concurrent `POST /login` calls each started a separate device-code grant,
  and the second overwrote the first. One caller was left holding a `user_code`
  that `/login/poll` was no longer polling for, so that user could authorise
  correctly on GitHub and the brainstem would report `pending` indefinitely with
  no error to explain it. The device-login state machine is now serialised.

- The brainstem's dispatch guard could deliver a server error to the client as
  `200 OK`. It recorded that a reply had begun in `end_headers`, but
  `send_response` does not write -- it buffers the status line, and nothing is
  flushed until `end_headers`. A route raising in between therefore left a
  status line buffered while the guard believed nothing had been sent, so the
  guard appended a second one and both flushed together; a parsing client read
  the first and took the error body as a success payload. The guard now tracks
  the flush itself, and withdraws a buffered-but-unsent status line so the
  error is the only reply.

- `POST /agents/import` ended the gateway process when the injected agent
  importer returned a value `JSON.stringify` refuses. The status line was
  committed before the body was serialised, so the throw arrived with the reply
  already begun and the outer catch wrote a second status line --
  `ERR_HTTP_HEADERS_SENT`, which node exits on. The caller received no response
  at all. It now answers 503 with an error envelope.
- The three catch blocks around the HTTP body handler wrote a status line
  without checking whether one had already been sent, so any route that threw
  after answering ended the process rather than the request. They now close an
  already-committed response instead of re-heading it.

- `/rpc` answered HTTP 500 when a result could not be serialised, while every
  other JSON-RPC-level failure on that endpoint -- method not found, timeout,
  internal error -- answers HTTP 200 and carries the fault in the `error`
  member. A client that checks the status before parsing saw one failure mode
  as a transport error and the rest as RPC errors. It now answers 200 like the
  others.

- A WebSocket RPC whose result could not be serialised was never answered.
  `sendFrame` wrapped `ws.send(JSON.stringify(frame))` in a `try`/`catch` that
  ignored the failure, so the caller waited on an `id` that would never arrive
  while the connection stayed open and every other call worked. The same method
  over HTTP answers a JSON-RPC error. It now answers one here too, carrying the
  caller's `id`; frames with no `id` -- events, which nobody is awaiting -- are
  still dropped.

- A registered RPC method returning a value `JSON.stringify` refuses -- a cycle,
  a BigInt -- terminated the gateway. `/rpc` serialised the result as the
  argument to `res.end()`, after `res.writeHead()` had committed a status line,
  so the throw landed mid-reply and the surrounding `catch` wrote a second
  status line: `ERR_HTTP_HEADERS_SENT`, an unhandled rejection, process exit.
  `registerMethod` is the extension point plugins use, so this was reachable by
  design. The call now answers a JSON-RPC `INTERNAL_ERROR` and the daemon stays
  up.

- `GET /readyz` could terminate the gateway. The handler serialised its report
  as the argument to `res.end()`, after `res.writeHead()` had already committed
  a status line, so a report that could not be serialised threw mid-reply and
  the attached `.catch()` called `res.writeHead()` again on the same response.
  That raised `ERR_HTTP_HEADERS_SENT` inside a discarded promise, which node
  treats as an unhandled rejection and the process exits. The report is now
  serialised before any byte is written, and the error path refuses to write
  over a reply already in flight.

- The brainstem dispatch guard appended a second response when a route failed
  after it had already begun replying, so the caller received
  `HTTP/1.0 200 OK ... HTTP/1.0 500 ...` concatenated inside one reply. The
  guard now detects that bytes are committed and closes the connection instead.
- `DELETE` was not dispatched through that guard, so a failing `DELETE` still
  closed the connection with no status line. All three verbs the handler serves
  now go through it, and a test enumerates them rather than naming them.

- An exception raised while serving a brainstem request closed the connection
  without a status line. `BaseHTTPRequestHandler` dispatches straight into
  `do_GET`/`do_POST`, so anything escaping them unwound into `socketserver`,
  which logs a traceback and drops the socket -- to the caller, indistinguishable
  from the server going away. `GET /health` did this whenever agent loading
  failed. Both verbs are now dispatched through a guard that answers `500`,
  using the `contracts/rapp-chat-v1.json` envelope on `/chat`, and the traceback
  goes to the operator rather than the caller.

- `POST /agents/import` dropped the connection without a status line when a
  multipart part carried no blank line after its headers: two unguarded
  `split(...)[1]` indexes raised `IndexError` out of the handler. Malformed
  multipart is now `400`.
- `POST /agents/import` accepted `multipart/form-data` with no `boundary`
  parameter and wrote the part's closing delimiter into the agent file as
  source -- the saved bytes were `print(1)\r\n------X--\r\n` -- while
  answering `200`. A missing boundary is now `400`.

- The Python brainstem answered nothing at all to a malformed `Content-Length`.
  `do_POST` opened with a bare `int(self.headers.get("Content-Length") or 0)`,
  so `Content-Length: abc` raised `ValueError` out of the handler and the
  connection closed with no HTTP reply; `Content-Length: -5` did the same. Both
  are now `400`, in the same error envelope as every other rejection. The
  TypeScript gateway already answered `400` to both.
- A `Content-Length` larger than the body sent held a brainstem request thread
  open indefinitely. `BrainstemHandler` now carries a 30 second socket timeout,
  so a caller that stops sending is dropped instead of parked forever, and a
  short body followed by a close is refused with `400`.

- The Python brainstem accepted a `tool` turn in `conversation_history`,
  answered 200, and then dropped it before the model saw it. Validation used
  `_HISTORY_ROLES` (`user`, `assistant`, `tool`) while the line that forwards
  history to the model carried a second, narrower hand-written tuple. A caller
  replaying a transcript had no way to learn it had been edited, and the model
  reasoned about tool results it could no longer see. TypeScript forwards the
  turn; the two runtimes now agree, and the forwarding filter reuses
  `_HISTORY_ROLES` so the two lists cannot drift apart again.

- `POST /chat` rejections diverged between the runtimes. TypeScript answered a
  malformed request with a bare `{error}` while the Python brainstem answered
  with `{schema, status, error}`, so one malformed body identified which
  runtime replied -- on four of five bodies tested. The TypeScript comment
  justifying the bare shape cited a brainstem returning
  `jsonify({"error": ...}), 400`; no such brainstem is in this repository.
  Both runtimes now emit the envelope `contracts/rapp-chat-v1.json` fixes, on
  every rejection path including unparseable JSON.

- `openrappter audit` printed a blocking-finding count that ignored
  `--fail-on`. The exit code honoured the flag while the summary counted
  against a fixed `critical|high` set, so `--fail-on critical` could report
  "1 at high or critical" and still exit 0, and `--fail-on low` could report
  "0 at high or critical" while exiting 1. The count now uses the threshold in
  effect and names it.
- `agent.tool` omitted `toolCallId`, the field the chat list keys its rows on. Two tools finishing in the same millisecond therefore resolved to the same key, and the second *updated* the first's row instead of adding one -- so a tool vanished from the transcript.
- The Flight Recorder ledger ignored `OPENRAPPTER_HOME` in **both** runtimes, so relocating an installation moved everything except the database recording it. TypeScript spelled the path across three lines, which is how it escaped the migration that moved the other 46 sites -- and the guard meant to catch stragglers, whose pattern could not match its own formatting.
- `agent.tool` reported every **successful** tool call as a failure in chat. The event added in the previous change sent `status: 'ok'`, and the chat UI -- which has read this event since before it was emitted -- renders `status === 'success' ? '✓' : '✗'`, so `'ok'` fell to the cross. Emitter and consumer are now pinned to one vocabulary.
- The dormant `send` CLI sent `{ channel, message, target }` where `channels.send` reads `{ channelId, conversationId, content }`, so every field arrived `undefined` at the channel registry. `--metadata` is removed (no such field exists, so it was accepted and discarded) and `--all` now refuses instead of calling `channels.broadcast`, which no gateway registers. The command remains unregistered.
- `LearnNewAgent` reported `status: 'success'` and "Created and loaded agent" even when the agent it generated failed to load. The failure was recorded only as `hot_loaded: false` further down the same payload, under the field `agentResultIsError` classifies on -- so every composition layer treated a broken agent as a working one, and the only other symptom was a warning on each gateway start.
- The Electron desktop killed a gateway that was merely slow to start. `waitForGatewayReady` reports a gateway that crashes via `onExit` in milliseconds, so its 30s timer only ever fired on a process that was alive and still starting -- a cold first run, an antivirus scan, a loaded machine -- and the response was `SIGTERM` and quitting the app. The budget is now 120s, the value already proven in the Windows smoke step.
- `OpenRappterConfig` was hand-written and declared **6** sections while the schema validating it declared **21**, so fifteen sections -- including `security`, `network`, `voice` and `plugins` -- were parsed and then invisible to every consumer: reading them was a compile error. The type is now derived from the schema, so the two cannot diverge.
- The security auditor read `~/.openrappter/config.yml`, a file the product does not write (it writes `config.json5`), and its missing-file branch returns no findings -- so a check that reports "Gateway exposed without authentication" at critical severity had never examined anything. It now parses the real config through the loader.
- Removed two auditor checks for settings this product does not have (`cdp`, `dmOnly`). The CDP one used an unparenthesised alternation, `/cdp.*host:\s*['\"]?0\.0\.0\.0|all['\"]?/i`, so the bare substring `all` matched anywhere -- pointed at the real config it reported remote DevTools exposure at critical on a machine with no such setting.
- `getConfigPath()` and five other paths captured the data directory at import time, so `OPENRAPPTER_HOME` was ignored once a module had loaded.
- The Python runtime read `message` in preference to `user_input`, so `{"user_input":"A","message":"B"}` sent the model **B** while the TypeScript runtime and the grail brainstem sent **A** -- both answering 200, so the divergence was a silently different prompt rather than an error. It also had no `user_input must be a string` rejection, answering 200 where the grail returns 400.
- The parity harness rebuilt each request from three whitelisted keys, so any other field a vector declared was dropped before reaching the runtime. A vector could name a field, look like it tested it, and test nothing.
- `openrappter channels` now works and is registered. `connect`/`disconnect` sent `{ channel }` where every gateway handler reads `params.type`, so both passed `undefined` to the registry. `connect --config` was a silent no-op -- `channels.connect` ignores everything but `type` -- and now performs the `channels.configure` call it implied. Adds `configure`, `probe` and `config`, which reach gateway methods no client called; `config` output is redacted.
- `OPENRAPPTER_HOME` was honoured by 4 places and ignored by 46, so setting it did not relocate an installation -- it split one. The invocation journal, hubs and the iMessage proxy followed it while sessions, config, backups, the gateway lock, audit config and pairing stayed in `~/.openrappter`; a backup taken in that state silently omitted whatever had moved. All paths now resolve through a single `openrappterHome()` helper.
- `openrappter sessions` now works and is registered. All four subcommands failed before: `sessions.list`/`get`/`delete` are not gateway methods at all (the real ones are `chat.*`), and `sessions.reset` reads `sessionId`/`sessionKey` while the CLI sent `{ id }`, so it threw `sessionKey required`. `sessions delete` also reports when it deleted nothing instead of claiming success.
- `openrappter login <provider>` printed "Credentials have been saved to your config." while saving nothing: `initiateOAuthFlow` returns the token and `auth/oauth.ts` performs no filesystem writes at all. It now states plainly that the token is discarded and that persistent credential storage is not implemented. (The command remains unregistered.)
- RPC-backed CLI commands printed a raw Node stack trace, naming internal `ws` frames, whenever the gateway was unreachable, refused the token, or did not know a method. Commander does not await an async action handler, so the rejection escaped as an unhandled promise rejection. Failures now print one actionable line and exit non-zero.
- Consolidated six byte-identical private copies of `withClient` (`approvals`, `backup`, `channels`, `cron`, `send`, `sessions`) into `cli/with-client.ts`. The duplication is why the missing error handling existed in six places at once.
- Every RPC-backed CLI command (`backup`, `approvals`, `cron`, `memory`, `flight`, ...) printed its output instantly and then hung for 30 seconds before exiting. `RpcClient.call()` armed a 30s timeout and never cleared it once the response arrived; a pending timer keeps Node's event loop alive. `openrappter backup list` went from 30.1s to 0.1s.
- `openrappter channel status` threw `ReferenceError: __dirname is not defined` on every invocation. `infra/channel.ts` is ESM but used a bare `__dirname`, which type-checks (`@types/node` declares it) and only fails when the statement runs -- so `channel promote`, which never reaches that line, worked. Four other files already defined the `fileURLToPath(import.meta.url)` shim; this one was missed.
- Removed `src/cli/channel.ts`, an unregistered duplicate of the live inline `channel` command. Two copies of the same logic means a fix can land in the unreachable one.

- **The two runtimes defaulted to different OpenAI models.** `providers/openai.ts`
  used `gpt-4o` and `providers/openai_compatible.py` used `gpt-4o-mini` for the
  same provider against the same endpoint, so an identical call answered from a
  different model — and a different cost and capability — depending on which
  runtime made it. Neither value was written down and nothing compared them. The
  grail brainstem settles it: its default and its safety net are both `gpt-4o`,
  which TypeScript already matched. Python now does too, and a test reads the
  constant out of the TypeScript source so neither side can move alone.

- **The two runtimes disagreed on which `/chat` requests are valid.** The grail
  brainstem rejects a `conversation_history` entry whose role is not `user`,
  `assistant` or `tool` — including a caller-supplied `system` turn — with an
  indexed 400, and openrappter's TypeScript transliterates that. This runtime
  accepted anything: a non-list became `[]` and unknown roles were dropped later
  when the prompt was assembled, so it answered 200 where the other two answer
  400. Both behaviours stop the injection the check exists for; only one of them
  matches the reference, and PARITY §0 is that a peer must not be able to tell
  two RAPP runtimes apart. Python now validates history exactly as the grail
  does, in the same order — history before the empty-input check — with the same
  sentences, measured against the live brainstem rather than assumed.

- **Onboarding started the daemon from the data directory, not the code.**
  `startDaemon` hardcoded `~/.openrappter/typescript/dist/index.js`, which is the
  runtime data directory. On a machine where that path happened to hold an old
  checkout it started a build that had stopped updating; on one where it does
  not — most installs — the spawn throws and onboarding reports "Could not start
  daemon" on a perfectly good installation. `installLaunchAgent` had already been
  corrected to ask `ProcessManager.resolveProjectPath()`; `startDaemon`, twenty
  lines above it in the same file, had not. It also passed this app's own
  environment to the daemon, so a Finder-launched Bar handed down launchd's
  session `PATH` — the one with no node and no copilot in it, which the plist
  beneath it already explains — leaving the daemon's own children unable to find
  the tools they shell out to.

- **Onboarding and Settings installed two different launch agents.** Onboarding
  wrote its own `com.openrappter.daemon.plist` while `LaunchAgentManager` — which
  the Settings "Start at login" toggle reads and writes — manages
  `com.openrappter.gateway.plist`. So the toggle showed off immediately after
  onboarding had installed auto-start, turning it on added a second launchd job
  starting the same gateway on the same port, and turning it off could never
  remove the one onboarding made. Onboarding now installs through the shared
  manager, which also brings the better plist it always had — restart only on
  crash rather than on every clean exit, a throttle interval, background process
  type, `Umask 0o077` and separate stdout/stderr logs. A stale
  `com.openrappter.daemon` agent from an earlier onboarding is unloaded and
  removed.

- **Pressing Stop in the Bar could do nothing, silently.** `abortChat` caught
  its failure and discarded it, and `chatState` is only set to `.idle` on the
  success path — so a refused or undelivered abort left the UI streaming, with
  a Stop button that renders only while streaming and did nothing however many
  times it was pressed. The failure is now reported, which also restores the
  input, since `.error` is not `.streaming`.

- **The Bar claimed auto-start was installed when it was not.** Writing the
  launchd plist and loading it were both discarded failures, with
  `autoStartInstalled = true` set immediately after regardless, so the completion
  screen showed "Auto-start ✓" whether or not anything had been installed — and
  the daemon simply did not come back after a reboot, with nothing to explain
  why. `launchctl` reports refusal through its exit status, which the Bar's shell
  helper discards along with stderr, so a status-aware helper was added. The CLI
  path has always reported this honestly.

- **The Bar showed a setup step it never performed.** "Scheduling daily tips" was
  marked complete from `daemonStarted`, which is unrelated, and nothing in the
  Bar schedules tips — that happens in `openrappter onboard`, in the CLI. The row
  is gone rather than tied to a different unrelated signal.

- **The Bar could wipe your other credentials while saving one.** Onboarding
  wrote `~/.openrappter/.env` by reading it, dropping the key being replaced, and
  writing the result — but the read was `(try? String(contentsOfFile:)) ?? ""`,
  so a file that exists and cannot be decoded became an empty string and the
  rewrite replaced everything in it with the single variable being saved. That
  file is shared with the CLI, which keeps `OPENRAPPTER_MODEL` there, so the
  blast radius was not limited to onboarding's own keys. The write was `try?`
  too, and `saveManualToken` reported success immediately after it, so a token
  that never reached disk looked exactly like one that did. The read now
  distinguishes absent from unreadable and refuses to overwrite what it could not
  read, the write is verified by reading it back — as the TypeScript `saveEnv`
  has done since #159 — and a failure is surfaced instead of reported as success.

- **A config valid in one runtime was rejected by the other.** TypeScript's
  schema declares 21 top-level sections; Python's validator required one of six
  and refused anything else, so a file holding only `logging` or only `security`
  was accepted by one runtime and rejected by the other with "Config must contain
  at least one recognized section". Python now recognises the same 21, and
  `contracts/config-sections.json` pins the vocabulary with a test on each side,
  so adding a section to one runtime fails the other until it is added to both.
  The validators still differ in kind — Zod strips unknown keys, Python returns
  the data untouched — which is deliberate and unchanged.

- **The config schema did not know settings the runtime reads.** `channels.*`
  accepted only `enabled`, `allowFrom` and `mentionGating`, while
  `readIMessageConfig` reads `mode`, `pollInterval` and `staleAfterMs` off the
  raw config. Unknown keys are stripped rather than rejected, so a config running
  iMessage over BlueBubbles came back out of the schema without its transport,
  and re-reading it selected the `applescript` default — a working setup quietly
  reconfigured. Nothing routes channels through the schema today, which is the
  only reason this was latent rather than live. The schema now declares all
  three, and a test asserts that what the reader understands survives it.

- **The tutorial's agent returned the wrong type too.** `GreeterAgent`, the
  worked example a reader builds and tests, returned a bare object from
  `perform` in both runtimes — the same defect corrected in the Agents Reference,
  and the same one that makes the TypeScript version fail to compile. Both now
  return `JSON.stringify(...)` / `json.dumps(...)`, the Python example imports
  `json` to do it, and the accompanying test parses the string before asserting
  on it. The architecture page's reference to `python/openrappter/config.py` was
  also updated; that module is now a package.

- **The agent-authoring example could not work.** The page that teaches the
  framework's main extension point opened with
  `import { BasicAgent, AgentMetadata } from 'openrappter'`. The package entry
  point is the CLI, not a library — it exports one unrelated function, and
  importing it starts the interactive prompt. Both examples also returned a bare
  object from `perform`, which is declared `Promise<string>` and is
  `json.dumps(...)` in all 240 returns across the Python agents. The examples are
  corrected, and the contract for an agent you add yourself — a
  `createAgent(BasicAgent)` factory in `~/.openrappter/agents/`, which exists
  precisely because that import cannot work — is documented for the first time.

- **The Security page promised two protections that do not exist.** It
  described a prompt-injection detector in the slosh pipeline, matching phrases
  like "ignore previous instructions" and adding a `suspicious_input: true`
  signal — no such detector, phrase list or signal exists in either runtime.
  (ExecSafety's injection detection is *shell* injection in a command string, a
  different problem.) It also promised per-channel rate limits and limits on
  outbound LLM calls "protecting against runaway loops"; neither exists. The
  gateway's real limit — 100 requests per minute per connection, error `-32001`
  — was already documented accurately elsewhere and is unchanged. Both sections
  now describe what is actually enforced, and the injection section points at
  the mitigations that do the work: ExecSafety refusing commands, approval for
  dual-use ones, and prompts that label third-party content as data.

- **Five documented environment variables did nothing.** `OPENRAPPTER_CONFIG`,
  `OPENRAPPTER_LOG_LEVEL`, `OPENRAPPTER_PROVIDER` and `GATEWAY_SECRET` were
  listed in the reference tables and read by nothing anywhere in either runtime.
  So was `OPENRAPPTER_NO_TELEMETRY`, described as disabling anonymous usage
  stats — there are none, and none are collected or sent, so the sentence
  described a product that does not exist while quietly contradicting the
  local-first promise. The page now says so. A new guard requires every
  documented variable in the project's own namespace to be read by the source,
  or explicitly marked as unimplemented.

- **The documented configuration file was one neither runtime reads.** The docs
  site showed `~/.openrappter/config.yaml` throughout, in YAML. The loader is
  `JSON5.parse` in TypeScript and a comment-stripping `json.loads` in Python,
  and it looks only for `config.json5`. A file written from those examples was
  never read and raised no error, because an absent config file is a supported
  state. Every example on the page is now JSON5 under the real filename, and a
  new guard parses each one the way the loader does.

- **Five more documented config keys configured nothing.** Unknown keys are
  stripped rather than rejected, so each of these validated cleanly and did
  nothing: the whole `provider:` section, which was the headline example for
  choosing an LLM and supplying API keys; per-channel credentials such as
  `bot_token`; and `memory.embedding_provider`. Providers are configured by
  environment variable and the active model by `openrappter models set`, which
  is what the page now says. The same guard fails on any documented key the
  schema discards.

- **`${VAR:-default}` in config did nothing.** The documented fallback form —
  `api_key: ${ANTHROPIC_API_KEY:-sk-placeholder}` on the docs site — was matched
  by neither runtime's substitution pattern, since `\w` covers neither `:` nor
  `-`. The value survived into the config as that literal string and surfaced
  much later as a rejected credential rather than as a config error. Both
  runtimes now support it, and agree that a set-but-empty variable stays empty
  while only an unset one falls back. A second, fuller implementation existed in
  `config/env-expand.ts` with tests proving the fallback worked; nothing outside
  those tests ever called it, so the tests passed for years while the feature
  did not exist.

- **`openrappter update` now says how to be able to go back.** `backup.create`
  was documented as auto-running before updates. It never did: nothing in
  either runtime called it, and updating is a manual
  `npm install -g openrappter@latest`, so there was no in-product step it could
  have hung off. The claim was removed, and the moment the CLI tells you a new
  version exists — the one moment it knows you are about to change the
  installation — it now points at `openrappter backup create`.

- **The approval queue told the reviewer what, not why** — the safety policy
  works out precisely why a command needs a person (dual-use binary,
  environment assignment, plantable path) and sent that explanation to the
  *caller* in the agent's error message. The queue a human reads recorded
  `Approval token issued for: <command>`, so the reviewer saw the command
  restated back at them and had to re-derive the danger themselves. The
  policy's reason now reaches the queue. On the Python side the reviewer saw
  nothing at all — its approval token carries no reason field — so it gains the
  same merged `list_pending_approvals` view TypeScript has.
- **`git log` silently omitted commits whose subject contains a quote** — both
  runtimes asked git to build JSON directly, with
  `--pretty=format:{"hash":"%H",…,"subject":"%s"}`. A subject containing a
  double quote or a backslash produced an unparseable line, and the parse error
  was discarded, so those commits vanished from the result *and* from the
  reported `count` with nothing to indicate it. Commit subjects quote things
  routinely. Fields are now separated by a control character git cannot collide
  with, and parsed positionally.
- **`openrappter update` could restore a stash it never made** — the updater
  stashes local changes, pulls, rebuilds, then pops. But `git stash` on a clean
  tree prints "No local changes to save" and exits 0 *without creating an
  entry*, while the pop ran unconditionally. Updating a clean checkout that had
  an older stash therefore restored that older work into the tree and dropped
  the entry. The pop was also written `git stash pop 2>/dev/null || true`, so a
  pop that conflicted with the pulled version left conflict markers in the
  working tree and reported the update as a success; and any failure between
  the stash and the pop said only "Update failed", sending you to look for
  changes that were sitting in a stash entry you never made. The updater now
  pops only what it saved, reports a failed restore as a failure, and names the
  stash entry when it cannot finish.
- **A non-numeric Pokemon setting crashed the agent instead of being refused** —
  `port`, `max_clips`, `max_states`, `max_storage_gb`, `min_free_gb` and
  `startup_timeout` are chosen by a model, so they arrive as whatever it
  produced, and each was passed straight to `int()` or `float()`. `int("abc")`
  raises `ValueError`, nothing above it caught `ValueError`, and one odd
  argument took the agent down rather than coming back as an error.
  `startup_timeout` was worse than the rest: it was read *after* the supervisor
  had been spawned, so a bad value left a live process behind with nothing
  tracking it. All six are now coerced before anything is started, and a bad
  one names the setting that was wrong.
- **Two conformance checks could not fail** — R8 asserts the RAPP substrate is
  attributed, which its own docstring calls the licence condition, but it
  tested for `rapp` as a plain substring, and open**rapp**ter contains it; the
  check passed on a README with every mention of the substrate deleted (`mit`
  was the same shape, satisfied by "commit"). R6 asserts the brainstem keeps
  wire parity, but tested for the bare word `response`, which survives in
  `send_response`; renaming every `"response":` key in the `/chat` envelope —
  the exact breakage R6 exists to prevent — left it reporting parity. Both now
  match the token rather than the substring.
- **Three agents held capabilities they cannot reach** — `DocScannerAgent`,
  `NotesIntakeAgent` and `WebAgent` declared `process-exec` while importing no
  `child_process` at all; what they contain is regular-expression `.exec()`
  calls. The two scanners additionally declared `filesystem-write` while
  importing only `readdir`, `stat` and `readFile`. Read-only scanners therefore
  held the two most dangerous capabilities in the vocabulary, so a policy
  denying either would have refused agents that only match text. `conformance.py`
  enforces this as R5, but R5 reads Python agents only; TypeScript now has an
  equivalent check, and R4, R5 and R7 say which runtime they cover.
- **The conformance gate accepted a manifest that wasn't one** — R2 passed any
  non-Python agent whose file merely *contained* the substrings `__manifest__`
  and `rapp-agent/1.0`, and R3 checked required fields for Python agents only.
  Both were satisfied by `ComputerUseAgent.ts` at a point when it exported no
  manifest at all, so the gate reported a clean run over a broken contract.
  Both checks now read the declaration itself, which also surfaced
  `morning_brief_agent.js` carrying a name that is not `@scope/slug`; it is now
  `@openrappter/morning-brief`.
- **`read_screen` never worked, and Computer Use declared no capabilities** — a
  generated manifest block had been inserted at a byte offset that fell inside
  the Python source string `ComputerUseAgent` uses for OCR. The agent therefore
  exported no `__manifest__` at all, leaving its `filesystem-write` and
  `process-exec` declarations invisible to anything that reads manifests, and
  the OCR script was a syntax error so screen reading could only ever fail. The
  capability check did not notice because it matches source text rather than
  the runtime export; it now verifies both, and that the two agree.
- **A cron job created without an agent fired on time and then found no agent**
  — `addJob` defaulted the agent to `main` while the daemon executor resolved
  only `Assistant` and the runtime's own name, so every job created without an
  explicit agent was accepted, persisted, scheduled and fired exactly on time
  before failing with `Agent not found: main`. Both sides now share one
  constant and one resolver.

- **The channels screen went stale after the first load** — it listened for
  `channel.status` and nothing ever emitted it, so connecting or disconnecting
  a channel left the previous state on screen until reload. Connecting and
  disconnecting now notify subscribers with the changed channel, in the same
  shape `channels.list` returns.

- **`config validate` called a security policy valid while nothing enforced it**
  — a config setting `approvalPolicy: deny` was told `Configuration is valid.`,
  and the ignored-key report stayed silent too because the section really is in
  the schema. Validation now names sections that are valid but enforced by
  nothing, and says what does the enforcing instead.

- **The agent that places phone calls declared a capability that does not exist**
  — `PhoneAgent` declared `network-access`, which is not in the vocabulary; the
  word is `network`, used by every other networked agent. Any filter selecting
  on `network` skipped the one agent that dials real people. Declared
  capabilities are now checked against the list `conformance.py` defines.

- **The published agent counts described a developer's laptop, not the product**
  — `architecture.html`, the README and two other pages advertised 37 TypeScript
  agents. That number came from running `--list-agents` on a machine that also
  loads the operator's own agents from `~/.openrappter/agents`, so it counted
  three that no one else has. A fresh install ships **34 TypeScript and 20
  Python agents**; the pages now say so, and a guard per runtime re-derives the
  figure with `HOME` isolated so the published number cannot drift back to
  whatever the author happens to have installed.

- **Stop did not stop the brainstem** — `chat.abort` marked the run aborted and
  the interface went quiet, while the request carried on, produced a full reply,
  and had it discarded. Stop looked like it worked from every angle a person can
  see, and a hosted model kept generating billed output nobody would read. A run
  now carries an `AbortController` whose signal reaches the request itself.

- **GoogleVoiceAgent never loaded in the Python runtime** — every
  `--list-agents` printed `Failed to load … No module named 'agents'` and listed
  18 agents where TypeScript listed 19. The agent was not at fault: it is
  written to the portability contract, which permits `agents.basic_agent` and
  little else so the same file runs in the grail brainstem. The loader built
  that synthetic namespace and skipped the one module a portable agent is
  allowed to import.

- **PythonAgent failed to load on every single run** — built-in discovery calls
  `new` on every exported `BasicAgent` subclass, and `PythonAgent` is a wrapper
  built per descriptor that needs constructor arguments. It threw, was recorded
  as a broken agent file, and printed a warning above every `--list-agents`.

- **The Bones window told a fresh install it had no agents** — the agents
  section reads only the user's own directory, and the built-ins live inside the
  installed package. On a fresh machine it said "No agents installed yet" while
  37 agents were working; measured here, it counted 5 against a runtime that
  reported 37.

- **A slow PowerShell start aborted Windows ACL hardening** —
  `hardenPrivatePath` spawns a fresh `powershell.exe` for every private path and
  capped it at 15 seconds, which a cold start on a loaded machine can exceed.
  Every caller that asks for a private path takes the throw, so Show-and-Tell
  simply failed to start. Raised to 60s and retried once, but only for a process
  that never got off the ground — a refused or unverifiable ACL still fails
  closed on the first attempt.

- **`config validate` called a mostly-inert config file valid** — Zod strips
  unknown keys rather than rejecting them, so a file could parse cleanly while
  almost nothing in it was read. Validation still passes, since these are not
  errors, but it now lists the keys that will be ignored. This is why the
  published config documentation drifted so far: the tool whose job is to check
  the file agreed with it.

- **A published install had none of the 52 bundled skills** — `files` in
  `package.json` never listed `skills/`, so every tarball carried
  `dist/skills/bundled.js` and none of the `SKILL.md` files it reads. The
  loader swallows a missing directory and returns an empty list, so an install
  that shipped nothing looked exactly like one that legitimately had no
  skills. The packaging test now asserts against what npm would really
  publish, and asserts the count exactly, because shipping a subset is the
  same silent failure in a smaller form.
- **`cron.delete` reported success while the job kept running** — the alias
  filtered only the file-backed store, so the live scheduler kept the job and
  it fired on schedule after the user had been told it was gone. Deleting an
  id that never existed also reported success. Both now go through one bound
  removal that clears the scheduler and the store, and an unknown id is
  refused.
- **`cron.get` denied a job the gateway had just created** — it read only the
  file fallback, never the live scheduler, so a job created in this process
  was invisible until something persisted it. `cron.update` was not registered
  at all, though the macOS Bar calls it. `list` and `get` now share one
  mapping, so two readers of the same job cannot describe it differently.
- **A Bar-created cron job ran with an empty prompt** — the Bar sent
  `command` and the scheduler read `message`, so the job was created, reported
  `scheduled: true`, got a `nextRun`, and fired on time carrying nothing.
  `message` is canonical; `command` is accepted as an alias and normalised
  away. An empty prompt is now refused rather than scheduled.
- **Storage lied about three things** — a `transaction()` callback that
  awaited kept writing after the rollback was reported, because better-sqlite3
  rejects async transaction functions; migrations wrote their DDL and their
  version marker separately, so a partial failure bricked every later start
  with `duplicate column name`; and `INSERT OR REPLACE` on sessions and devices
  is a delete-then-insert, which fired `ON DELETE SET NULL` and destroyed the
  approval records pointing at them. Renaming a cron job cascaded away its run
  logs the same way.
- **The Bar's approval screen never worked** — `exec.pending` and
  `exec.respond` were not registered, so the approve and deny buttons could not
  function. They are now wired to the real `ExecSafety` engine that `ShellAgent`
  blocks on: a deny genuinely denies, an approval is single-use, and unknown,
  expired or already-resolved ids are refused instead of accepted. The gateway
  also now emits the `approval` event the Bar has always listened for, so the
  list no longer waits for the screen to be reopened.
- **The Bar's Logs pane and session reset called nothing** — `logs.get` and
  `sessions.reset` were unregistered. `logs.get` now reads the daemon's real
  launchd log files, bounded and redacted through the shared secret redactor;
  `sessions.reset` clears the real session store and aborts the run in flight,
  because otherwise the reply repopulated the session after reporting success.
- **The dashboard's agent file browser called nothing** — `agents.files.list`,
  `agents.files.read` and `agents.files.write` were unregistered, and
  `cron.runs` duplicated `cron.logs`. The file methods are treated as the
  remote code-execution surface they are: the resolved real path must sit
  inside the agent directory, reserved directories are refused as an agent id
  and as any path segment, symlinks are never written through, and `write` may
  only replace an existing file so it cannot plant a new agent.
- **The zen list ignored the events announcing its own sessions** — the
  gateway broadcasts `zen.session.start` and `zen.session.end`; nothing
  listened, so the list was only as fresh as the moment the screen opened.

- **Zen viewer works** — `<openrappter-zen>` is live UI, but `zen.sessions`,
  `zen.subscribe` and `zen.unsubscribe` were never registered on the gateway,
  so the page answered `-32601 Method not found` on load and rendered an empty
  screen forever. They are now registered against live streaming state owned by
  the running server. `src/gateway/methods/zen-methods.ts` was deliberately not
  reused: it reads `peer-stream.ts`'s process-local `globalPeerStream`, whose
  only writer (`openrappter bar --tui`) runs in a different process from the
  daemon, so it could only ever have reported an empty list. Producers now feed
  the daemon over the wire (`zen.publish`/`zen.end`, WebSocket only), the Bar's
  pong screen publishes through it, frames reach only the connections that
  subscribed, and a dropped connection releases its viewer slots and ends the
  sessions it was producing. The client-RPC coverage guard now also walks
  `ui/src/components`, not just `ui/src/services`: `zen.ts` is a component, so
  the guard never saw the three broken calls — their debt entries had been
  listed by hand rather than found.
- **The Bar's usage screen shows real numbers** — `UsageViewModel` calls
  `usage.stats` and `usage.history`, and the live `GatewayServer` registered
  neither, so both answered `Method not found` and the screen only ever
  rendered an error. Both are now registered against the Flight Recorder's
  `provider.attempt.completed` events, which is where provider-reported token
  counts are actually recorded. `gateway/methods/usage-methods.ts` was
  deliberately *not* wired: it declares different names (`usage.status`,
  `usage.cost`) against a `usageTracker` nothing in this repository
  constructs, and answers a hardcoded zero without one. Cost is reported as
  `costAvailable: false` rather than `$0.0000` — no price table exists in this
  runtime. `RpcClient.getUsageHistory()` also decoded timestamps with a bare
  `JSONDecoder`, whose `.deferredToDate` strategy threw on the gateway's
  ISO-8601 strings; the throw was swallowed by `try?`, so a populated response
  was silently rendered as an empty list.
- **The Bar's Skills and Nodes panes call methods that exist** — `skills.list`,
  `skills.install` and `connections.disconnect` were answered with
  `Method not found` by the live gateway; they are now registered in
  `registerBuiltInMethods` against the real bundled `skills/` directory, the
  real `SkillsRegistry`, and the gateway's own live connection map.
  `skills.install` requires the gateway credential, because it fetches a
  third-party manifest off the network and writes it where the agent will load
  it.
- **`skills.list` cannot report a packaging fault as an empty list** — a
  missing bundled `skills/` directory now raises instead of answering `[]`,
  which was indistinguishable from a machine that legitimately has no skills.
- **`skills.list` and `connections.list` answer in the shape the Bar decodes** —
  both payloads omitted fields the macOS `Skill`/`Node` decoders require, so
  the Bar showed "No skills installed" over 52 shipped skills and an empty
  Nodes pane over live connections. `RpcClient` no longer turns a decode
  failure into an empty array either.
- **`connections.disconnect` does not claim to have closed a connection that
  was not there** — an unknown connection id is an error.
- **`connections.pair` stays unregistered, deliberately** — nothing in the
  gateway can record a remote peer, and `connections.list` reports inbound
  sockets, so a successful pairing would be followed by a list that still
  showed nothing. The Bar gets a refusal it can display instead.
- **Python storage adapter is genuinely thread-safe** — `SqliteStorageAdapter`
  held an `RLock` (implying multi-threaded use) but opened its connection with
  sqlite3's default `check_same_thread=True`, so any call from a worker thread
  — a `ThreadPoolExecutor`, the gateway's executor, a cron worker — raised
  `sqlite3.ProgrammingError`. The connection is now opened with
  `check_same_thread=False` and every use of it, including cursor results and
  `rowcount`, is funnelled through a single lock-holding gate.
- **Browser private network access** — reaching a private or loopback address
  from the browser agent now requires an explicit operator opt-in
  (`allowPrivateNetwork`, off by default) rather than being reachable by
  default.
- **Full IPv6 link-local range blocked** — the SSRF guard covered only part of
  `fe80::/10`; the whole range is now rejected.
- **Allowlisted domains match on DNS-label boundaries** — `evil-example.com`
  no longer satisfies an allowlist entry of `example.com`.
- **Chunked downloads are bounded while they stream** — a declared length is
  not a promise, so the cap is enforced as bytes arrive rather than checked up
  front.
- **Cron job ids** — the scheduler sends the job id the gateway actually
  reads, and cron logs can no longer outlive or precede the job they belong
  to.
- **Shell exit codes** — Python returned `status=success` for every completed
  subprocess even on a nonzero exit, so `false` reported `return_code=1` while
  the shared classifier recorded success. Python now derives status from the
  return code; TypeScript already did.
- **Composite error status** — `AgentGraph` and `BroadcastManager` (both
  runtimes) only noticed a sub-agent failure when the call *threw*, so an agent
  that correctly reported `{"status": "error"}` was recorded as a success and
  the composite reported success overall. Both layers now classify through the
  shared `agentResultIsError` / `agent_result_is_error` helper, which also
  accepts an already-parsed envelope. A failed graph node now skips its
  dependents (or halts the graph under `stopOnError`); a broadcast keeps the
  full error envelope per branch but no longer counts it as a success, falls
  through to the next agent in `fallback` mode (forwarding the failed agent's
  `data_slush`), and never lets an error envelope win a `race`. Cross-runtime
  agreement is pinned by `contracts/agent-result-status-vectors.json`.
- **The rest of the composition layers had the same blind spot** — `AgentChain`,
  `PipelineAgent`, and `SubAgentManager` (both runtimes) also equated failure
  with a throw. A chain with `stopOnError` ran every remaining step past a step
  that returned `{"status": "error"}` and reported `partial` instead of `error`;
  `PipelineAgent` hard-coded every completed step to `status: 'success'`, so
  `onError` never fired at all and the pipeline reported `completed`; and
  `SubAgentManager` recorded a failed call as a success in its call history.
  All three now classify through the same shared helper. The failed payload is
  never discarded: the chain keeps the envelope as `finalResult`, the pipeline
  keeps each branch's result, and a sub-agent's error envelope is still returned
  to its caller (only the bookkeeping changes). The chain rollup also folds
  `{"status": "ERROR"}`, which its old case-sensitive comparison called success.
  A new `agentResultErrorMessage` / `agent_result_error_message` reports a failed
  step's reason identically whether the agent threw or returned an envelope, and
  is pinned by the same contract file.
- **The pipeline agent stays loadable without the kernel** — `pipeline_agent.py`
  is a single-file agent, so RAPP conformance R7 requires it to load with no
  kernel import at all. Its use of the shared classifier is a guarded import
  (the pattern `shell_agent.py` already uses) with a local fallback that mirrors
  the shared implementation verbatim; the two are pinned against each other over
  every contract vector by a test that loads the agent with no `openrappter`
  package present.
- **`config` and `doctor` were never registered** — both were implemented and
  exported, but their words fell through to chat and global help while shipped
  health guidance told you to run them. Registering them exposed dormant bugs:
  `get`/`set` no longer echo credential values, validation strictly parses both
  config files against the real schema, and `doctor` returns nonzero for failed
  checks in JSON mode too.
- **`voice-call` skill** prescribed `call start`, `call end` and
  `call conference`, none of which exist, and required a legacy plugin switch
  no OpenRappter code reads. It now documents the flow that ships.

### Changed

- `contracts/rapp-chat-v1.json` is now executable. It was read by one test,
  which asserted only that `brand` was `RAPP + X™` and hardcoded every other
  field, so appending a required key nothing emits left the suite green.
  Both runtimes now drive their assertions from the file. The contract was
  also corrected to describe verified behaviour: `user_input` is the canonical
  input and `message` its alias, not the reverse, and the success envelope
  requires all ten keys both runtimes actually emit.

- `openrappter service status` now derives its report from the same
  `getIMessageServiceStatus()` used by `openrappter imessage service-status`,
  instead of re-reading launchd through a parallel implementation. Both
  commands describe one launchd job (`com.openrappter.gateway`), so they now
  describe it with one vocabulary; `service status` adds only `lastExit`.

- The Electron desktop is the authority for OpenRappter Bar authentication,
  and desktop smoke tests were hardened for concurrent and Windows runs.

### Security
- The Python flight recorder wrote four kinds of credential to the ledger verbatim that the TypeScript one redacts: a `?key=` query parameter (the shape the shipped Gemini provider builds), Slack `xox*-` tokens, `sk-` OpenAI/Anthropic keys, and JWTs. The two `SECRET_VALUE_PATTERNS` lists had drifted, in one direction only. Both now read a shared corpus at `contracts/value-redaction-corpus.json`.

- **A client that stopped reading was buffered without limit.** The handshake
  advertised `policy.maxBufferedBytes: 10000000` and `sendFrame` was
  `ws.send(...)` with nothing consulting `bufferedAmount`, so the limit was
  announced and never applied. `zen.publish` carries frames of up to 256 KB at
  up to 30fps, so a stalled subscriber could accumulate megabytes a second in a
  process meant to run for weeks. A connection past the limit is now closed with
  1013 rather than fed, and the advertised number and the enforced one are one
  constant.

- **The gateway advertised a payload limit it did not enforce.** The handshake
  has always reported `policy.maxPayload: 5000000`, while `WebSocketServer` was
  constructed without a `maxPayload` option — so `ws` applied its own 100 MB
  default and the gateway accepted twenty times what it told every client its
  limit was. The number is now one constant, read both by the server that
  enforces it and the handshake that reports it. Nothing legitimate is affected:
  `zen.publish` frames are capped at 256 KB and the HTTP body limit is 2 MB.

- **`backup.restore` replaced your data without authentication** — the gateway
  required auth to *delete* a backup but not to restore one, though restoring
  overwrites every file in `~/.openrappter/` in place and keeps no copy of what
  it replaced. The more destructive of the two was the unguarded one. Restore
  now requires auth, like delete.
- **An environment assignment or a plantable path reached a safe-listed name** —
  the binary parser skips leading `VAR=value` assignments and takes the
  basename, both of which are right for classifying a command and neither of
  which was treated as a risk. So `LD_PRELOAD=/tmp/x.so ls` was judged an
  ordinary `ls` while the loader read the assignment after exec, and `./ls` was
  judged the system tool while running whatever sits in the working directory.
  The `env LD_PRELOAD=… ls` spelling already required approval, because `env`
  is dual-use; the shell's own assignment syntax did not. Both now require
  approval rather than being blocked, and `/bin` and `/usr/bin` stay ungated
  since they are not writable without root.
- **`git` is now treated as dual-use, because its configuration executes
  commands** — `git -c alias.x='!cmd' x` runs `cmd`, and `-c core.pager=` does
  the same wherever a pager is used. There is no separator and no substitution
  for the injection patterns to catch, and `git` was on the safe list, so the
  shell agent ran it without asking. It stays on the safe list but now requires
  approval, alongside `find`, `awk`, `sed` and `tar` — which were already
  listed for exactly this reason.
- **A single `&` chained commands past the safety policy** — the injection
  patterns covered `&&` but not `&`, and `ls & touch /tmp/x` runs both: the
  first goes to the background and the second executes immediately. Since `ls`
  is a safe binary the policy judged the pair safe, so neither command was
  reviewed and no approval was requested. This is the same shape as the newline
  bypass below — a separator the policy did not know about, hidden behind a
  harmless-looking binary.
- **The shell agent checked one command and executed another** — it normalized
  the command, ran the safety policy against the normalized form, and then
  executed the *raw* input. `normalizeCommand` collapses all whitespace,
  newlines included, so the injection rule written specifically for `[\r\n]`
  never saw one: `ls\ntouch /tmp/x` flattens to a single line that the policy
  calls safe, and the original then ran with the newline intact — two commands,
  neither approved, no approval prompt. Both runtimes were affected, including
  the Python `shell_agent.py` that is exempted from the
  no-shell-command-building guard on the grounds that exec safety gates it.
  Commands containing a newline are now refused outright, because collapsing
  one would execute something the caller did not write.
- **A credential in a `?key=` parameter was recorded verbatim** — the flight
  recorder scans recorded values for embedded secrets and already caught
  `?token=`, `?api_key=`, `?access_token=` and `https://user:pass@host`. It did
  not catch `?key=`, which is the parameter name Google uses, and which the
  shipped Gemini provider builds into every request URL — so any recorded value
  carrying that URL wrote the API key into the ledger in the clear. `?sig=`,
  used to sign Azure blob URLs, had the same hole. Both are redacted now, with
  a value-length guard so an ordinary `?key=name` is left readable.
- **The installer's checksum check could pass having verified nothing** — the
  one-line install downloads a `gum` release tarball and verifies it against
  the project's published `checksums.txt` using `sha256sum --ignore-missing`.
  That flag is necessary, since the file lists every platform and only one
  asset is downloaded, but GNU `sha256sum` exits 0 when it is left with nothing
  to verify at all. An asset simply absent from the list therefore read as a
  pass, so anyone able to serve the release could omit a line rather than forge
  a hash. macOS `shasum` exits 1 in the same case, so whether the installer was
  safe depended on which tool was installed — and `sha256sum` is tried first.
  The downloaded file must now be named in the checksums before any verdict is
  believed.
- **Agents no longer build shell command lines by interpolation** — every
  remaining site in `ComputerUseAgent`, `DailyTipAgent`, `DemoRecorderAgent`,
  `HackerNewsAgent`, `OuroborosAgent` and `UpdateAgent` now passes an argument
  vector. None was reachable with attacker-controlled input, so this is
  hardening rather than a fix, but it removes the shape that produced three
  real injections. Notification text is escaped for AppleScript, which is what
  it was always for, and the demo listing uses the filesystem instead of `ls`.
- **Learning a new agent could run arbitrary commands** — `learn_new_agent`
  asks a model to write agent code, scans that code for imports, and installs
  them, so an import specifier is model-authored untrusted input. It was
  interpolated into a shell command line, and the import pattern permits both
  spaces and semicolons, so generated code containing
  `import x from 'lodash; touch pwned'` executed the second command. Installs
  now use an argument vector, and package names are checked against npm's own
  grammar before use.
- **Turning authentication on no longer severs the neighborhood** — a rappter
  contacting a peer sent no credential at all, while `/twin` and `/chat` both
  authenticate before parsing. Those were compatible only because
  authentication was off by default; a peer with a token refused every sender,
  including one whose environment held the credential. Both wires now present
  `Authorization: Bearer` when `OPENRAPPTER_TOKEN` is set, and send no
  authorization header at all when there is none rather than a malformed one.

- **The published container ran everything as root** — the root `Dockerfile`
  declared no `USER`, and `docker-compose.yml` mounted the config volume at
  `/root/.openrappter` to match. Anything that gets code execution inside that
  container — and this process runs a shell agent by design — was root in it,
  with the credential directory mounted in. Now runs as the unprivileged `node`
  account, with `HOME` and the compose mount moved to match.

- **`openrappter login` printed both tokens** — it echoed the first 20
  characters of the access token, and of the refresh token when one was
  issued. A prefix is still credential material: it lands in terminal
  scrollback and in CI logs, and it narrows a brute force. The command now
  names the provider and says nothing derived from the secret. It remains
  unregistered — it also persists nothing while claiming it saved — so this
  was latent rather than live, which is exactly why it needed a test before
  somebody registers it.

## [1.13.0] - 2026-08-14

### Added

- **Show-and-Tell mode** in TypeScript and Python — record a real workflow,
  reconstruct its intent and ordered semantic steps, review it, and build a
  portable `SKILL.md`, a disabled automation, or both.
- **Cross-runtime recording store** — a private SQLite WAL database gives
  TypeScript and Python the same session, event, analysis, consent, and artifact
  contract with transactionally allocated event order.
- **Detached context collectors** — macOS, Windows, and Linux adapters capture
  active app/window context after the CLI exits. Browser URLs lose query and
  fragment data, and screenshots are explicit-only.
- **Local consent boundaries** — recording, optional Copilot analysis,
  approval, and deletion each require a short-lived, one-use token issued by an
  interactive local terminal.
- **Safe workflow packaging** — generated skills include manifests understood
  by both runtimes; automations are disabled by default; replay is a dry run
  rather than coordinate playback.
- **Electron desktop shell** — packages the current OpenRappter UI and runtime
  behind a sandboxed, context-isolated renderer, launches or reuses the local
  gateway, and adds a visual Skill Recorder-style Show-and-Tell workspace.
- **Native desktop consent** — recording, scoped active-window capture,
  workflow approval, and deletion use Electron main-process confirmation
  dialogs; consent tokens and filesystem paths never reach the renderer.
- **Chat-driven desktop control** — the `DesktopControl` agent snapshots the
  composed shadow-DOM UI and drives navigation, clicks, fields, selection,
  scrolling, and waits through semantic refs while the user watches.
- **Approved agent injection** — `.py` and `*_agent.ts` sources can be supplied
  through chat, capability-scanned, hash-disclosed, natively approved, compiled
  when needed, verified by loading, and hot-added to the live assistant.
- **On-device narration** — Whisper Small q8 downloads once (~252 MB), records
  optional microphone narration, transcribes locally, and adds the transcript
  to the active Show-and-Tell timeline.
- **On-device voice preview** — pinned Microsoft VibeVoice Realtime 0.5B source
  and model (~2.04 GB weights) self-bootstrap into a private Python 3.11
  environment and loopback-only server; VibeVoice generated WAV audio
  successfully on Apple MPS.
- **Unified tray and Bar** — Electron provides quick chat/recording/voice tray
  actions and publishes a private authenticated endpoint that the Swift
  OpenRappter Bar prefers over launching a competing gateway.

### Security

- Typed ComputerUse text is represented only by length, never content.
- Credential- and sign-in-looking windows refuse screenshot capture.
- Raw frames and frame paths are never sent to Copilot; only the separately
  approved privacy-safe textual event summary can leave the machine.
- Session roots, databases, frames, skills, manifests, and automation bundles
  use owner-only permissions and reject symlinked destinations.
- Electron carries an isolated packed runtime and Electron-ABI SQLite binding;
  the system Node binding is never rebuilt or shared.
- The desktop gateway uses a random per-process bearer token and a dedicated
  loopback port. The endpoint file is private, bounded, and removed only by its
  owning process.
- VibeVoice is an opt-in preview with explicit responsible-use disclosure; the
  server is loopback-only, access logs are disabled, text is bounded, and
  source/model/tokenizer revisions are pinned.

## [1.12.0] - 2026-08-11

### Added

- **Provider-neutral Flight Recorder** in TypeScript and Python — a local
  SQLite WAL ledger records correlated trace, context, provider, tool, and
  agent lifecycle events under `openrappter-event/1.0`.
- **Privacy-safe defaults** — raw prompts, responses, tool arguments, and file
  contents are omitted unless explicitly enabled. Opt-in IO is recursively
  scrubbed for secret keys, secret-shaped values, sensitive paths, circular
  values, unsafe numbers, and bounded by a post-redaction byte cap.
- **Integrity-checked replay bundles** — versioned
  `openrappter-flight-export/1.0` export/import with SHA-256 event hashes,
  atomic tamper rejection, durable sequence continuity, and a committed
  TypeScript/Python golden vector.
- **Flight Recorder CLI** — `flight status`, `events`, `export`, `import`, and
  confirmation-gated `clear`.
- **Release-enforced cross-runtime gate** — behavior, mutation, privacy,
  causality, retention, package, TypeScript, and Python validation now block
  release artifact publication.

### Changed

- Provider responses may report the concrete model that actually answered;
  `auto` remains a routing policy in metadata instead of being persisted as a
  false model identity.
- Retention prunes whole completed traces and preserves active traces rather
  than leaving replay fragments without their start/context events. Nested and
  resumed activity is evaluated by lifecycle depth in trace sequence order.
- Replay exports read one uncapped SQLite snapshot, while interactive queries
  retain their 10,000-event safety cap.
- Trace sequence allocation reloads after cross-process SQLite conflicts, and
  long-trace recovery uses one descending lookup rather than capped paging.
  Lifecycle durations use monotonic clocks rather than wall time.
- Absolute workspace paths are persisted as stable SHA-256 scope identifiers,
  not raw filesystem paths.
- Session identifiers are persisted as stable SHA-256 scope identifiers so
  channel keys cannot leak phone numbers, email addresses, or chat GUIDs.
  A private per-installation HMAC key prevents offline dictionary reversal.

### Security

- Persisted error metadata contains only safe class/code/status, message hash,
  and message length. Raw provider response bodies remain opt-in payload data.
- Flight databases, live WAL/SHM sidecars, and atomically replaced export
  bundles use private filesystem modes. Custom database paths do not chmod
  caller-owned parent directories.
- Session/channel identifiers are normalized at the recorder boundary, and
  Python query aliases reject unknown filters instead of silently exporting an
  over-broad history.
- Secret-shaped and excluded-path property names are replaced with
  collision-safe markers before hashing or persistence; contents under
  excluded filenames such as `.pem`, `.p12`, and service-account files are
  removed.
- Direct provider calls in telephony, Surgeon, LearnNew, Ouroboros, and
  iMessage readiness checks now emit the same provider lifecycle evidence as
  Assistant turns.
- The Copilot CLI MCP child initializes its own recorder, streaming preserves
  provider-reported model identity, and unknown fallback models remain
  explicitly unattributed.
- Copilot CLI child tools inherit the originating trace/parent scope and record
  a tool-to-agent causal subtree rather than a disconnected child trace.
- Standalone records evict sequence caches, and explicit recorder installation
  remains synchronized with environment bootstrap.

## [1.11.0] - 2026-08-10

### Added

- **One device, many rappters** — an *alpha* holds the default port and the
  device's channels, and any number of *hatched twins* run beside it, each with
  its own identity, port, and lock. `openrappter hatch <name>`,
  `openrappter twins`, and `--instance <id>` address them.
- **Twin-to-twin chat** — a rappter can speak to a peer, not only be spoken to.
  `POST /twin` carries the `rapp-twin-chat/1.0` envelope, and a peer that
  speaks `/chat` but not `/twin` is still reachable.
- **Neighbourhood and roster** — a running rappter can reach a neighbour, tells
  its neighbours which twin it is, and is judged by the same name the roster
  calls it.
- **Copilot Surgeon primary interface** — replaces the static dashboard landing
  page with an adaptive operating room where OpenRappter is the patient and
  GitHub Copilot shapes each next interaction from live, sanitized patient
  anatomy. Existing operational pages remain available as secondary anatomy.
- **Consent-bound procedures** — Copilot proposals are persisted with an
  immutable SHA-256 digest, require explicit owner approval (plus
  `OPERATE OPENRAPPTER` for high-risk work), and cannot report recovery without
  real agent-tool evidence and post-operative verification.
- **Release channels** — `openrappter channel` manages stable and experimental
  rings, with isolated canary, nightly, alpha, and beta promotion.

### Changed

- **The Copilot CLI ships with the commit.** `@github/copilot` is a
  lockfile-pinned dependency resolved from this package's own `node_modules`
  rather than found on `PATH`, so its version is no longer decided by whoever
  last ran `copilot update`. Resolution order — explicit operator override,
  then the pinned copy, then ambient globals — is covered by tests.
- **The digest is re-checked before reuse.** The installer stamps the CLI's
  SHA-256 at build time and verifies it again before reusing an installation,
  so a binary substituted after install forces a rebuild instead of running.
- **`--status` names the binary that will actually answer**, instead of
  judging Copilot solely by `GITHUB_TOKEN` and reporting it unavailable while
  the gateway answered happily through the CLI backend.
- Installer digests are computed from the commit's git blob rather than the
  working tree, so a stale checkout or a local line-ending conversion cannot
  publish a hash for bytes that were never released.

### Fixed

- **HTTP RPC authentication** — token/password mode no longer trusts every
  loopback request implicitly; protected JSON-RPC and `/chat` calls now enforce
  configured credentials consistently with WebSocket authentication.
- `/twin` requires the same credential `/chat` requires, and `/agents/import`
  — which executes code — requires it too.
- A hatched twin shares the device, never a mouth: a channel alias cannot route
  around the registry, and a twin is told which mouths are not its own.
- A stale endpoint record is history, not an address; a name that never started
  is not answered for by someone else; a dead pid is not a serving process.
- An unknown `POST` path returns 404 rather than `200 "Received: …"`, and an
  over-cap request body is answered with 413 rather than a connection reset.
- A `--port` typed after a subcommand reaches that subcommand.

## [1.10.0] - 2026-07-11

### Added

- **Dual-use binary classification** (RAI hardening, closes audit must-fix #3's mechanism) — `exec-safety.ts` now tags network-fetch/install/arbitrary-exec/permission binaries (`curl`, `wget`, `pip`, `npm`, `npx`, `yarn`, `pnpm`, `node`, `python`, `tsx`, `chmod`, `chown`) via `DUAL_USE_BINS`; every `SafetyCheckResult` carries `dualUse` + `requiresApproval` so an approval layer can gate them (still `safe` under the default policy — backward-compatible). New opt-in `ExecSafety({ strictDefaults: true })` starts from the safe set minus dual-use binaries, so they return `safe: false, requiresApproval: true` unless explicitly re-added. Injection detection still precedes classification (a `curl … | sh` is blocked, not merely gated). `isDualUse()` helper; 6 new tests (suite 3109 → 3115).

### Added

- **Brainstem device-code auth** (kernel parity) — `POST /login` starts the GitHub device flow (same `COPILOT_CLIENT_ID` GitHub App as the RAPP kernel, producing `ghu_` tokens), `POST /login/poll` captures and persists the token in the kernel's `.copilot_token` JSON format (legacy plain-text reads supported), `GET /login/status` reports state. Token resolution: env → saved file → gh CLI (`gho_` OAuth tokens skipped — they 404 on the Copilot exchange, same lesson the kernel encodes). Copilot session now caches with `expires_at` + 60s buffer and re-exchanges when stale. 5 new auth-parity tests (Python suite 655 → 660).

### Added

- **OpenRappter Brainstem** (`python/openrappter/brainstem.py`, `python -m openrappter.brainstem`) — the local-device-first rappter: a stdlib-only (zero-dependency) HTTP server wire-compatible with the RAPP brainstem kernel so all training transfers. Same routes (`/chat`, `/health`, `/agents`, `/agents/import`, `/agents/export/<f>`, DELETE `/agents/<f>`, `/version`, `/models`), same JSON envelopes, same single-file agent contract with kernel-parity import shims (`agents.basic_agent` / `basic_agent` → OpenRappter's BasicAgent — the exact mirror of how the RAPP kernel shims `openrappter.agents.basic_agent`). Packaged OpenRappter agents form the default pool; user drop-ins in `~/.openrappter/brainstem/agents/` hot-load per request and override by name. `/chat` runs the Copilot tool loop (same token-exchange handshake as the kernel; `GITHUB_TOKEN` or `gh auth token`). Default port 7072 (`PORT=7071` for full drop-in). 8 wire-parity tests including a RAPP-authored agent dropping in unchanged and a full tool-loop round; verified live end-to-end with real Copilot on claude-sonnet-5. Also fixes a 30s `socket.getfqdn()` reverse-DNS hang per server bind on macOS.

### Added

- **Weighted sentiment words** (Roadmap 2.5 graduated scoring) — `SENTIMENT_WORD_WEIGHTS` intensity tiers (mild 0.5 / strong 1.0; flat word lists now derive from the map, preserving membership for the negation counter and input-difficulty scorer); generated `analyzeSentiment()` scores by weight, so "amazing" moves the needle twice as far as "good" and three milds barely offset one strong. Behavioral test executes the actual generated method (brace-extracted from catalog output), not a recomputation.

### Added

- **Simpson's Diversity Index** (Roadmap 2.5 graduated scoring) — generated `wordStats()` now reports `simpson_diversity` (1 − Σn(n−1)/N(N−1)) and `checkWordStats`'s `has_diversity` check uses it (threshold D >= 0.7, inclusive) instead of the raw unique/total ratio — repetition is weighted by frequency, so one dominant word is penalized even when many words are unique. E2E evolution test asserts the real generated capability emits valid entropy and Simpson values.

### Added

- **Character-level cipher verification** (Roadmap 2.5 graduated scoring) — `checkCaesarCipher` gains a `char_shift_valid` check that verifies every character is shifted by exactly ROT13 (case preserved, punctuation passed through); a transform that merely roundtrips (e.g. string reversal) now fails. Cipher denominator 3 → 4 checks; 3 new tests.

### Added

- **Soul-to-soul communication** (Roadmap 1.2) — agents invoked through a soul now receive a `_soul` handle in kwargs (`{ id, chain, summon(rappterIds, message, mode) }`) that summons sibling souls through the manager. An ancestry chain rides every nested invocation: summon cycles (a → b → a) are blocked, depth is capped at `MAX_SOUL_SUMMON_DEPTH` (3), and souls loaded without a manager degrade gracefully. 4 new tests.

### Added

- **`rappter.create` RPC** (Roadmap 1.2) — create and load a soul from a natural-language description: name inferred via LearnNewAgent's keyword convention (explicit name wins), kebab-case id with collision suffixing, and an auto-derived `systemPrompt` so identity injection carries the persona to agents; `persist: true` saves the config. `RappterManager.createSoul()` + 6 new tests; rappter RPC surface now 13 methods.

### Added

- **RAPP brainstem drop-in compliance harness** (`python/tests/test_brainstem_compliance.py`) — proves every `*_agent.py` in `python/openrappter/agents/` runs when dropped into a rapp-installer brainstem (kody-w/rapp-installer, per rapp-spine). Replicates the kernel's `_load_agent_from_file` contract in a clean subprocess per agent: kernel `BasicAgent` (vendored verbatim as a fixture), import shims exactly as the brainstem registers them, zero-arg instantiation, registration by `instance.name`, and `to_tool()` for the /chat loop. Unshimmed `openrappter.*` imports fail exactly as they would in a real brainstem (validated with a negative control). Result: **12/12 agent files compliant**; 13 new tests.

- **Input difficulty scoring** (Roadmap 2.5, completes the quick-wins block) — `scoreInputDifficulty(input)` rates per capability whether the input gives it a fair chance (word/unique-word minimums, alphabetic content, pattern categories present, sentiment-bearing words), with reasons listing exactly what's missing; `EvolutionReport` now carries `input_difficulty` so a weak capability score can be attributed to unfair input instead of a broken capability. 8 new tests.

- **Per-capability trajectory tracking with confidence gating** (Roadmap 2.5) — `EvolutionLineage` now includes `capability_trajectories`: an independent regression slope per capability, where a direction (improving/declining) is only reported when `|slope| > 2 × standard error` with 3+ data points — noisy histories read as stable instead of falsely trending. New `computeCapabilityTrajectories()` export; shared `linearRegression()` helper now backs the overall trajectory too.

### Fixed

- **Shared-agent context clobbering in parallel summons** — souls built from the default pool share agent instances, and `BasicAgent.execute()` stores per-invocation context on the instance; parallel `all`/`race` summons let one soul's context (including `soul_identity`) overwrite another's mid-invocation. Executions are now serialized per agent instance inside `RappterSoul.invoke` (distinct agents still run fully parallel).

- **Soul identity injection** (Roadmap 1.2) — a soul's identity (id, name, description, emoji, systemPrompt, model) now flows into every agent invocation via data sloshing as `upstream_slush.soul_identity`; previously `systemPrompt` and `model` were stored on the config but never used
  - New `SoulIdentity` type; `RappterSoul.identity` getter; `RappterSoulStatus` now includes `systemPrompt`
  - In chain mode each soul injects its own identity; optional fields are omitted when unset
  - 4 new tests in `rappter-manager.test.ts` (suite now 3081 tests)

- **OuroborosAgent scoring quick wins** (Roadmap 2.5) — two capability-assessment upgrades
  - Lexical entropy: generated `wordStats()` now reports Shannon entropy over the word frequency distribution; `checkWordStats` gains a `lexical_entropy` check (threshold H >= 2.0), making trivially repetitive input fail
  - Negation handling: generated `analyzeSentiment()` flips polarity for sentiment words preceded by a negator within a 2-token window ("not good" scores negative) and reports flipped words in `negated`; `checkSentiment(s, inputText)` gains a `negation_handled` check that independently recomputes expected flips from the input
  - Shared sentiment vocabulary (`SENTIMENT_POSITIVE_WORDS`, `SENTIMENT_NEGATIVE_WORDS`, `SENTIMENT_NEGATORS`) exported as single source of truth for generated agents and the judge
  - Denominators: word stats 5 → 6 checks, sentiment 4 → 5 checks; ouroboros suite 81 → 86 tests

### Fixed

- All 8 outstanding ESLint warnings (unused imports/variables in `twin-methods.ts`, `pii.ts`, `index.ts`, and 2 test files) — lint is now warning-free

- **Soul config persistence hardening** (Roadmap 1.2) — persistence is now backed by a dedicated `SoulStore` (`gateway/soul-store.ts`) with filename-safe ID validation (blocks path traversal via `saveSoulConfig`), config shape validation on load, corrupt-file tolerance, and an injectable souls directory for tests
  - `RappterManager` persistence methods (`saveSoul`, `saveSoulConfig`, `deleteSavedSoul`, `listSavedSouls`, `loadSavedSouls`) now delegate to `SoulStore`; new `restoreSouls()` reports restored/skipped/failed IDs; `loadSoul` gains a `persist` option
  - 4 new RPC methods: `rappter.save`, `rappter.persisted`, `rappter.restore`, `rappter.forget` (save/restore/forget require auth)
  - Gateway startup restores all persisted souls after loading the default soul
  - `soul-store.test.ts` — 27 new tests (store, manager integration, RPC end-to-end)

## [1.9.1] - 2026-02-22

### Added

- **Showcase #20: Agent Stock Exchange** — multi-round marketplace simulation where 3 analyst agents bid on 20 deterministic tasks across 4 categories (data/web/security/infra). Exercises AgentGraph, BroadcastManager, AgentRouter, and BasicAgent + data_slush simultaneously. Emergent specialization, reputation effects, and wealth distribution.
- **5 remaining UI-called RPC methods** registered in method files for MockServer/test parity
  - `chat.messages` — retrieve session messages with optional limit
  - `channels.send` — send a message via channel registry
  - `agents.files.read`, `agents.files.write` — read/write agent files via registry
  - `config.apply` — apply raw config with configManager or in-memory fallback
- 16 new tests across `dashboard-rpc.test.ts` and `gateway-rpc-methods.test.ts`
- Total test count: 2769 tests across 106 files

## [1.9.0] - 2026-02-22

### Added

- **Dashboard RPC parity**: All 12 UI pages now fully functional — 19 missing RPC methods registered
  - `chat.list`, `chat.delete` — session management for chat and sessions pages
  - `cron.list`, `cron.add`, `cron.enable`, `cron.run`, `cron.remove` — full CRUD for cron page
  - `skills.list`, `skills.toggle` — skill listing and enable/disable for skills page
  - `agents.list` — agent summary listing for agents page
  - `channels.list`, `channels.connect`, `channels.disconnect`, `channels.probe`, `channels.configure` — channel ops for channels page
  - `connections.list` — device listing for devices page
  - `status`, `health` — system info for debug and presence pages
- 3 new method files: `channels-methods.ts`, `connections-methods.ts`, `system-methods.ts`
- `dashboard-rpc.test.ts` — 30 new handler tests for all dashboard RPC methods
- Updated `gateway-rpc-methods.test.ts` — 25 → 55 tests covering 18 method groups
- Total test count: 2753 tests across 106 files

## [1.8.2] - 2026-02-22

### Fixed

- Stale version references in `CLAUDE.md` (1.6.0 → 1.8.0) and `skills.md` (1.4.0 → 1.8.0)
- Empty `__init__.py` files in 7 Python sub-packages now have proper exports with `__all__`

### Added

- Export tests for all 7 Python sub-packages (`test_module_exports.py`)
- CHANGELOG entries for v1.5.0–v1.8.1

## [1.8.1] - 2026-02-22

### Added

- **Parallel AgentGraph** execution in Python (`python/openrappter/agents/graph.py`)
- 9 Python showcase ports: Darwin's Colosseum, Infinite Regression, Ship of Theseus, Panopticon, Lazarus Loop, Agent Factory, Swarm Vote, Time Loop, Ghost Protocol
- 11 new Python modules: channels, config, gateway, mcp, memory, security, storage sub-packages
- 81 new Python tests across showcase and parity test suites
- Version bump to 1.8.1 in `package.json` and `pyproject.toml`

## [1.8.0] - 2026-02-17

### Added

- **Python parity**: `AgentChain`, `AgentGraph`, and `AgentTracer` ported to Python
- Chat methods for gateway WebSocket protocol
- 151 new tests across TypeScript and Python
- Swift agent fixes for actor isolation

## [1.7.0] - 2026-02-14

### Added

- **Phoenix Protocol**: Self-healing agent orchestration (32 tests)
- **19 Showcase Prompts**: Advanced agent orchestration patterns with runnable examples
  - The Architect, Ouroboros Accelerator, Swarm Debugger, Mirror Test, Watchmaker's Tournament
  - Living Dashboard, Infinite Regression, Code Archaeologist, Agent Compiler, Doppelganger
  - The Inception Stack, Data Sloshing Deep Dive, Memory Recall, Channel Switchboard
  - Config Hotswap, Persistence Vault, Healing Loop, Authorization Fortress, Stream Weaver
- Showcase dashboard UI page (`<openrappter-showcase>` Lit web component)
- Showcase RPC methods: `showcase.list`, `showcase.run`, `showcase.runall`
- 176 showcase tests (all deterministic, no LLM calls)

## [1.6.0] - 2026-02-12

### Added

- **AgentGraph**: DAG executor with parallel execution, topological sort, cycle detection, multi-upstream `data_slush` merging
- **AgentTracer**: Span-based observability for agent execution (start/end/duration/inputs/outputs)
- **MCP Server**: Expose agents as Model Context Protocol tools via JSON-RPC 2.0 over stdio
- **Dashboard REST API**: HTTP endpoints for web dashboard (`/api/agents`, `/api/traces`, `/api/status`)
- Python parity tests for broadcast, router, subagent patterns

## [1.5.0] - 2026-02-11

### Added

- **AgentChain**: Sequential pipeline with automatic `data_slush` forwarding, transforms, timeouts
- **LearnNewAgent TypeScript port**: Runtime agent generation with hot-loading, factory pattern
- LLM-powered agent description inference for LearnNewAgent
- 10 LearnNewAgent runtime generation prompts
- 10 agent chain prompts

## [1.4.0] - 2026-02-11

### Added

- **Single File Agent Pattern**: The defining architecture of openrappter
  - One file = one agent. Metadata contract, documentation, and deterministic code all in a single `.py` or `.ts` file
  - Native code constructors: Python dicts and TypeScript objects — no YAML, no config files, no magic parsing
  - `slush_out()` (Python) / `slushOut()` (TypeScript) — convenience helper for building `data_slush` dicts
  - `SubAgentManager` auto-chains `data_slush` between sequential sub-agent calls via `context.lastSlush`
  - `BroadcastManager` fallback mode passes `data_slush` from failed agents to the next in the chain
- **Single File Agent Manifesto**: RappterHub page explaining the standard
- All built-in agents use the native constructor pattern
- `LearnNewAgent` generates agents with native code constructors

## [1.3.0] - 2026-02-11

### Added

- **Data Slush**: Agent-to-agent signal pipeline
  - Agents can return a `data_slush` dict in their JSON output with curated signals from live results
  - `last_data_slush` (Python) / `lastDataSlush` (TypeScript) property on `BasicAgent` for accessing the most recent output
  - `upstream_slush` kwarg on `execute()` — automatically merged into `self.context['upstream_slush']` for downstream agents
  - Enables LLM-free agent chaining in sub-agent pipelines, cron jobs, and broadcast patterns
- `WeatherPoetAgent` — example agent demonstrating data_slush with live weather API integration and haiku generation
- `upstream_slush` field added to `AgentContext` type (TypeScript)

## [1.2.0] - 2026-02-05

### Added

- **Monorepo structure**: Separate `python/` and `typescript/` directories
- **TypeScript agent system**: Full port of Python agent pattern to TypeScript
  - `BasicAgent.ts` with data sloshing
  - `AgentRegistry.ts` for dynamic agent discovery
  - `ShellAgent.ts` and `MemoryAgent.ts` core agents
- Unified agent contract between Python and TypeScript
- `pyproject.toml` for Python packaging

### Changed

- Reorganized repository structure for dual-runtime maintenance
- Python package moved to `python/openrappter/`
- TypeScript source moved to `typescript/src/`
- Updated all documentation for monorepo structure
- Lowered Node.js requirement to 18+ (from 22+)

## [1.1.0] - 2026-02-05

### Added

- Dynamic agent discovery system (agents/ directory)
- BasicAgent base class following CommunityRAPP pattern
- Data sloshing for context enrichment
- Agent switching at runtime (`/agent <name>`, `/agents`)
- `--list-agents` and `--agent` CLI options

### Changed

- Renamed RAPPagent.py to openrappter.py
- Lowercase "rapp" throughout for readability
- Restructured to agents/ directory pattern

## [1.0.0] - 2025-02-05

### Added

- Initial release of openrappter
- GitHub Copilot SDK integration (no API keys needed!)
- Interactive chat mode
- Single task execution (`--task`)
- Persistent memory system
- Built-in skills: bash, read, write, list
- Custom skill support (YAML and Python)
- Onboarding wizard
- Python standalone version (openrappter.py)
- Full documentation and GitHub Pages site

### Technical

- Node.js 18+ required
- TypeScript with strict mode
- ESM modules
- Vitest for testing
