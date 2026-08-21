# RAPP Brainstem Frontier Golden Path

## North star

RAPP Brainstem is a useful educational engine that teaches by doing.

### Ethos: We are above that

**We are above that.** Brainstem sits above model choice, AI harnesses,
prompting mechanics, and tool plumbing. It absorbs those implementation
concerns into one outcome-driven control surface so people can describe what
they need, watch the work happen, and get the result without becoming experts
in the layers underneath.

The story is simple:

> RAPP helps accelerate not only learning AI, but teaching AI yourself right
> after you learn it—creating skills that can follow you for the rest of your
> life.

The user should be able to describe an outcome in chat, watch GitHub Copilot
build or select the needed capability, see the Brainstem execute it, inspect the
agent files and tool calls, and carry the proven solution into the appropriate
Microsoft platform downstream.

The user does not need VS Code, a terminal, or prior agent-development
experience. Those remain optional expert surfaces.

## The one-screen experience

```text
┌────────────────────┬──────────────────────────┬──────────────────────┐
│ Live Explorer      │ RAPP Brainstem           │ GitHub Copilot       │
│                    │                          │ Brain Surgeon        │
│ global agents      │ the actual /chat surface │ full coding-agent    │
│ routed stacks      │ visible agent execution  │ loop                 │
│ source preview     │ user memory and results  │ files/shell/tests    │
└────────────────────┴──────────────────────────┴──────────────────────┘
```

### Left: Live Explorer

- Shows the exact agent files in the active routed composition.
- Separates shared/global capabilities from stack-specific capabilities.
- Lets the user inspect source without requiring an editor.
- Updates when Copilot installs, removes, or changes a routed agent.

### Center: Brainstem chat

- Remains the one RAPP/1 execution surface.
- Uses the unchanged Grail Brainstem kernel.
- Receives the same `{user_input, session_id?, conversation_history?}` shape.
- Hotloads ordinary `*_agent.py` files from its configured `AGENTS_PATH`.
- Shows agent calls, results, memory behavior, and the proof conversation.

### Right: GitHub Copilot Brain Surgeon

- Runs the full bundled GitHub Copilot coding-agent loop.
- Can inspect files, run shell commands, edit, test, and iterate.
- Can create a scoped or one-turn agent and route it into Brainstem.
- Can visibly type, click, wait, clear, refresh, screenshot, and record.
- Teaches by briefly narrating what it is doing and why.

## Chat is the control surface

The user drives the product through conversation:

```text
"Build an agent that validates these invoices."
"Teach me how you are testing it."
"Use that capability only for this chat."
"Keep this as the default stack for this role."
"Record a demo I can show later."
"Launch this proven Brainstem in Hippocampus."
```

The system performs the work and keeps the evidence visible.

External AIs can enter the same on-screen loop:

```bash
brainstem-surgeon "Build and test the agent I need"
brainstem-chat "Run the proven workflow"
brainstem-walkthrough
```

These commands do not bypass the UI. They visibly type into the same chats the
person sees.

## Agent-first control: the interface is drivable without the model

Chat is the control surface for **intelligence**. It is not the control surface for **navigation**,
and treating it as one makes every button press cost a model call.

So the Frontier's interface is drivable through the **RAPP command-line-less CLI** — a CLI interface
with no command line, injected into the page and reached from the console: `rapp("herd.open")`,
`rapp("tile.primary tile-7")`. Specified in [`docs/AUTOPILOT-CLI.md`](docs/AUTOPILOT-CLI.md)
(`rapp-autopilot/1.0`). The invariants:

1. **Two prerequisites, nothing else.** An AI needs to know CLI patterns and be able to reach the
   console on the page. No SDK, no client library, no account, no service to register with, and no
   credential at all from inside the page. Reaching the driver bus from outside it uses the
   install's own loopback token, which is generated locally and never leaves the machine. Anything that required something specific to us would exclude whatever AI lacks it.
2. **Any AI, not one AI.** The surface describes itself (`rapp("help")` returns every verb, its
   arguments and whether it costs a model call), so a driver learns it at runtime. Nothing in it
   encodes which model is on the other end.
3. **One command costs money.** Navigation, listing, moving tiles, reading the transcript are free
   and deterministic. `chat.send` is the single crossing into the model, so spending intelligence is
   a decision rather than a side effect of clicking.
4. **It drives the visible interface, and stays visible.** This is not hidden automation and must
   never become it: the CLI operates the same controls a person uses — a move is performed as a real
   drag through the real drop handler, at a speed a person can follow — the window shows the work as
   it happens, and every command is logged to the console and recorded in the driver trace. What it
   does not do is narrate itself into the chat: deterministic driving never reaches the model, so
   writing its steps into the transcript would record a conversation that never happened. The
   companion chat holds conversation; an optional activity view holds driving. The
   teach-by-doing loop is not merely preserved, it is what this is for: an AI demonstrating the
   product while someone watches.
