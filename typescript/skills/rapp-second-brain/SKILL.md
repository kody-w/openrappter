---
name: rapp-second-brain
description: The owner's real-world memory and records — contacts, phone-call transcripts, appointments, human approvals, leads, quotes and invoices. Use before acting on the owner's behalf, and after anything is agreed. Local-first, zero dependencies.
homepage: https://github.com/kody-w/rapp-secondbrain
metadata: {"openclaw":{"emoji":"🧠","requires":{"bins":["rsb"]},"install":[{"id":"curl","kind":"shell","command":"curl -fsSL https://raw.githubusercontent.com/kody-w/rapp-secondbrain/main/install.sh | bash","bins":["rsb"],"label":"Install RAPP Second Brain"}]}}
---

# RAPP Second Brain

`rsb` is the owner's second brain on their own disk. Every mutation is an event in a
hash-chained append-only log, so anything you believe can be traced to the event that
caused it — and any edit to history is detectable with `rsb verify`.

**Every command accepts `--json`. Use it.** Human output is for the owner, not for you.

## The rule that matters

> Read the brain **before** you act on the owner's behalf.
> Write to the brain **after** anything is said, agreed, or promised.
> Never commit the owner to something outside their stated preferences without
> `rsb approval request` — and never treat a pending approval as a yes.

## Start every session

```bash
rsb --json brief      # upcoming, pending approvals, open leads, unpaid invoices, recent calls
rsb --json context    # the same thing as a compact system-prompt block
```

## Remember and recall

```bash
rsb remember "Kody is allergic to shellfish" --tag health
rsb --json recall "shellfish"          # searches contacts, notes, transcripts, leads, invoices
rsb --json note list --tag health
```

`recall` exits non-zero when nothing matches — check it before claiming you know something.

## Contacts

```bash
rsb contact add --name "Mike's Garage" --phone "(555) 999-8888" --org "Auto repair"
rsb --json contact find "mike"         # by name, phone in any format, or id
rsb --json contact list
```

Phone numbers are normalised, so `(555) 999-8888`, `5559998888` and `+15559998888`
are the same contact — adding again updates instead of duplicating.

## Phone calls

Log the call as it happens so the transcript survives the session.

```bash
CALL=$(rsb --json call start \
  --to "Mike's Garage" \
  --objective "Book a brake inspection Thursday morning" \
  --constraint "must be before 11am" \
  --constraint "budget under 400" | jq -r .call.id)

rsb call turn --call "$CALL" --role agent --text "Hi, do you have anything Thursday morning?"
rsb call turn --call "$CALL" --role peer  --text "Thursday's full. I could do Friday at 9."

rsb call end --call "$CALL" --outcome counter_offer --summary "Thursday unavailable; Friday 9am offered"
# add --success when the objective was actually met
```

Roles: `agent` (you), `peer` (the other party), `owner` (the person you work for), `system`.

```bash
rsb --json call show "$CALL"    # full transcript
rsb --json call list --limit 10
```

## Appointments — propose, then confirm

This two-step is deliberate. **Proposing is not booking.**

```bash
APPT=$(rsb --json appointment propose \
  --title "Brake inspection" --with "Mike's Garage" \
  --start "friday 9am" --call "$CALL" | jq -r .appointment.id)

rsb appointment confirm "$APPT" --external-id "gcal_abc123"   # only after approval
rsb appointment cancel  "$APPT" --reason "owner declined"
rsb --json appointment list --status confirmed
```

Times accept ISO (`2026-08-07T19:45`), `friday 9am`, `tomorrow 19:30`, `tonight 8`, `+2h`.
Anything it cannot parse is an error, never a guess.

## Approvals — the human in the loop

```bash
APR=$(rsb --json approval request \
  --subject "Bella Vista offered 7:45pm instead of 7pm" \
  --detail "Shall I take it?" --ref "$APPT" | jq -r .approval.id)

rsb --json approval list --pending
rsb approval check "$APR"       # exit 0 = approved, exit 1 = not approved
rsb approval approve "$APR" --via phone
rsb approval deny    "$APR" --note "too late"
```

`approval check` is the gate. Branch on its **exit code**, not on prose.

## Leads, quotes, invoices

```bash
LEAD=$(rsb --json lead add --name "Riverside Cafe" --phone 5552223333 \
  --source "telegram voice note" --need "Weekly deep clean" --value 1200.00 | jq -r .lead.id)

rsb quote create --lead "$LEAD" --item "Deep clean x4 @ 300.00" --tax 8.25 \
  --valid-until "+14d" --render html
rsb quote status <quote-id> accepted
rsb lead status "$LEAD" won

rsb invoice create --lead "$LEAD" --item "Deep clean x4 @ 300.00" --due "+30d" --render html
rsb --json invoice list --unpaid
rsb invoice pay <invoice-id> --via card
```

`--item` format is `Description x2 @ 150.00` (the `x2` is optional). Money is stored as
integer cents — never do arithmetic on the formatted strings.

`--render html` writes a print-ready document to `~/.rapp-second-brain/artifacts/`
(open it and Print → Save as PDF). `--render md` writes Markdown, which is what you
paste into Google Docs when you need an editable version.

## Preferences — the owner's standing orders

```bash
rsb pref set preferred_dinner_time "19:00"
rsb pref set never_book_before "09:00"
rsb --json pref list
```

Preferences appear in `rsb context`. Respect them; when a negotiation would break one,
that is exactly when to request an approval.

## Integrity

```bash
rsb verify     # exit 0 = chain intact, exit 2 = history was edited
rsb doctor
rsb --json log --limit 20 --type call.end
rsb export -o backup.json --include-log
```

## Machine surfaces

```bash
rsb mcp                                  # MCP server over stdio
rsb serve --port 7431 --token "$TOKEN"   # HTTP: GET /brief /state /health, POST /event /remember
```

## Notes

- The brain lives at `$RAPP_SECOND_BRAIN_HOME` (default `~/.rapp-second-brain/`).
- Nothing is ever deleted — status changes are new events. That is the point.
- No API keys, no network, no dependencies beyond the Python standard library.

## Running inside a RAPP brainstem

If you are a brainstem agent rather than a shell, you do not need `rsb` at all:
`agents/second_brain_agent.py` is the same brain, same log, same spec, reachable as
the `SecondBrain` tool.

```
SecondBrain(action="brief")
SecondBrain(action="recall", query="bella vista")
SecondBrain(action="remember", text="Kody is allergic to shellfish")
SecondBrain(action="propose_appointment", title="Dinner", start="2026-08-07T19:45")
SecondBrain(action="request_approval", title="7:45 instead of 7:00?", query="<appointment id>")
SecondBrain(action="confirm_appointment", query="<appointment id>")
```

`confirm_appointment` **refuses** while any approval referencing that appointment is
still pending or denied. The gate is in the agent, not in the prompt — so it holds
even when the model is convinced it should not.
