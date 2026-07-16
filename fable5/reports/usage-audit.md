# Usage Audit — Claude Code (Fable 5 use case #2)

> Generated 2026-07-16. Analysis of your Claude Code session history to surface what's working, what's leaking leverage, and what should become reusable skills or automations.

## Summary

Audit of six non empty Claude Code sessions. The digest path arrived as undefined, so I rebuilt it from the projects transcripts. Four workloads. One, an always on iMessage group chat persona bot in a single 270 MB session with 33403 tool calls, of which 33212 are chat_messages reads and only 77 are reply calls, driven by an every minute cron plus CronList and CronCreate. Two, three near identical final independent Fable 5 release reviewer sessions for iRappter rc14 twice and rc15, read only, adversarial, roughly 1500 character hand typed prompts. Three, an init CLAUDE dot md generation session in the rapp vscode extension. Four, this video to prompts session using yt dlp subtitle extraction, WebSearch deep research, and worktree plus Workflow orchestration. The user is a strong power user but repeatedly retypes elaborate one off prompts instead of capturing them as skills, and runs a very expensive poll heavy iMessage bot at a 431 to 1 read to reply ratio. Biggest wins are turning the repeated reviewer prompt and the video to prompts pipeline into skills, abstracting the bot persona and cron into a reusable setup, and moving the every minute polling to event driven triggering.

## What you're doing well

- Sophisticated orchestration. The user drives git worktrees, the Workflow tool to fan out multi stage jobs such as usage audit plus code review plus agentic OS design in one script, Agent subagents, and StructuredOutput for machine readable results.
- Strong safety discipline in reviews. Every Fable 5 reviewer prompt enforces read only, no network, and trace claims to code, with adversarial framing across unauthorized triggering, replay and crash gaps, cost and model storms, and races, plus exact evidence count verification.
- Correct tool selection. yt dlp with android web_safari and ios player_client fallbacks for subtitle extraction, WebSearch for grounding, and json3 or vtt caption dedup. The video to prompts pipeline ran end to end.
- Real production automation. A live cron driven iMessage assistant that reads group context, honors mention rules, reads the room, and stays silent when nothing warrants a reply, plus proper imessage configure and access setup and allowlisting.
- Good harness permission hygiene. A scoped settings dot local dot json allowlist covering sqlite3, git subcommands, gh api and pr, and the two imessage MCP tools reduces prompt friction without blanket allowing everything.

## What's leaving leverage on the table

- Massive prompt duplication. The roughly 1500 character Fable 5 reviewer prompt was hand retyped across three sessions, rc14 twice and rc15, with only version and claim details changing, and no skill or slash command captures it.
- Expensive iMessage polling. 33212 chat_messages reads produced only 77 replies, a 431 to 1 ratio, on an every minute cron. Most runs read, find nothing, and exit, burning a full agent invocation per minute around the clock. It should be event driven or gated on a cheap change check.
- Ad hoc cron and persona config. Four nearly identical CronCreate payloads re embed the same persona rules such as never answer for rappter1 and respond to the mention aliases and read the room. There is no reusable persona abstraction, so the specs drift between copies.
- Zero project level skills or hooks despite obvious recurring patterns like release review, video to prompts, and parity check. The video prompt even asked to store final drafts in a notes app and execute each prompt one by one, with nothing wired to do so.
- Improvised deliverable persistence. Outputs land in ad hoc worktree files under fable5 reports and fable5 transcripts instead of a durable queryable notes or reports location, so findings do not accumulate.
- Manual parity work. The documented TypeScript to Python mirror invariant is verified by hand rather than via a repeatable skill or CI gate, and the active feat frontier memory branch touches many python agent files.

## Candidate skills

Recurring tasks worth turning into reusable Claude Code skills. Generated skills live in [`.claude/skills/`](../../.claude/skills).

| Skill | Trigger | Why |
|-------|---------|-----|
| **Release Reviewer** (`.claude/skills/release-reviewer`) | User asks to act as the final independent reviewer, review the diff read only, or gate a release candidate in the rc14 or rc15 style before shipping. | The same roughly 1500 character prompt was hand typed across three sessions, iRappter rc14 twice and rc15. Only version and claims changed while the read only rules, adversarial checklist, and structured verdict contract were identical. |
| **Video to Prompts** (`.claude/skills/video-to-prompts`) | User pastes a YouTube, Shorts, or other video link and asks to transcribe it and turn the speaker suggestions into runnable prompts or a research and action plan. | This session executed exactly that pipeline with yt dlp subtitle fallbacks, caption cleanup, WebSearch grounding, and Workflow fan out. Capturing it makes video to optimized prompts to store to execute a single command. |
| **iMessage Persona Bot** (`.claude/skills/imessage-persona-bot`) | User wants Claude to participate as themselves in an iMessage or group chat, or to set up or adjust an always on chat responder persona. | The user created four nearly identical CronCreate payloads each re embedding the same persona rules. A persona spec skill de duplicates this and stops copies from drifting. |
| **TS Python Parity Check** (`.claude/skills/ts-python-parity-check`) | User edits an agent module in one language, or asks whether the Python side matches, to keep parity, or to check TypeScript to Python parity before merging. | CLAUDE dot md makes TypeScript to Python parity a core invariant with an explicit file pair mapping and parity test dirs, yet the current branch touches many python agent files with no repeatable parity gate. |
| **CLAUDE md Generator** (`.claude/skills/claude-md-generator`) | User runs init in a new repo, asks to create a CLAUDE dot md, or wants existing project instructions refreshed after architecture changes. | One session was an init CLAUDE dot md run in the rapp vscode extension and the user maintains an unusually rich CLAUDE dot md in OpenRappter. A skill encodes that preferred structure so every repo gets a consistent useful file. |

## Candidate automations

Things that should run on cron / CI / hooks rather than by hand. Stubs in [`../automations/`](../automations).

| Automation | Trigger | Mechanism | Why |
|-----------|---------|-----------|-----|
| **Event driven iMessage responder** | A new allowlisted iMessage arrives in the configured chat via a hook or event, instead of a fixed every minute schedule. | A Claude Code hook or a lightweight chat database watcher that invokes the persona bot only on new message events, keeping a fallback low frequency cron for liveness. | 33212 chat_messages reads yielded just 77 replies, a 431 to 1 ratio. Nearly every minute run is wasted work, and event driving it removes most empty invocations while improving responsiveness. |
| **Pre release review gate CI** | A PR labeled release candidate is opened or updated, or a tag matching an rc pattern is pushed. | A GitHub Actions workflow invoking the release reviewer skill read only and gating merge on its structured verdict. | The user already performs this review manually and repeatedly per RC, rc14 twice and rc15. CI makes it consistent, un skippable, and removes the manual retype and run loop. |
| **TS Python parity CI check** | A PR modifies files under the TypeScript agents directory or the python agents directory that are mirrored pairs. | A GitHub Actions matrix running vitest parity tests and pytest parity tests plus the parity check diff, gating merge. | Parity is a documented core invariant currently trusted to manual diligence, and the active feat frontier memory branch edits many python agent files with no automated cross language guard. |
| **Deliverable and notes persistence hook** | A skill or workflow finishes producing report, transcript, or prompt artifacts, for example video to prompts or release reviewer output. | A post run hook that writes structured artifacts to a fixed notes or reports location, optionally a notes app integration, with a searchable index. | The video prompt explicitly asked to store the final drafts in a notes app, but with no standing integration the outputs landed in improvised worktree paths under fable5 reports and fable5 transcripts and do not build up anywhere reusable. |
