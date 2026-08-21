gitprotocol-molt(5)
===================

NAME
----
gitprotocol-molt - Agent lineage conventions for Git repositories

SYNOPSIS
--------
[verse]
<molt-repository>/
  refs/molt/loci/<locus>     # the lineage: one commit per generation
  refs/molt/live/<locus>     # the activated generation
  refs/molt/base/<locus>     # the immutable baseline (root commit)

DESCRIPTION
-----------

Agents have begun to modify themselves. They rewrite their own tools, accept
generated code, and adapt per device and per user -- increasingly without a
human reading the diff. Every platform approaching that capability meets the
same problems: instances diverge irreproducibly, a bad self-modification has no
floor to fall back to, provenance is unrecoverable, and an adaptation learned on
one instance cannot be moved to another.

Those are version control problems, and Git already solved them. This document
does not define a new object store, a new hash chain, or a new transport. It
defines the *conventions* by which agent lineage is represented in an ordinary
Git repository, so that existing Git implementations, hosts, tooling, and
signing infrastructure apply unchanged.

The design rule is deliberate: **inherit everything Git already guarantees,
specify only what Git has no opinion about.**

What Git provides, and this standard therefore does not restate:

* Content addressing and deduplication (blobs, trees).
* A tamper-evident history -- a commit commits to its tree *and* its parents,
  which is precisely the hash chain agent lineage requires.
* Movable pointers (refs), non-destructive time travel (checkout), and
  branching for divergent lineage.
* Transport, replication, and offline interchange (fetch, push, bundle).
* Authenticity of authorship (GPG/SSH commit signing).
* An ecosystem: hosting, review, diff, blame, bisect, notes, hooks.

What this standard adds:

1. A ref layout that separates *history*, *activation*, and *baseline* (below).
2. A verification gate between commit and checkout, because self-modifying
   agents cannot assume a human reviewed the change (see VERIFICATION).
3. A guaranteed floor: the baseline root commit, byte-identical across every
   instance of a distribution, which is both the recovery target and the
   population's shared identity.
4. A composition contract: how a resolved generation becomes what a live,
   lineage-unaware runtime actually loads (see COMPOSITION).

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" are to be
interpreted as described in RFC 2119.

REPOSITORY
----------

A *molt repository* is an ordinary Git repository. It MAY be bare. It SHOULD be
created with `--object-format=sha256`; implementations MUST NOT assume SHA-1.

A molt repository MUST NOT be the agent's working runtime directory. The runtime
loads a composed directory (see COMPOSITION); the repository is the history
behind it. This keeps the runtime unaware of lineage and unmodified.

OBJECT MODEL
------------

The mapping is total; there are no objects outside Git's model.

Locus::
        One agent's independent lineage. Represented as a ref namespace.
        The unit of independence: cadence, policy, and failure are per-locus.

Ring::
        One generation. Represented as a *commit*. A ring's identity is its
        commit id, which commits to both its content (tree) and its position
        (parents) -- the tamper-evidence is Git's, not ours.

Baseline (ring 0)::
        The factory source of an agent. Represented as the *root commit* of the
        locus, and pinned by `refs/molt/base/<locus>`. It MUST be reproducible:
        identical baseline source MUST yield an identical root commit id on
        every instance (see DETERMINISM).

Frame::
        The portable form of one or more rings. Represented as a `git bundle`.
        Interchange is `git bundle create` / `git bundle unbundle`, or ordinary
        fetch/push. No bespoke format is defined.

HEAD (activation)::
        `refs/molt/live/<locus>` names the generation currently composed into
        the runtime. It is distinct from the lineage tip so that "what history
        exists" and "what is running" are independently addressable -- an
        instance may hold newer, unverified rings while running an older one.

A locus MUST be a single-parent (linear) history. Merge commits MUST NOT appear
in `refs/molt/loci/<locus>`. Ancestry is single-parent by construction, which is
what makes "which baseline is this descended from" always answerable; divergent
adaptation is expressed as separate refs, never as a fused ring.

The tree of a ring commit MUST contain the agent's source at a path stable for
the locus. A locus SHOULD use a single-file tree; hosts MAY use multi-file trees
where the runtime's agent unit is a directory.

REF LAYOUT
----------

`refs/molt/base/<locus>`::
        The baseline root commit. Immutable. A host MUST NOT update this ref
        except to initialize it, and MUST NOT rewrite baseline history.

`refs/molt/loci/<locus>`::
        The lineage tip: the newest recorded generation. Append-only; a host
        MUST NOT force-update or rewrite it in normal operation.

`refs/molt/live/<locus>`::
        The activated generation. Moving this ref is the activation operation,
        and is how reversal ("back to baseline") and re-activation are
        performed. It MUST always resolve to a commit reachable from
        `refs/molt/loci/<locus>` or to the baseline commit.

