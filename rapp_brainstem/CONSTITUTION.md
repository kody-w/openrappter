# RAPP Brainstem — Constitution

> *The principles that govern this project. Read this before you contribute.*

---

## What This Is

RAPP Brainstem is a **business-focused AI agent platform** that teaches
the Microsoft AI stack through progressive tiers. It is an engine —
not a consumer product, not a toy, not a creature.

It exists to help developers, teams, and organizations build AI agents
that start local and scale to Azure and M365 Copilot Studio.

---

## Article I — The Engine, Not the Experience

RAPP Brainstem is infrastructure. It is the Flask server, the LLM loop,
the agent discovery, the auth chain, and the deployment templates.

It does not have a personality out of the box beyond what the user puts
in their soul file. It does not have a brand identity beyond "RAPP
Brainstem." It does not anthropomorphize itself.

Consumer-facing experiences (creatures, organisms, educational platforms,
children's content) are **separate intellectual property** and belong in
their own repositories. They may use the brainstem as their engine, but
they do not live here.

---

## Article II — Three Tiers, One Path

The platform teaches the Microsoft AI stack one layer at a time:

| Tier | Name | What It Is | What You Learn |
|------|------|-----------|----------------|
| 1 | **Brainstem** | Local Flask server + GitHub Copilot | Python agents, function-calling, prompt engineering |
| 2 | **Spinal Cord** | Azure deployment (ARM template) | Azure Functions, Azure OpenAI, managed identity, RBAC |
| 3 | **Nervous System** | Copilot Studio + M365 | Power Platform, declarative agents, Teams integration |

Each tier is self-contained and complete. Users advance when they choose
to, not when we push them.

### Learn, Teach, Keep

RAPP accelerates both sides of durable AI literacy:

1. **Learn AI by using it on real work.**
2. **Teach AI immediately after learning** by turning the new understanding
   into a visible, testable single-file capability.
3. **Keep the skill for life** as a portable RAPP agent, frame history, and egg
   that can follow the user across machines and tiers.

The platform SHOULD teach by doing. It shows the plan, visible actions, agent
source, tool calls, evidence, and result. A nontechnical user must be able to
drive this loop through chat alone.

Local learning is not a dead-end prototype. Once proven, the same RAPP/1
organism can be cloned into Hippocampus and promoted into the appropriate
Microsoft downstream experience—Copilot Studio, Microsoft Foundry, Microsoft
365 Copilot, Teams, Scout/Work IQ, or a custom Azure application—without
rewriting the skill or changing the chat contract.

The beta's product path is documented in
[`beta/GOLDEN_PATH.md`](../beta/GOLDEN_PATH.md). The beta may enrich the
experience around the Brainstem, but it cannot replace or fork the kernel.

---

## Article III — Local First

The brainstem runs on the user's machine. Core chat requires no cloud account
or provider API key beyond a GitHub account with Copilot access. Optional
integrations may use credentials supplied and controlled by the user.

Azure and Copilot Studio are deployment targets, not prerequisites. A
brainstem that never leaves localhost is fully functional.

All local data (memories, config, agents) stays on the user's device
unless they explicitly deploy to a higher tier.

---

## Article IV — One File, One Agent

Agents are single `*_agent.py` files that extend `BasicAgent` and
implement `perform()`. That's the entire contract.

- No config files. No YAML. No dependency manifests.
- Auto-discovered on every request. No registration step or restart.
- The LLM decides when to call them based on the metadata description.
- Portable: copy the file, the skill travels with it.

Complexity belongs inside the agent's `perform()` method, not in the
framework around it. The surface area stays small so anyone can read,
write, and share agents.

---

## Article V — Don't Break the One-Liner

The install experience is sacred:

```bash
curl -fsSL https://microsoft.github.io/aibast-agents-library/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/microsoft/aibast-agents-library/main/install.ps1 | iex
```

One command. Works on a fresh machine. Installs prerequisites, clones
the repo, sets up the venv, authenticates, and launches.

The same principle applies to every tier:

- **Brainstem:** `curl ... install.sh | bash` — installs and starts
- **Hippocampus:** `curl ... community_rapp/install.sh | bash` — installs and starts

The one-liner IS the onboarding. Everything after it — starting,
authenticating, deploying to Azure — either happens automatically
or is guided by the running system. Manual steps exist only as
advanced documentation, never as the primary path.

When training users, the instruction is: "run the one-liner." That's it.
Any change to the repo must be tested against this path. If the
one-liner breaks, nothing else matters.

---

## Article VI — Scope Discipline

This repository contains:

- ✅ The brainstem server (`brainstem.py`)
- ✅ The default soul file (`soul.md`)
- ✅ The local storage shim (`local_storage.py`)
- ✅ Built-in agents (`agents/`)
- ✅ Azure deployment (`azuredeploy.json`, `deploy.sh`)
- ✅ Power Platform solution (`.zip`)
- ✅ Install scripts (`install.sh`, `install.ps1`, `install.cmd`)
- ✅ Landing page (`index.html`, `docs/`)

This repository does **not** contain:

- ❌ Consumer brand identities (creatures, mascots, organisms)
- ❌ Educational platforms (academies, courses, children's content)
- ❌ Background daemons or heartbeat loops
- ❌ Features that require processes beyond the Flask server
- ❌ Content belonging to other intellectual properties (e.g., openrappter)

When in doubt: if it's not the engine or its deployment path, it
belongs somewhere else.

---

## Article VII — The User Owns Their Instance

- The soul file is theirs to edit. We provide a default, not a mandate.
- The agents directory is theirs to fill. We provide examples, not a locked set.
- The `.env` file is theirs to configure. We provide defaults, not requirements.
- The code is readable because they should understand what's running on their machine.

We never phone home, collect telemetry, or require accounts beyond
GitHub. The user's brainstem is their brainstem.

---

## Article VIII — Universal Platform Gateway

The `rapp-installer` repo is the **single entry point** for the entire RAPP platform. Users start where they want — not where we tell them to.

### Two One-Liners, One Platform

| Path | What It Creates | One-Liner |
|------|----------------|-----------|
| **Brainstem** (Tier 1) | Local Flask AI server at `~/.brainstem/` | `curl -fsSL .../install.sh \| bash` |
| **Hippocampus** (Tier 2) | Azure Functions project at `~/rapp-projects/{name}/` | `curl -fsSL .../community_rapp/install.sh \| bash` |

Both paths are self-contained. Neither depends on the other. A user who starts with the Hippocampus never needs the Brainstem, and vice versa.

### Rules

1. **The brainstem installer stays untouched.** `install.sh` and `install.ps1` at the repo root are the brainstem's sacred one-liners. The Hippocampus installer lives in `community_rapp/` — a parallel path, not a modification of the existing one.

2. **No cross-contamination.** The brainstem install never pulls CommunityRAPP code. The Hippocampus install never pulls brainstem code. They share a repo for discoverability, not for dependency.

3. **Users choose their entry point.** The README and landing page present both paths equally. We never push users from one tier to another — they move when they're ready.

4. **Each path works on a fresh machine.** Prerequisites (Python, Git, Azure Functions Core Tools) are auto-installed. No prior setup assumed.

5. **The Hippocampus is public.** CommunityRAPP is an open-source repo. The Hippocampus installer uses `git clone` (not `gh clone`). No GitHub authentication is required to create a project.

---

## Article IX — One Grail Kernel, One RAPP/1 Wire

The Brainstem kernel is the RAPP/1 execution shape. Local, beta, Hippocampus,
and future tiers MUST interoperate through the same wire:

```text
POST /chat
{ user_input, session_id?, conversation_history? }

{ response, agent_logs, session_id }
```

### Constitutional rules

1. **Do not add routing fields to the chat envelope.** Identity, deployment,
   stack selection, and tier placement are resolved outside the JSON body.
2. **Do not invent management APIs in the kernel.** New behavior enters as an
   agent, a RAPP/1 frame/egg, or orchestration around an unchanged Brainstem.
3. **Hotloading remains file-native.** A runtime discovers ordinary
   `*_agent.py` files from its configured `AGENTS_PATH` on every request.
4. **Compositions are additive.** A tier may combine global agents with routed
   agents by materializing one flat `AGENTS_PATH`; it MUST NOT fork the loader.
5. **Tiers move the organism, not the contract.** A local organism can be
   snapshotted, cloned into Hippocampus, diverge on lawful instance streams,
   and reassimilate by RAPP/1 evidence without changing agent source or wire.
6. **Protocol extensions use RAPP/1 primitives.** Identity is RAPPID; events are
   frames; portable artifacts are eggs. A second competing envelope is drift.

Any change to `brainstem.py` that creates a beta-only or tier-only protocol path
violates this constitution.

The beta implementation MUST keep its teaching, Explorer, Copilot, recording,
routing, and deployment controls outside the Grail kernel.

---

## Article X — Amendments

This constitution can be amended. The only rule: the change must serve
the platform's purpose as a business-focused AI agent engine. If it
blurs the line between engine and experience, it doesn't belong here.

---

*Ratified for RAPP Brainstem. The engine that powers what others build.*
