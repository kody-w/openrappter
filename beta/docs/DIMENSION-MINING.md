# Dimension mining — race many possible versions at a flag

A tile diverges when it is used: your copy trains, adapts, and becomes
[your dimension of it](CRYSTALS.md). That happens one at a time, at the speed of a person
working.

**Dimension mining is doing it in parallel, on purpose, against a goal.** Mint many candidate
dimensions of a tile, run them at the same time, and keep the one that reaches the objective.
The candidates need not exist yet and need not be plausible — a mined dimension is a
hypothesis explored in the virtual, and most of them are meant to lose.

The arena already races tiles that exist. This mints the contenders.

The parallel execution engine underneath — how many run at once, in what isolation, under what
budget — is [`rapp-qqdrill/1.0`](QQDRILL-PROTOCOL.md).

## The one constraint that makes it engineering

**A mined race requires a flag the machine can check.**

That is the whole discipline, and it is why the framing is capture-the-flag rather than
"pick the best". A flag is a success condition evaluated mechanically: a test that passes, a
file that verifies, an endpoint that returns the expected shape, a value that matches. If the
objective cannot be checked without a person's judgement, this is not mining — it is
generating a lot of output and asking a model which one it likes, which is expensive, feels
productive, and proves nothing.

So the pipeline is:

1. **A task arrives.** From the person, in their own words.
2. **A flag is derived, and shown.** The concrete, checkable condition that counts as done. If
   one cannot be derived, mining refuses and says why — the honest answer is "this task needs
   you to judge it", not a race with an invented scoring rubric.
3. **Candidates are minted.** Each is a dimension of the starting tile: a different approach,
   a different composition of agents, a different adaptation.
4. **They run in parallel, and are checked against the flag**, not against each other. Several
   may capture it; none may.
5. **The winner is promoted**, the rest fold. A tie is broken by something stated in advance —
   fewest steps, least model spend — never by a judgement made after seeing the results.

## Rules

1. **The flag is fixed before the race starts.** A goal adjusted after seeing the candidates is
   not a goal, and a race whose target moves proves only that something eventually matched it.
2. **Mining is bounded and visible.** A fan-out has a budget — how many dimensions, how much
   model spend, how long — and it is shown before it starts and while it runs. Parallel work
   that quietly consumes a machine is not a feature.
3. **Losers fold, they do not vanish.** A dimension that failed is evidence about what does not
   work, and folding already keeps it recoverable. What was tried and rejected is part of what
   the run produced.
4. **Lineage is carried.** Every mined dimension records the tile it descended from, the task,
   and the flag it was racing, so a winner can be explained rather than merely trusted.
5. **Winning wears nothing; training wears everything.** A drill that fed real updates back into
   the adapter has genuinely made the tile need less, and its [crystal](CRYSTALS.md) wears by
   exactly that much — for losing drills too, if they trained. What a *win* confers is promotion,
   never experience. And the lineage records that the wear was **drilled**, not used: a tile worn
   entirely in virtual dimensions and never touched by a person is a real object but not a
   battle-tested one, and must never present as though it were.
6. **Nothing is published by a race.** The winner is promoted locally. Publishing stays the
   deliberate act it is everywhere else.

## Why this is worth having

The expensive part of a hard task is usually not doing the work; it is discovering which
approach was the right one, serially, by trying them. Mining converts that serial cost into a
parallel one and makes the answer checkable at the end — but only where the objective can be
stated as a flag. Being strict about that is what keeps it from becoming a very fast way to
produce confident nonsense.

## Status

**Specified, not implemented.** What exists today: tiles, dimensions, lineage, the arena, and a
single-contender race (`tiles-race`). What does not: minting candidate dimensions, deriving and
displaying a flag, the parallel runner, the budget surface, and the promote/fold resolution.
The flag derivation is the part to build first — without it the rest has nothing to score.
