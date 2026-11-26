# Senses

A sense is one more way an answer can reach you. The mind writes a marker, `|||VOICE|||`, and then the words for it.
OpenRappter says the voice part out loud. Nothing in the kernel changes: a sense is asked for in the message and read
from the reply.

## Built in

| Sense | What it is for | Status |
|---|---|---|
| `VOICE` | what is said out loud | current |
| `GLANCE` | one short line for the card | staging |

## Add your own

Drop a file in `~/.openrappter/senses/`, one file per sense:

```json
{ "tag": "WINGMAN", "ask": "what to tell Wingman, in one line", "show": true,
  "press": "Tell Wingman => ask:Tell Wingman this: {value}" }
```

| Field | Meaning |
|---|---|
| `tag` | the marker, capital letters, 2 to 16 characters |
| `ask` | one line telling the mind what to put there |
| `show` | put the words on the card |
| `press` | one button made from the words: `Label => ask:...{value}` or `Label => open:https://...{value}` |
| `then` | one more chat sent right after the turn, made from the words; the first line of its answer replaces them |

Rules the kit keeps for you:

- An added sense can never replace a built-in one. At most 8 are loaded. A broken file is skipped.
- A button only ever asks the mind something or opens a secure web address. Nothing else.
- A button does nothing until you press it.
- Words that start with `unverified` offer no button and no follow-through.

## Read what was sensed

Every reply's senses are written, one line each, to `~/.openrappter/senses/sensed.jsonl`
(`"schema": "openrappter-sensed/1"`). An agent file, a controller or a script beside the app can read it.

The code is `app/Sources/OpenRappterCore/SenseKit.swift`. Added senses ride on every ask you make with the hold-keys.

## Try one

```sh
mkdir -p ~/.openrappter/senses
echo '{ "tag": "CLARITY", "show": true, "ask": "the same answer in one plain sentence, under 20 words" }' > ~/.openrappter/senses/clarity.json
```

Ask anything. The card shows the answer, then the clear line under it.