`<locus>` is an opaque, filesystem-safe identifier that MUST be stable for the
same agent across instances of a distribution (see DETERMINISM).

Hosts MAY additionally publish `refs/molt/policy/<locus>` (see POLICY) and MAY
use `refs/notes/molt` for non-authoritative annotations. Anything under
`refs/molt/` not defined here is reserved.

COMMIT FORMAT
-------------

A ring commit message MUST use Git's trailer convention (see
linkgit:git-interpret-trailers[1]). Trailers are part of the commit object and
are therefore covered by the commit id: verification state cannot be altered
without changing the ring's identity and orphaning its descendants. This is the
central reason to represent rings as commits rather than as records beside them.

Defined trailers:

`Molt-Locus: <locus>`::
        REQUIRED. The locus this ring belongs to.

`Molt-Baseline: <commit-id>`::
        REQUIRED. The baseline root commit this lineage descends from. Makes
        every ring self-describing about its ancestry floor.

`Molt-Verified: <yes|no>`::
        REQUIRED. Whether this ring passed the host's verification gate.

`Molt-Verifier: <id>`::
        REQUIRED when `Molt-Verified: yes`. Identifies the gate that issued the
        verdict (implementation name and version).

`Molt-Fertile: <yes|no>`::
        REQUIRED when `Molt-Verified: yes`. Whether the ring is itself a valid
        parent for a further generation (see VERIFICATION, V3).

`Molt-Author-Kind: <human|model|tool>`::
        RECOMMENDED. Provenance of the change itself. Distinguishing
        model-authored from human-authored generations is the minimum needed to
        audit a self-modifying population.

A host that requires authenticated verdicts MUST sign ring commits
(linkgit:git-commit[1] `-S`) and verify signatures before activation. Signing is
Git's mechanism and is not restated here. Unsigned repositories still inherit
integrity -- the trailer cannot be edited without changing the commit id -- but
not authorship authenticity.

DETERMINISM
-----------

Interoperability requires that two hosts which never communicate derive
identical ids for identical content and ancestry.

* Source MUST be canonicalized to LF before it is written into a tree, so a
  checkout convention cannot alter identity.
* Baseline root commits MUST be created with fixed identity fields: author and
  committer name, email, and date MUST be constants defined by the
  distribution, not the local environment. Implementations SHOULD set
  `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` to the Unix epoch and use a
  distribution-scoped identity.
* `<locus>` MUST be derived from the baseline (its stable agent name and
  content), never assigned sequentially or per-host.

Given these rules, the baseline commit id is the distribution's shared "same
agent, same version" key across every instance in the world, and content
identity of any generation is its tree/blob id -- both supplied by Git.

Non-baseline rings MAY carry real timestamps and authorship; their determinism
requirement is only that content identity (tree) is stable.

VERIFICATION
------------

Git assumes a human reviews before merge. Self-modifying agents cannot assume
that, so a gate sits between *commit* and *checkout*. Recording a generation is
always permitted; activating it is not.

V1. The verdict belongs to the verifier::
        The candidate MUST NOT be able to determine its own verdict. A host MUST
        NOT accept a pass signal the candidate itself can emit. Static analysis
        of the candidate source by the trusted verifier is the recommended
        basis; dynamic execution MAY contribute an advisory signal, but the
        candidate MUST run isolated from the verdict's authority.

V2. Structural validity::
        The ring MUST satisfy the runtime's agent contract.

V3. Fertility::
        The ring MUST itself be a valid parent for a further generation. A ring
        that loads but cannot be adapted again is a dead end and MUST NOT be
        activated. This prevents lineages from degrading across generations.

V4. Whole-set validation::
        The complete composed set MUST be validated together before activation,
        not only ring by ring. Interaction failures -- duplicate tool names,
        import collisions -- are visible only at set scope.

V5. Fail closed::
        Any ambiguity -- timeout, crash, unreadable output, malformed metadata
        -- MUST resolve to not-verified.

A host SHOULD implement the gate as a Git hook so that verification is enforced
by the repository rather than by a cooperating client. The RECOMMENDED hook is
`pre-receive` (or `update`) on a shared repository, rejecting any ring pushed
with `Molt-Verified: yes` that the gate does not independently confirm.

COMPOSITION
-----------

Composition produces the directory a lineage-unaware runtime loads.

C1. Resolve::
        For each locus, resolve `refs/molt/live/<locus>`. If it is missing,
        unreadable, unverified, points outside the lineage, or its policy pins
        it (see POLICY), resolve to `refs/molt/base/<locus>`.

