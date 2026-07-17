# iMessage: OpenRappter's primary external channel

On-device chat is the local control room. iMessage is the primary way a person
talks to a running Rappter away from that device.

OpenRappter uses one canonical transport:

```text
Messages.app
  -> signed imsg 0.12.3 (read-only chat.db + Apple Events)
  -> supervised Python iMessage service
  -> RAPP-shaped Python brainstem
  -> hot-loaded *_agent.py cartridges and memory agents
```

The TypeScript gateway, web UI, and menu-bar app remain the consumer control
plane. They display and control the Python sidecar; they do not run a second
Messages reader.

## Trust model

OpenRappter keeps one local memory graph, but each turn receives a
conversation-specific projection:

- owner conversations use the owner-private history;
- each other person has a private principal history;
- each group has a group history bound to its current participant roster;
- adding or removing a group member creates a new privacy epoch;
- direct-chat memories do not enter a group automatically;
- the same person can be recognized across chats without exposing why;
- a custodian can explicitly share one fact with the current group in natural
  language;
- consent is one-shot, fact-specific, audience-specific, and revocable;
- missing, malformed, ambiguous, or negated consent fails closed;
- non-owner conversations expose only trust-aware memory tools, never Shell or
  filesystem tools.

Transport setup uses a private local configuration file. Memory, consent,
sharing, revocation, and relationship behavior are controlled through natural
language—not forms.

## Install on one Mac

Requirements:

- macOS 14 or newer;
- a logged-in Aqua user signed into Messages;
- Python 3.10+ (3.12 recommended);
- a GitHub Copilot account;
- Full Disk Access and Messages Automation approval.

From the repository:

```bash
scripts/install-imessage-runtime.sh

~/.openrappter/runtimes/imessage/current/bin/python \
  -m openrappter.imessage \
  --config ~/.openrappter/imessage/config.json \
  init \
  --owner "<this Mac's owner iMessage handle>"

copilot login

scripts/install-imessage-service.sh
```

`init` discovers the exact self-chat identifiers without printing them. The
configuration and state files are mode `0600`; raw handles never appear in
logical session IDs or operational logs.

Grant Full Disk Access to the responsible OpenRappter/imsg process in:

`System Settings -> Privacy & Security -> Full Disk Access`

Approve control of Messages when macOS shows the Automation prompt.

Check health:

```bash
~/.openrappter/runtimes/imessage/current/bin/python \
  -m openrappter.imessage \
  --config ~/.openrappter/imessage/config.json \
  status
```

The service is ready only when `healthy`, `read_ready`, and `ready` are true.
`send_ready` becomes true after the first successful reply.

## Add people and groups

DMs and groups are deny-by-default. Add transport handles or stable chat
GUIDs only on the local Mac:

```json
{
  "allowed_dm_handles": ["<explicitly approved handle>"],
  "allowed_group_chat_ids": ["<stable chat GUID>"],
  "mention_required": true,
  "mention_tokens": ["@rappter"]
}
```

Display names are never identity links. Link multiple handles to one person
only through an explicit local `identity_links` entry.

Inside an allowed group, address the Rappter using its configured mention.
The rest is conversational:

```text
Remember that this launch detail is private between us.
You may share the launch detail with this group.
Do not share that detail anymore.
Forget that launch detail.
```

OpenRappter records the verified speaker, source event, exact audience, group
roster epoch, and one-shot consent capability before a memory agent may act.

## Three-Mac test

Use one dedicated macOS user and one distinct iMessage account per Rappter.
Do not run two active Rappters on one Apple account.

For each Mac mini:

1. Install the same OpenRappter commit and signed `imsg` version.
2. Run the runtime installer and initialize a private config.
3. Give the Rappter a distinct instance id, account, and mention token.
4. Complete FDA, Automation, and Copilot authorization.
5. Start the per-user LaunchAgent after GUI login.
6. Verify one DM reply, one addressed group reply, restart recovery, and
   sleep/wake recovery.

Then create a group containing the human and all three Rappters. Each Rappter
must answer only its own mention, preserve its own memory graph, keep group
history separate from DMs, and never respond to another Rappter's echo.

## Safety

- Never write directly to `chat.db`.
- Never enable SMS fallback; the service accepts iMessage chats only.
- Never run the service as root or as a system LaunchDaemon.
- Never retry an ambiguous send automatically.
- Never run live tests against arbitrary contacts or groups.
- Keep private IMCore features and SIP changes disabled.
