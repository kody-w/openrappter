# One-time seals — local-first preferences that need no setting up

A preference system usually asks people to make decisions before they have any basis for making
them: a settings screen, presented up front, full of switches whose consequences you cannot yet
imagine. Then it compounds the problem by syncing, so a new device inherits years of accumulated
choices instead of starting clean.

The Frontier uses a different primitive.

## The primitive

**Everything ships sealed.** A seal is a feature in its default state on this device, untouched.

**Acting on it pops the seal.** The person hears the station ident once, decides they do not want
it, and ends it there. That single action is the whole configuration step — no settings screen, no
confirmation, no decision made in advance of the experience that would inform it.

**A popped seal never re-seals.** Not at the next launch, not after an update, not after a month of
not being used, not because a later version thinks the person might feel differently now. The set of
popped seals *is* the preference state, and it only ever grows.

## Why this shape

- **A new device is intuitive from nothing.** Every seal is intact, so the product arrives in one
  known state. There is no configuration to import, no migration, nothing to understand before
  starting. The person shapes it by using it, in the moments where the choice actually makes sense.
- **It cannot surprise you.** Monotonicity is the trust property. A preference system that can
  silently revert — a reset, a migration, a well-meaning re-introduction — is worse than none,
  because the person learns their choices do not hold and stops making them.
- **No settings archaeology.** Nobody has to go looking for the thing they wanted to stop. The
  control lives at the moment, which matters most for rare features: when something happens once in
  twenty-five turns, the annoyance and the search are separated in time, and a buried setting is
  effectively unreachable.
- **It is trivially inspectable and trivially honest.** The state is a set of names. You can show a
  person exactly what they have popped, and "clear everything" means precisely what it says.
- **Local-first, so its promises are keepable.** The seal lives with the install, which is why the
  scope of "never" is this device and this install. Claiming more would be claiming something the
  product cannot deliver.

## The one door outward: the public summon

Seals do not sync, so a new device starts sealed and empty. That raises the obvious question — if
nothing carries over, how does a person get anything? — and the answer is the part that makes the
whole model work rather than merely tidy.

**There is exactly one door outward, and it is a public read.** A device with nothing on it can
**summon** a rappid tile from the public catalog by its seven-word key
([`RAPPID-TILE-PROTOCOL.md`](RAPPID-TILE-PROTOCOL.md)) — the tile is fetched from the public store
and verified locally. That is the entire handshake:

- **No account, no sign-in, no sync.** Nothing about the person is transmitted. The device asks for
  a name and receives bytes. That is what lets it work from nothing, and what makes it safe to
  offer on a device that has made no decisions yet.
- **Only the public face crosses.** The catalog reached through this door is public by
  construction; private material is not on the other side of it and cannot arrive through it. A
  device starting from nothing gets the public world, and only the public world.
- **The bytes are verified before they are anything.** A public read must not become a trust hole:
  a summoned tile is checked against its seed and face before it is installed or run, exactly as a
  locally-dropped one is. Fetching is not trusting.
- **The pipeline behind the door already exists.** Subscription, federation and deterministic
  resolution are described in [`SUMMON-PROTOCOL.md`](SUMMON-PROTOCOL.md), which builds on the RAPP Vision
  pattern rather than inventing one — and which is why a summon works offline from a cached profile.
- **Reaching out is itself a seal.** The first summon pops the seal on public lookup — a decision
  made once, in the moment it means something ("go and get that"), rather than a network-access
  question asked during setup before the person knows why they would say yes.

So the shape of a fresh device is: everything sealed, nothing inherited, and one public door a
person can choose to walk through. Set-up is not a screen to get through; it is the first thing you
actually wanted to do.

## Rules

1. **One action pops it.** No confirmation dialog, no "not now", no multi-step flow. A person who
   has decided has decided.
2. **Immediate.** It takes effect in the moment, including mid-occurrence — not at the next restart.
3. **Never re-seal, never re-prompt, never re-introduce.** No nagging, no gradual re-enablement, no
   experiment that turns it back on for a sample of people.
4. **Reset is deliberate and total.** A fresh install, or an explicit clear-data, restores every
   seal. Nothing else does, and nothing does it silently.
5. **If it cannot be written down**, honour it for the session and surface the failure. Silently
   discarding a person's choice is the one outcome that is never acceptable.