5. **Two can drive at once, and the person wins.** An AI working in the window never captures focus
   or the pointer, never blocks the person's input, and yields any contested object to them — both
   are live at the same time, each with a visible cursor, every change attributed to whoever made it.
   This is collaboration in one window, not a machine operating the product on someone's behalf.
6. **The client is the extension point, never the kernel.** The command surface lives in
   `index.html`, composed from what the Brainstem already exposes — so it is a CLI and an API at
   once, and a deployment that needs a different one ships a different client rather than a modified
   kernel. Adding a command must never require a commit to `rapp_brainstem/`; the Grail's own
   `index.html` is superseded, like a rapplication supersedes it, not edited.
7. **It never becomes a ceiling.** Anything without a named verb is still reachable through the raw
   driver actions, so the naming layer can never make the product less operable than the UI itself.

This is what makes the Frontier an agent-first product rather than a product with an AI in it: the
fastest path for a person is the visible interface, and the fastest path for an AI is the same
interface, driven the same way, with the model reserved for the part only a model can do.

## Autonomous five-minute walkthrough

`brainstem-walkthrough` is the release demonstration of the golden path. An
external AI enters the visible Brain Surgeon chat and guides Copilot through six
chapters:

1. orient the learner to caller RAPPID, UUID memory, stacks, overlays, and the
   active composition;
2. open the live Explorer and begin recording;
3. hotload a one-turn teaching agent through the center Brainstem `/chat`;
4. prove the result, source visibility, and automatic ephemeral cleanup;
5. check the GitHub update state and explain the local-to-Microsoft promotion
   path;
6. stop recording and hand back the reusable lesson plus saved evidence.

The command verifies both chat layers: the Brain Surgeon must complete its
guided tool loop, and the center Brainstem transcript must contain
`LEARNED_AND_TAUGHT:RAPP_READY`. It also verifies that the one-turn agent is no
longer present and that a new WebM was saved. The recording is full-decoded,
sampled at five timestamps, and published into the local walkthrough gallery at
`~/.brainstem/beta-launcher/walkthroughs/index.html`; failed passes remain in the
gallery as visible evidence of what changed between iterations.

## One-click Copilot Studio promotion

The Brain Surgeon start surface includes **Deploy loaded agents to Copilot
Studio**. That pill completes the local-to-production story without sending the
user to VS Code or a terminal:

1. verify or inject the Frontier-only `RappCopilotStudioFactory` and
   `CopilotStudioDeploy` agent.py capabilities;
2. enumerate the business and industry agents currently loaded in the active
   Brainstem composition;
3. ask the user which agents to combine, the Copilot Studio display name,
   publisher prefix, and target Power Platform environment;
4. show existing PAC user profiles or start an interactive device-code login
   for the chosen environment;
5. materialize the packaged parity cases outside `app.asar`, then drive Factory
   and Parity Deploy through doctor, plan, build, provision, push, parity, and
   finalize;
6. show the exact environment, AgentId, Draft parity evidence, and clickable
   Copilot Studio link;
7. keep the Frontier automation Draft-only; live publication is a separate manual
   user action in the linked Copilot Studio UI;
8. use the real authenticated browser to run the same test cases against the
   exact Draft Preview and the source agent.py tools in Brainstem, preserving
   screenshots, recordings, responses, and a functional-parity verdict.

Authentication remains user-owned. Frontier may display PAC device-login
instructions and poll completion, but it never captures credentials or returns
client secrets. `local.settings.json` may provide non-secret environment,
tenant, client ID, and naming defaults; secret values are only reported as
present and are never copied into chat, source, logs, or checkpoints.

The deployment engine remains the existing agent.py pipeline. The Frontier pill is
only the visible conversational entry point and safety/control loop around it.

Generic conversion is evaluated against the Frontier-owned industry matrix at
`beta/resources/copilot-studio/industry-agent-matrix.json`. The matrix covers
read-only network tools, deterministic content, workflow orchestration,
business scoring, stateful operations, memory, and complex reporting. Every
case must pass doctor, static plan, and dry-run build; representative cases must
also complete Draft push, parity, and finalize before the one-click story is
considered generic.

The Hacker News plus memory preset binds its trusted Draft parity run to
`beta/resources/copilot-studio/hacker-news-memory-parity-cases.json`. These cases
execute both the frozen local agent snapshot and the exact Draft in Edge
Preview, inject per-run challenges, compare normalized outputs, and mutation
test the gate.

## The unstuck handoff

The user never has to abandon Frontier because they do not know the next
technical step.

They can ask an external AI to take over:

```text
"Drive the Brain Surgeon for me."
"Fix this agent while I watch."
"Run the next test."
"Show me why this failed."
```

