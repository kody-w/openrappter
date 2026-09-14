# Binding private-channel contract

Copilot CLI/stdio is primary. iMessage is optional and **default off**. It is a
continuity transport into the same selected root conversation, not another bot,
memory store, agent runtime, workspace identity or source of tool authority.

## Authority and delivery

- The local operator explicitly records one contact commitment, one local
  permission reference and the bounded conversation/public-recap scope.
- Those references are inert canonical data. `channels.bind` does not request
  macOS permission, access Messages databases, resolve contacts, launch an app
  or make the production adapter available.
- `DisabledIMessage` always refuses. A production bridge remains an integration
  gate until local OS permission, exact contact mapping and authenticated
  transport provenance are verified outside the carried message.
- Queuing creates a root-owned canonical `memory.save` record containing only
  exact bounded source GUID/scope/stream/hash references and the binding wave.
  `rapp-work.recap-references/1` has no copied activity summary. Read/delivery
  derives transient text from the originals; missing sources refuse rather than
  falling back to a central copy. Immutable historical summary queues are
  retained as historical records. Queuing does not send.
- Explicit delivery first appends a write-ahead attempt. The transport receives
  only the selected root, bound contact/permission references, text and a stable
  canonical delivery ID. A separate outcome records a bounded opaque receipt,
  `delivered`, `unavailable`, or `uncertain`.
- Rebinding a contact, disabling the binding, or hiding the root prevents
  delivery under an old queue's authority. No contact is guessed from prose.
- Restart never sends or retries. An explicit retry uses the original delivery
  ID; an enabled transport must guarantee idempotent delivery. A completed
  delivery is not sent again.

An outage recap is a read-only projection of pending canonical queues/outcomes.
It retains exact source references, preserves continuity and makes no model
request. It is not a second message database or a synthesized account of
messages that were never delivered.

## Incoming continuity

The injected transport verifies the incoming envelope; the core then requires
the explicitly bound contact and active root. A stable contact/message identity
becomes a canonical idempotency key. The text enters `Conversation.converse`,
not a separate channel agent. A repeated message cannot produce another model
call, and another contact cannot select a bot by claiming its GUID.

“Where were we?” remains read-only even when it arrives through iMessage.
Transport ingress cannot call `effects.approve` or acquire SDK tools. Irreducible
human/external authority remains explicit in the primary reviewed interaction.

## Synthetic evidence and future channels

`SyntheticIMessage` is an injected **test-only** port: no Apple APIs, private
scanning, contact lookup, native database access or real sending occurs.
Tests cover outage, persistent recap, contact substitution, authentication,
rebinding, hidden roots, duplicate input, concurrent delivery, and one actual
synthetic delivery after an explicit retry. The committed outage fixture is
labeled synthetic.

Future channels must feed this same conversation and canonical delivery
boundary with explicitly adopted capabilities. Adding a new transport is not
permission to expand tools, merge memory, auto-send, or introduce a channel
database.
