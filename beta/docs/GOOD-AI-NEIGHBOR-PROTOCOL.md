# Good AI Neighbor protocol

> **Schema:** `openrappter-good-ai-neighbor/1.0`
> **Status:** shipped contract
> **Principle:** one dock creature owns one isolated AI estate containing one
> or more neighborhoods.

## 1. Purpose

Several top-level AI estates may live on one device without becoming one
organism. A bare Brainstem desktop and an OpenRappter desktop are different
estate containers. Each may contain multiple neighborhoods—its root companion,
worker twins, and specialized herds—while both estates remain independently
visible, attributable, stoppable, and recoverable.

The operating-system app boundary is the user-facing trust boundary:

```text
Brainstem Electron app                    OpenRappter Electron app
one dock creature                         one dock creature
one owned home + userData                 one owned home + userData
one or more neighborhoods                 one or more neighborhoods
        \                                      /
         explicit, attributed POST /chat or verified tile transfer
```

An internal worker twin may itself be a neighborhood inside exactly one estate.
It appears in that estate's Herd or Agent Arena. A neighborhood becomes another
top-level Dock creature only when it is deliberately detached or hatched as a
full independent Electron estate.

Estates form a **bounded recursive tree**. Any estate may hatch a neighborhood
as another full Electron estate when independent lifecycle, resources, or a new
long-lived herd is needed. The child receives a new content-independent RAPPID,
globally unique `neighborhood_id`, Dock creature, home, user data, worker ports,
cloned Python environment, and direct-child registry. The parent retains only
its explicit lifecycle capability. Each estate may own at most 32 detached
child estates and the tree is capped at eight generations so spawning cannot
become an unbounded resource attack.

## 2. Normative contract

### 2.1 Visible identity

Every top-level estate **MUST** have:

- its own Electron process and `user-data-dir`;
- a stable `estate_id` and root `neighborhood_id`;
- a distinct app/window name and OS app-user-model identity;
- its own dock or taskbar creature; sibling OpenRappters use a deterministic
  dock badge;
- an in-app Good AI Estate badge naming the estate and neighborhood count.

The user **MUST** be able to tell which creature owns visible work without
reading ports, process IDs, or logs.

### 2.2 Exclusive ownership

The estate owner **MUST** exclusively own its mutable:

- application home and Electron user data;
- Brainstem home, source/runtime copy, agents, soul, memory, and credentials;
- dynamic loopback worker ports and active route;
- tiles, Herd, Agent Arena, Rappter Surgeon sessions, logs, captures, and
  recordings;
- neighborhood/twin registries and lifecycle capabilities.

Two estates **MUST NOT** share, hardlink, symlink, scan, mutate, stop, or
silently adopt each other's mutable state. Neighborhoods inside one estate may
use estate-owned immutable foundations, but keep their routes, conversations,
identity, and worker lifecycle attributable. Content-addressed immutable source
may be copied at birth; credentials are copied by value into private files.

### 2.3 Herd containment

A global companion may herd any neighborhood or twin in its estate. It **MUST
NOT** discover or control another estate's residents by guessing ports, walking
process tables, reading foreign endpoint metadata, or reusing a PID. Every
neighborhood has exactly one `estate_id`, and only that estate's capability may
stop it.

### 2.4 Peaceful collaboration

Cross-neighborhood work is explicit and attributable:

- ordinary capability travels over the unchanged `POST /chat` wire;
- distributed matrix/race/relay work uses Rappter Pack with both node IDs in
  the persisted report;
- state transfer uses a verified OpenRappter tile and explicit identity rules;
- Pack relay says `neighborhood_protocol: "not-claimed"` unless a separately
  authenticated neighborhood protocol is actually used.

Collaboration **MUST NOT** imply shared memory, shared agents, shared ownership,
or permission to mutate the neighbor.

### 2.5 Resource and failure isolation

- Workers bind loopback on owned dynamic ports.
- A failed, unavailable, or malicious neighbor cannot block a valid race
  winner or corrupt another neighborhood.
- Shutdown uses an instance capability, never an unverified durable PID.
- Updates, imports, and restores operate only inside the owner's canonical
  roots and roll back their own state on failure.

## 3. Runtime identity

### 3.1 Data-defined container

The Electron process is not the durable creature. It is a disposable runtime
projection of `neighborhood.json` plus the neighborhood's RAPPID, agents,
memory, settings, tiles, lineage, and ownership metadata. The manifest declares
`container: "electron-app"` and `durability: "data-defined"`. Starting Electron
materializes those bytes into a Dock creature; stopping Electron leaves the
neighborhood intact. The verified self-tile carries `neighborhood.json`, so the
same container can be backed up, moved, restored, or recursively spawned without
making process identity authoritative.

The public descriptor is:

```json
{
  "schema": "openrappter-good-ai-neighbor/1.0",
  "estate_id": "estate:openrappter:alpha-twin:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "neighborhood_id": "openrappter:alpha-twin:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "parent_neighborhood_id": "openrappter:alpha",
  "generation": 1,
  "instance": "alpha-twin",
  "app_name": "OpenRappter · Alpha Twin",
  "dock_badge": "AT",
  "app_user_model_id": "io.github.kody-w.openrappter.neighborhood.alpha-twin",
  "container": "electron-app",
  "durability": "data-defined",
  "neighborhood_model": "one-estate-many-neighborhoods",
  "ownership": "one-app-one-estate",
  "collaboration": "attributed-post-chat-only"
}
```

Paths and tokens remain private. Endpoint and hatch metadata carry the
`neighborhood_id` so evidence can be attributed without exposing credentials.

## 4. Acceptance gates

A conforming release proves:

1. two top-level estates run concurrently with different app identity,
   homes, user data, routes, ports, RAPPIDs, and identity-agent inodes;
2. each app's visible badge, title, dock/taskbar identity, and driver state name
   the same neighborhood;
3. each estate may list multiple owned neighborhoods, and no foreign residents;
4. direct `/chat` works in both directions without shared mutable state;
5. invalid and unavailable neighbors fail in isolation;
6. cross-neighborhood relay/report evidence names both participants;
7. a stale PID cannot stop any process without the owned instance capability.

The design is successful when multiple AI estate containers live and work side
by side on one device, each holds as many attributable neighborhoods as needed,
and they help each other deliberately without negatively impacting or confusing
each other.

For public-data invocation, see
[`DOGG-SUMMON-PROTOCOL.md`](DOGG-SUMMON-PROTOCOL.md). DOGG summons create
resident neighborhoods inside the local estate; only explicit detach/hatch
creates another Electron estate.
