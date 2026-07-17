# iMessage assistant (macOS)

OpenRappter can run a private, allowlisted iMessage assistant on macOS. The
transport is deliberately deterministic: it ingests Messages rows, persists a
durable queue, invokes a tool-free assistant, and reconciles replies against
the local Messages database. It does not attach to an interactive Copilot CLI
session.

## Configure

Add this to `~/.openrappter/config.json`:

```json
{
  "channels": {
    "imessage": {
      "enabled": true,
      "mode": "applescript",
      "allowFrom": ["+15551234567", "person@example.com"],
      "pollInterval": 5000,
      "staleAfterMs": 1800000
    }
  }
}
```

`allowFrom` must contain at least one valid phone number or email address.
Unlisted or malformed senders are discarded before persistence or inference.
Group chats are always discarded. Attachments are acknowledged at the database
cursor but are not processed. BlueBubbles mode fails explicitly rather than
falling back.

Messages older than `staleAfterMs` when first observed are held as
`stale_pending`. They are never silently replayed or discarded; the sender must
use `/resume`. The default stale window is 30 minutes.

## Install and diagnose

Build once, then install the per-user launch service:

```bash
cd typescript
npm run build
node dist/index.js imessage install-service
node dist/index.js imessage diagnose
```

Useful operator commands:

```bash
node dist/index.js imessage service-status --json
node dist/index.js imessage diagnose --json
node dist/index.js imessage uninstall-service
```

The installer uses modern `launchctl bootstrap`, `enable`, and `kickstart`
operations, a private `umask`, throttled restart behavior, and an exclusive
gateway lock. If an installer-managed system daemon already exists, it becomes
a lightweight sentinel while the GUI LaunchAgent owns the gateway. This is
intentional: Apple Events automation must run in the logged-in GUI session.
The delegation marker is a lease: interrupted handoffs expire, and the system
daemon resumes if the GUI gateway remains unavailable. Removing the user
service removes the lease and restores normal system-daemon ownership.

`GET /livez` reports process liveness. `GET /readyz` reports dependency
readiness and returns a sanitized reason code when iMessage is degraded.
Gateway liveness never depends on Messages permissions, preventing restart
storms.

## macOS permissions

The process that actually owns the GUI LaunchAgent needs:

1. **Full Disk Access** to read `~/Library/Messages/chat.db`.
2. **Automation → Messages** access to send with Apple Events.
3. A valid **GitHub Copilot token** available through OpenRappter's private
   `.env` file or GitHub CLI authentication.

Run `imessage diagnose` after changing permissions. A terminal foreground probe
does not prove that a background launch identity has the same TCC grants.

## Mobile commands

- `/status` — readiness and queue summary
- `/diagnose` — sanitized cursor, poll, model, and send health
- `/reset` or `/new` — clear this chat's persisted assistant history
- `/resume` — release stale messages held for this chat
- `/retry` — explicitly retry the latest ambiguous delivery; a duplicate is
  possible and the command says so
- `/help` — command summary

Commands are handled without model invocation.

## Durability and privacy

State lives in `~/.openrappter/imessage.sqlite` using SQLite WAL mode. The
directory is `0700`; the database, WAL, and shared-memory files are `0600`.
Legacy `imessage-state.json` and `imessage-conversations.json` files are
imported once and retained untouched as rollback evidence.

The core invariants are:

1. An accepted inbound GUID and its Messages cursor advance commit in one
   transaction.
2. Model work never blocks database polling.
3. One turn per chat runs at a time; different chats may progress concurrently.
4. Replies are durable before send and chunks remain ordered.
5. A crash before send is retryable. A crash after entering `sending` is
   reconciled against new `is_from_me` rows in `chat.db`.
6. Unconfirmed sends become `ambiguous` and are not blindly resent.
7. Later chunks are cancelled if an earlier chunk is ambiguous or dead-lettered.

Messages database read-back confirms local Messages persistence, not remote
delivery. Exactly-once remote delivery is not available through AppleScript;
the implementation favors no duplicates and explicit ambiguity.

The assistant receives bounded per-chat user/assistant history. It has no
shell, filesystem, memory, or messaging tools. The Copilot CLI runs with an
isolated `COPILOT_HOME`, a restricted environment, no custom instructions, and
an empty tool list. Transcripts are supplied as ephemeral private native
documents, and Apple Events reads recipient/body data from ephemeral `0600`
files; private text and addresses are not placed in process arguments. The
configured model is tried first; the CLI default can be used as a fallback when
that model disappears.

Message bodies, sender addresses, prompts, and tokens are never written to
OpenRappter logs. Health output contains only counts, timestamps, cursor lag,
and stable reason codes.

## Recovery

- `processing` work returns to a retry state after restart.
- `preparing` outbox work returns to `ready`.
- `sending` work remains at the ambiguity boundary until local reconciliation.
- Startup and poll failures use jittered backoff capped at 60 seconds.
- Definitively pre-send transport failures retry indefinitely with that bounded
  backoff; they are never dead-lettered merely because an outage lasted.
- A removed allowlist target is quarantined rather than crashing startup.
- A cursor beyond a replaced Messages database is safely re-baselined.

Before running an older pre-SQLite binary, stop both supervisors and preserve
`imessage.sqlite*`. The retained JSON files predate any post-migration messages;
starting old code directly can replay rows and is not a safe rollback.