The AI enters the same visible chat, performs the work in the application,
shows cursor movement, files, tools, logs, screenshots, and results, then hands
control back. The person keeps context and learns from the recovery instead of
being sent to a separate developer tool.

This visible human/AI control handoff is a defining RAPP Frontier capability.

## Native agent hotloading

The Grail mechanism is the mechanism of record:

1. A runtime has one flat `AGENTS_PATH`.
2. `brainstem.py` globs `*_agent.py` on every request.
3. Each file is dynamically loaded and converted into an LLM tool.
4. No kernel routing endpoint or alternate loader is added.

Frontier composes an isolated worker directory from:

```text
shared global agents
+ inherited stack agents
+ leaf-stack agents
+ ordered overlays
+ optional one-turn agents
```

Agent bytes are cached once by content address. Worker directories use
hardlinks when supported, so global agents are not recopied for every route.

Drag/drop and Copilot-authored files still look like normal agent files to the
unchanged Brainstem.

## Teaching loop

Every useful demonstration follows the same observable loop:

1. **Frame** — Copilot restates the intended outcome and success evidence.
2. **Explore** — inspect the current Brainstem, agents, files, and constraints.
3. **Build or route** — create the smallest agent or select an existing stack.
4. **Hotload** — compose it into an isolated `AGENTS_PATH`.
5. **Chat** — run the behavior through the real Brainstem `/chat`.
6. **Observe** — show cursor motion, tool calls, logs, and visible results.
7. **Correct** — let Copilot repair and rerun failures.
8. **Capture** — attach a screenshot or recorded WebM demo.
9. **Explain** — summarize what worked and what the user just learned.
10. **Promote** — package the proven organism for the right downstream target.

## RAPP/1 constitutional boundary

Frontier may orchestrate around the kernel, but it does not fork the kernel.

- One Grail `brainstem.py`.
- One RAPP/1 `/chat` wire.
- One single-file agent contract.
- Identity is RAPPID.
- Events are RAPP/1 frames.
- Portable artifacts are RAPP/1 eggs.
- New capabilities are agents or orchestration, not competing APIs.

Frontier and Hippocampus must pass the same conformance vectors and produce
byte-identical identities, hashes, frames, and eggs.

## Identity, stacks, and useful specialization

A caller has a canonical RAPPID and a private UUID memory anchor.

A caller may own a tree of stack RAPPIDs:

```text
sales
├── enterprise
│   └── regulated
└── smb
```

A selected leaf inherits its parents and may add ordered overlays. All stacks
for one caller share that caller's memory, while agent-stack storage remains a
separate domain.

This lets one Brainstem teach and perform different roles without leaking tools
between concurrent chats.

## Clone, diverge, and reassimilate

When the user says to launch the local Brainstem in Hippocampus:

1. Freeze the exact idle local organism snapshot.
2. Package runtime, agents, stacks, memory, session, soul, and model profile.
3. Mint a unique child RAPPID and UUID memory anchor in Hippocampus.
4. Record the local RAPPID as parent with a verified constructor pin.
5. Start the cloud clone from the exact snapshot.
6. Continue the same visible session without changing the chat envelope.

The local parent and cloud child may mutate independently.

If related twins meet later, they verify their multi-generation RAPPID lineage,
find the lowest common ancestor, exchange content-addressed frames and eggs,
and reassimilate through chat. They preserve their distinct identities and
histories. A real same-stream fork fails closed and requires owner-authorized
RAPP/1 re-genesis.

This is how twins can trust relatives encountered in the wild.

## Microsoft downstream path

Local Frontier is the teaching and proof environment. Once the behavior is
proven, the same RAPP/1 artifacts can move into:

- **Hippocampus / Azure Functions** — durable cloud execution and memory.
- **Microsoft Copilot Studio** — governed agents, connectors, and M365 reach.
- **Microsoft Foundry** — managed model/runtime operations and enterprise scale.
- **Microsoft 365 Copilot and Teams** — end-user distribution.
- **Scout / Work IQ experiences** — when the use case fits knowledge and
  employee workflows.
- **Custom Azure applications** — when the experience requires custom product
  code.

Promotion changes the host and governance level, not the agent's intent or chat
contract.

## Why AIBAST

AIBAST is the tip of the spear in the customer's AI journey. The team is
present from the first meeting and first use case, helps turn ambiguity into
working evidence, teaches the customer through the visible RAPP loop, and stays
with the solution until it reaches the right production destination.

That end-to-end accountability is why Frontier must connect learning, proof,
architecture choice, governance, and downstream promotion in one coherent
path.

## Product promise

The user never has to leave the product to get work done: everything that needs intelligence is asked for in chat, and everything else is a thing they pick up and put down.

They can watch the system do their work, understand how it did it, inspect the
capabilities it used, replay the demonstration, and promote the proven solution
without first becoming a software engineer.

That visible teach-by-doing loop is the RAPP Brainstem Frontier golden path.