6. **Seals do not sync — but state is portable.** A second device starts sealed, on purpose;
   inheriting configuration is the problem this avoids, not a feature it is missing. What a fresh
   device gets instead is the public summon above, and what a person can carry deliberately is an
   exported `.egg`.

## Nothing syncs, but nothing is trapped

"Seals do not sync" must not quietly become "your device state is disposable". The private mapping
that builds up locally — the tiles, their transcripts, the agents bound to them, what has been
popped — is the person's, and it has to be able to travel.

The resolution is that **sync and portability are different things, and only one of them is a
problem.**

- **Sync is ambient.** It happens without being asked, it is invisible, and its result is a new
  device inheriting an accumulated configuration nobody chose. That is the thing being avoided.
- **Export is deliberate.** One action produces one artifact the person holds, can inspect, can
  keep, and can carry to another device on their own terms.

So the on-device state can be **exported as an `.egg`** — the Frontier's existing portable artifact
(`CONSTITUTION.md` Article IV), reused rather than a new format invented for the purpose — and
imported later on another device.

The rules that keep this honest:

1. **Both ends are explicit.** Exporting is an action; importing is an action. Neither happens
   because two devices noticed each other.
2. **It is inspectable, not an opaque blob.** A person can see what is inside before they carry it
   somewhere or hand it to anyone.
3. **Credentials do not travel.** The export carries the mapping — tiles, transcripts, bindings,
   popped seals — and never tokens, keys or session material. An artifact a person might email to
   themselves must not be a credential in a trench coat.
4. **Import never silently overwrites.** It merges, or it refuses and says exactly what conflicted.
   Arriving state does not get to quietly replace state that was already there.
5. **It is optional.** Nothing depends on it. A device that never exports has lost nothing it was
   promised, because the model never promised inheritance in the first place.

## The popping-the-local-seal test

This is the hero proof for the whole model, and it is deliberately end-to-end: it exercises a device
that has nothing, a public read, verification, and the permanence of a popped seal in one run.

It must be run on a **clean environment** — an isolated home with no prior state — and never on the
machine that just built the thing, because the interesting failures are all about what is or is not
already present.

### The run

1. **Start from nothing.** No local state, every seal intact, nothing synced from anywhere.
2. **It opens and works.** No set-up screen, no login, no configuration required before the first
   useful action.
3. **Summon a tile by its seven-word key.** This is the first reach outward, and it pops the
   public-lookup seal.
4. **The bytes are verified before they are anything** — checked against seed and face — and only
   then become a tile.
5. **Make it primary and use it.** Its agents compose and a real turn happens. A tile that arrives
   but cannot be used has not proven the path.
6. **Restart.** The popped seal is still popped, and the tile is still there.
7. **Pop a second seal in the other direction.** Trigger the station ident, end it in one action,
   then restart and confirm it never fires again on this install.

### What must also be true — the half that makes it a test

- **Nothing reached the network before step 3.** This is the assertion that gives a seal meaning: if
  a lookup happened while the seal was intact, the seal was decoration. Observe it, do not assume it.
- **A tile whose bytes fail verification is refused**, and nothing is installed, hatched or run.
  Fetching is not trusting, and the failure path is the one worth proving.
- **No identity was required or transmitted** for the read. The device asked for a name and got
  bytes.
- **Nothing private is reachable** through the public door — not by a crafted key, not by a
  redirect, not by a path that walks out of the public namespace.
- **The seal state is inspectable and honest**: what has been popped can be shown to the person, and
  clearing it restores exactly the set of seals and nothing else.

### Status

**Unverified.** This is the obligation, not a result. It cannot be claimed as passing until it has
been run on a clean environment and each numbered step observed — in particular the network
assertion in the first bullet, which is the one that is easy to assume and easy to get wrong.

## Where it applies

Anything a person may reasonably want to end on first contact, and anything rare enough that a
buried setting would not be found in time. The first instance is the station ident in
[`VOICE.md`](VOICE.md); it is the pattern for the ones after it.

It is **not** the right shape for settings that need to be changed back and forth — a volume, a
model choice, a theme. Those are ordinary preferences. A seal is for a decision that only ever gets
made in one direction.

## Implementation status

**Specified, not implemented.** Nothing in the tree stores or reads a seal: there is no
popped-seal state, no per-seal control, and no export or import of the local mapping. The nearest
existing thing is the RAPP Store path (`../electron/rapp-store.mjs`), which does a public read from
an allowed source and verifies bytes against a recorded hash before installing — the fetch-and-verify
half of the door, without the seal or the chant in front of it.
