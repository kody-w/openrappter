#!/bin/sh
# OpenRappter needs hook for Claude Code (PermissionRequest, Notification, Stop).
# Drops a card in ~/.openrappter/needs/ and, for a permission request, waits up to 55 s for the
# answer from the notch. No answer: the card is withdrawn and Claude Code asks in the terminal as usual.
NEEDS="$HOME/.openrappter/needs"; mkdir -p "$NEEDS"
INPUT=$(cat)
exec python3 - "$NEEDS" <<'PY' "$INPUT"
import json, os, sys, time
needs, raw = sys.argv[1], sys.argv[2]
try: ev = json.loads(raw)
except Exception: sys.exit(0)
kind = ev.get("hook_event_name", "")
sid = (ev.get("session_id") or "s")[:8]
cwd = os.path.basename(ev.get("cwd") or "") or "a project"
now = time.time()
def drop(card):
    p = os.path.join(needs, card["id"] + ".json"); tmp = p + ".tmp"
    with open(tmp, "w") as f: json.dump(card, f)
    os.replace(tmp, p); return p
if kind == "PermissionRequest":
    tool = ev.get("tool_name", "a tool"); ti = ev.get("tool_input") or {}
    ctx = ti.get("command") or ti.get("description") or ti.get("file_path") or json.dumps(ti)[:160]
    cid = f"cc-{sid}-{int(now*1000)}"
    p = drop({"id": cid, "title": f"Claude Code in {cwd} wants to run {tool}", "ctx": str(ctx)[:300],
              "opts": [{"label": "Allow once", "rec": True, "action": "allow"},
                       {"label": "No", "action": "deny"},
                       {"label": "Always", "action": "allow-always"}],
              "source": "claude-code", "created": now})
    ans = os.path.join(needs, cid + ".answer.json")
    for _ in range(110):
        if os.path.exists(ans): break
        time.sleep(0.5)
    else:
        try: os.remove(p)
        except OSError: pass
        sys.exit(0)   # no decision: Claude Code asks in the terminal
    try: a = json.load(open(ans))
    except Exception: sys.exit(0)
    act = a.get("action", "")
    out = {"hookSpecificOutput": {"hookEventName": "PermissionRequest"}}
    if act == "allow": out["hookSpecificOutput"]["decision"] = {"behavior": "allow"}
    elif act == "allow-always":
        d = {"behavior": "allow"}
        sugg = ev.get("permission_suggestions") or []
        if sugg: d["updatedPermissions"] = sugg
        out["hookSpecificOutput"]["decision"] = d
    elif act == "deny": out["hookSpecificOutput"]["decision"] = {"behavior": "deny", "message": "The user said no from OpenRappter."}
    else: sys.exit(0)
    print(json.dumps(out)); sys.exit(0)
elif kind == "Notification":
    nt = ev.get("notification_type", "")
    if nt not in ("idle_prompt", "agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"): sys.exit(0)
    drop({"id": f"cc-{sid}-note-{int(now)}", "title": f"Claude Code in {cwd} is waiting for you",
          "ctx": (ev.get("message") or "")[:200], "opts": [{"label": "Seen", "rec": True}], "source": "claude-code", "created": now})
elif kind == "Stop":
    if ev.get("stop_hook_active"): sys.exit(0)
    msg = (ev.get("last_assistant_message") or "").strip().replace("\n", " ")
    drop({"id": f"cc-{sid}-done-{int(now)}", "title": f"Claude Code in {cwd} finished",
          "ctx": msg[:200], "opts": [{"label": "OK", "rec": True}], "source": "claude-code", "created": now})
sys.exit(0)
PY
