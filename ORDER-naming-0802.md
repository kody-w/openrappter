# ORDER — the default name: designation + Finn

## 0. What Kody asked for

> "the default name is openrappter with its rappid appended to it for the long name
> and then use the first characters of the rappid to make it like FIN in star wars
> based on his stormtrooper number to make it fun"

Two names for every organism, both pure functions of its identity:

- **Designation** (the FN-2187) — `openrappter-<RAPPID>`. Formal, unique, verifiable.
- **Called name** (the Finn) — derived from the leading characters of the RAPPID, made
  pronounceable. What it actually goes by.

Poe Dameron looked at FN-2187 and said "Finn". That is the whole mechanic, and it is
good: the friendly name is *derived from* the serial number, not assigned instead of it.

## 1. The precision point — RAPPID is not the tail

Kody said **rappid**, and that is correct. The trap is that in the code as it stands the
only thing that exists is the **tail**, so the obvious implementation names the organism
after the first characters of its own mint-once secret.

Established facts, do not re-derive them:

- `rappdex/allele.js`: every trait is
  `int(sha256("rapp/1:allele:<trait>\n<tail>")[:bits/4], 16)`, mint-once per RAPP/1 §6.2.
- `rapp-pets/README.md`: the 64-hex tail is minted exactly once and never re-rolled.
- `rappdex` states plainly: **"your tail is never in it."**
- `rappdex/mapp.json`, canon: **"A rappid is identity (word 4). A name is never
  identity — only a hash is."**

So: **the tail is GOD-layer and never appears in a name, a URL, a window title, a log
line, or the anatomy page.** The RAPPID is a *public* value derived from it by the same
domain-separated hash pattern the alleles already use:

```
rappid_hex = sha256("rapp/1:rappid\n" + tail)      # public, safe to display
```

Same construction as `allele()`, different domain string. Deterministic, offline
verifiable, reveals nothing about the tail. If RAPP/1 §6.2 already specifies a public
rappid encoding, **use that instead and tell me** — check `rapp-mapp` and `rapp-1`
before inventing. Matching the spec beats matching this file.

## 2. The designation — make it look like a serial number

`FN-2187` is two letters and four digits. Read that shape out of `rappid_hex`:

- **Two letters** from the leading bits, mapped A–Z.
- **Four digits** from the next bits.

Giving `RX-4471`, `TK-8802`, `FN-2187`. Long name: **`openrappter-RX-4471`**.

Show the full designation somewhere in the anatomy page's skull/soul organ, and make it
copyable — it is the organism's identity and people will need to quote it.

## 3. The called name — the Finn move

Take the two letters and make them speakable by inserting vowels chosen
**deterministically from the next bits of the same hash**, so one rappid always yields
one name, on any device, forever — the same property the alleles have.

```
FN -> Finn      RX -> Rex       TK -> Teek
BB -> Bibi      DZ -> Deza      KL -> Kaylo
```

Rules that keep it fun instead of embarrassing:

- **Always pronounceable.** Never emit a bare consonant cluster.
- **Deterministic.** Same tail → same name, forever, everywhere. No randomness, no
  clock, no counter.
- **A blocklist.** Two letters plus vowels will eventually spell something obscene or a
  real slur. Screen the output against a blocklist and deterministically fall to the
  next vowel set on a hit. This is not optional — the name goes on a public surface.
- **Kody can override.** The derived name is the *default*, the thing it answers to
  before anyone names it. A user-chosen name in `SOUL.md` always wins. The designation
  never changes; only the called name does.

## 4. Where it has to show up

- **The anatomy page skull/soul organ.** This replaces "This organism has no name." with
  its actual identity — designation and called name — and that is the better answer.
- The OpenRappterBar window title and the chat surface: called name, designation on hover.
- `/chat` and the greeting: it introduces itself by its called name.
- **Grail parity.** The brainstem must derive the *same* two names from the same tail.
  Same domain string, same encoding, same blocklist. If the two platforms disagree about
  an organism's name, the shared-identity story is broken. **Do not modify the grail
  installer repo** — implement on the openrappter side to match, and if the brainstem
  has no derivation yet, say so and give me the diff it would need.

## 5. Acceptance

1. Given a fixed tail, both names are stable across runs, processes and machines.
2. `sha256` of the tail appears nowhere; the **tail itself** appears in no name, title,
   URL, log, or served payload. Grep the served HTML and JSON to prove it.
3. Two different tails give two different designations; a thousand sampled tails give no
   blocklisted called names.
4. A `SOUL.md` name overrides the called name and leaves the designation untouched.
5. The anatomy page shows both, and the organism introduces itself by the called name in
   a real `/chat` round trip — quote it.

## 6. Report

The derivation you used (and whether RAPP/1 already specified one), a table of ~10
sample tails → designation → called name so the taste is visible, and confirmation the
tail never leaks. Flag it if the spec disagrees with anything above — the spec wins.