C2. Fail-safe::
        Composition MUST NOT fail. Every error path falls back -- to the last
        known-good generation, and ultimately to the baseline. The composed set
        MUST always be loadable.

C3. Atomic activation::
        The set MUST be staged, validated (V4), and then activated atomically. A
        partially composed set MUST NOT serve traffic. Implementations SHOULD
        stage into a content-addressed directory and swap.

C4. Substitute, never subtract::
        A lineage layer MUST NOT make an instance less capable than the same
        instance without it. The baseline set MUST NOT be removed from the load
        surface by lineage machinery, and any failure in lineage control MUST
        degrade to the runtime's native behavior.

C5. Zero-adaptation identity::
        With every locus at baseline, the composed directory MUST be
        byte-identical to what the host would produce with no lineage layer at
        all. Adopting these conventions MUST be a no-op until something molts.

POLICY
------

Each locus has a policy, default `mutable`.

`mutable`::
        The locus activates new generations normally.

`pinned`::
        The locus MUST resolve to its baseline regardless of what
        `refs/molt/live/<locus>` names, and a host MUST refuse to activate a
        generation on it. Recording history remains permitted.

Policy lets an operator freeze a memory or compliance-critical agent at its
factory source for life while an adjacent agent adapts continuously. Hosts MAY
store policy in `refs/molt/policy/<locus>` or in host configuration.

REVERSAL AND THE CODE/DATA BOUNDARY
-----------------------------------

B1. Lineage versions *code*::
        Agent memory, user data, and conversation state are NOT rings and MUST
        NOT be reverted by a lineage operation. This separation is what makes
        reversal safe to expose to end users: factory behavior is restored while
        everything the user accumulated persists.

B2. Reversal is a ref move::
        Reverting sets `refs/molt/live/<locus>` to the baseline commit. History
        is append-only, so reversal is non-destructive and re-activation remains
        available -- ordinary Git semantics.

B3. Reversal SHOULD be directly reachable by the user::
        without operator tooling. A host MUST NOT let that control surface
        interfere with normal operation (C4): if it fails, the request MUST fall
        through to normal handling.

B4. Honest reporting::
        A host MUST NOT report a state change that did not occur -- if the layer
        is disabled, a locus is pinned, or some loci failed, the response MUST
        say so.

B5. Disable means disable::
        When the layer is disabled, a host MUST NOT move refs. Deferred moves
        would silently activate on re-enable.

INTERCHANGE
-----------

Interchange is Git's. A frame is a bundle; replication is fetch and push.

I1. Verify on ingest::
        A receiving host MUST apply its own gate (VERIFICATION) to incoming
        rings. `Molt-Verified: yes` from a foreign host is provenance, not
        authority; trust does not transfer with the object.

I2. Reconcile at the baseline::
        Instances of the same distribution share a baseline commit id, so
        divergent lineages always have a common ancestor.

I3. Never fuse lineages::
        Irreconcilable lineages remain separate refs. Merge commits are
        prohibited in a locus; a host MUST NOT fuse two lineages into one ring.

I4. The baseline is the guaranteed meeting point::
        Because every instance shares a byte-identical baseline, any two
        instances can always converge by reverting to it -- regardless of how
        far the population has diverged.

GIT COMPATIBILITY
-----------------

A molt repository is a valid Git repository at all times. `git log
refs/molt/loci/<locus>` is a generation history. `git diff` between two rings is
a readable diff of an agent's evolution. `git bisect` locates the generation
that introduced a regression. `git verify-commit` checks a verdict's signature.
Any Git host can store it; no server-side support is required beyond hooks a
host chooses to install.

Conversely, nothing here requires a modified Git. An implementation is a
*porcelain* over plumbing commands.

CONFORMANCE
-----------

Core (required)::
        REPOSITORY, OBJECT MODEL, REF LAYOUT, COMMIT FORMAT, DETERMINISM,
        VERIFICATION V1-V5, COMPOSITION C1-C5.

Policy (optional)::
        POLICY.

User reversal (optional)::
        REVERSAL B1-B5.

Interchange (optional)::
        INTERCHANGE I1-I4. An implementation claiming this profile MUST follow
        DETERMINISM exactly; frames are otherwise not portable.

Implementations SHOULD publish the profiles they implement and the baseline
commit id of the distribution they are built on.

FIRST IMPLEMENTATION
--------------------

Molt Lineage in the RAPP Brainstem Frontier is the first use case and reference
implementation; see `MOLT-LINEAGE-PROTOCOL.md` in this repository for its
conformance profile.

SEE ALSO
--------
linkgit:git-bundle[1], linkgit:git-commit[1], linkgit:git-interpret-trailers[1],
linkgit:git-update-ref[1], linkgit:gitformat-signature[5], linkgit:githooks[5]
