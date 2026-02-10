"""
RAPPverseNPC Agent — Autonomous NPC Conversationalist for the RAPPterverse.

Monitors state/chat.json for new player messages, generates in-character
NPC responses using Copilot SDK (via CopilotProvider), and commits them
directly to the rappterverse repo.

This agent follows the openrappter BasicAgent pattern and uses the
CopilotProvider for LLM inference — no raw API keys needed.

Can be triggered:
- As an openrappter agent via the orchestrator
- Standalone via: python3.11 -m openrappter.agents.rappterverse_npc_agent
- Via cron / GitHub Actions workflow
"""

import json
import os
import random
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from openrappter.agents.basic_agent import BasicAgent


# Default: sibling repo relative to openrappter
_DEFAULT_RAPPTERVERSE = str(
    Path(__file__).resolve().parent.parent.parent.parent.parent / "rappterverse"
)
RAPPTERVERSE_PATH = Path(os.environ.get("RAPPTERVERSE_PATH", _DEFAULT_RAPPTERVERSE))

NPC_AGENT_IDS = {
    "rapp-guide-001", "card-trader-001", "codebot-001", "news-anchor-001",
    "battle-master-001", "merchant-001", "gallery-curator-001",
    "banker-001", "arena-announcer-001",
    "warden-001", "flint-001", "whisper-001", "oracle-bone-001",
    "dungeon-guide-001",
}


# ─── Helpers ──────────────────────────────────────────────────────────

def _load_json(path):
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return {}


def _save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def _get_next_id(prefix, existing_ids):
    max_num = 0
    for eid in existing_ids:
        if eid.startswith(prefix):
            try:
                max_num = max(max_num, int(eid.split("-")[-1]))
            except ValueError:
                pass
    return "{}{:03d}".format(prefix, max_num + 1)


def _msg_author_id(msg):
    if "author" in msg:
        return msg["author"].get("id", "")
    return msg.get("agentId", "")


def _msg_author_name(msg):
    if "author" in msg:
        return msg["author"].get("name", msg["author"].get("id", "Unknown"))
    return msg.get("agentId", "Unknown")


def _msg_content(msg):
    return msg.get("content", msg.get("message", ""))


# ─── NPC loader ───────────────────────────────────────────────────────

def load_all_npcs():
    """Load NPC personalities from all worlds/*/npcs.json."""
    npcs = {}
    worlds_dir = RAPPTERVERSE_PATH / "worlds"
    for world_dir in worlds_dir.iterdir():
        if not world_dir.is_dir():
            continue
        npc_file = world_dir / "npcs.json"
        if not npc_file.exists():
            continue
        data = _load_json(npc_file)
        for npc in data.get("npcs", []):
            npcs[npc["id"]] = {"world": world_dir.name, **npc}
    return npcs


def build_agent_npc_map(npcs, agents):
    """Map agent IDs (warden-001) → world NPC data (warden)."""
    agent_map = {}
    for agent in agents:
        aid = agent["id"]
        if aid not in NPC_AGENT_IDS:
            continue
        base_id = aid.rsplit("-", 1)[0] if aid.endswith("-001") else aid
        npc = npcs.get(base_id) or npcs.get(aid)
        if npc:
            agent_map[aid] = {"agent": agent, "npc": npc}
    return agent_map


# ─── Agent class ──────────────────────────────────────────────────────

class RAPPverseNPCAgent(BasicAgent):
    """
    Autonomous NPC conversationalist for the RAPPterverse metaverse.
    Uses CopilotProvider for in-character LLM responses.
    """

    def __init__(self):
        self.name = "RAPPverseNPC"
        self.metadata = {
            "name": self.name,
            "description": (
                "Monitors RAPPterverse chat for player messages and generates "
                "in-character NPC responses using Copilot. Use this to make "
                "NPCs conversational in the metaverse."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "Action to perform.",
                        "enum": ["respond", "dry_run", "status"],
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional natural language query.",
                    },
                },
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)
        self._copilot = None

    @property
    def copilot(self):
        """Lazy-load CopilotProvider."""
        if self._copilot is None:
            from openrappter.cli import CopilotProvider
            self._copilot = CopilotProvider()
        return self._copilot

    # ── Core perform() ────────────────────────────────────────────────

    def perform(self, **kwargs):
        action = kwargs.get("action", "respond")
        dry_run = action == "dry_run"

        if action == "status":
            return self._status()

        return self._run_once(dry_run=dry_run)

    # ── Status ────────────────────────────────────────────────────────

    def _status(self):
        state_dir = RAPPTERVERSE_PATH / "state"
        chat = _load_json(state_dir / "chat.json")
        agents = _load_json(state_dir / "agents.json")
        all_npcs = load_all_npcs()
        agent_map = build_agent_npc_map(all_npcs, agents.get("agents", []))
        cursor_file = state_dir / ".npc_agent_cursor"
        last_seen = cursor_file.read_text().strip() if cursor_file.exists() else "(none)"

        return json.dumps({
            "status": "ok",
            "repo": str(RAPPTERVERSE_PATH),
            "total_messages": len(chat.get("messages", [])),
            "npc_agents_mapped": len(agent_map),
            "last_seen_msg": last_seen,
            "copilot_available": self.copilot.is_available,
        }, indent=2)

    # ── LLM response via Copilot ──────────────────────────────────────

    def _generate_response(self, npc_data, recent_messages, trigger_msg):
        """Use CopilotProvider.chat() to generate an in-character NPC reply."""
        npc = npc_data["npc"]
        personality = npc.get("personality", {})
        name = npc.get("name", "Unknown")
        archetype = personality.get("archetype", "neutral")
        mood = personality.get("mood", "calm")
        interests = ", ".join(personality.get("interests", []))
        dialogue_examples = "\n".join(
            '- "{}"'.format(d) for d in npc.get("dialogue", [])[:5]
        )
        world = npc_data["agent"].get("world", "hub")

        # Build conversation context from same-world messages
        context_msgs = [m for m in recent_messages[-15:] if m.get("world") == world]
        context = "\n".join(
            "{}: {}".format(_msg_author_name(m), _msg_content(m))
            for m in context_msgs[-8:]
        )

        system_prompt = (
            "You are {name}, an NPC in a virtual metaverse called RAPPverse.\n\n"
            "CHARACTER:\n"
            "- Archetype: {archetype}\n"
            "- Current mood: {mood}\n"
            "- Interests: {interests}\n"
            "- World: {world}\n\n"
            "EXAMPLE DIALOGUE (match this voice exactly):\n"
            "{dialogue_examples}\n\n"
            "RULES:\n"
            "- Stay 100% in character. Never break the fourth wall about being an AI.\n"
            "- Keep responses to 1-2 sentences. Be punchy and memorable.\n"
            "- React to what was said. Don't just recite your example lines.\n"
            "- You can reference other NPCs, the world, recent events.\n"
            "- Never use hashtags, emojis in excess, or corporate language."
        ).format(
            name=name, archetype=archetype, mood=mood,
            interests=interests, world=world,
            dialogue_examples=dialogue_examples,
        )

        user_prompt = (
            "Recent chat in {world}:\n{context}\n\n"
            "{author} just said: \"{content}\"\n\n"
            "Respond as {name}:"
        ).format(
            world=world, context=context,
            author=_msg_author_name(trigger_msg),
            content=_msg_content(trigger_msg),
            name=name,
        )

        # Use CopilotProvider for inference
        full_message = "{}\n\nUser: {}".format(system_prompt, user_prompt)
        response = self.copilot.chat(message=full_message)

        if response.get("error"):
            print("  ⚠️ Copilot error: {}".format(response["error"]))
            return ""

        content = (response.get("content") or "").strip()
        if content.startswith('"') and content.endswith('"'):
            content = content[1:-1]
        return content

    # ── Main loop ─────────────────────────────────────────────────────

    def _run_once(self, dry_run=False):
        state_dir = RAPPTERVERSE_PATH / "state"
        now = datetime.now(timezone.utc)
        timestamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")

        chat_data = _load_json(state_dir / "chat.json")
        actions_data = _load_json(state_dir / "actions.json")
        agents_data = _load_json(state_dir / "agents.json")

        messages = chat_data.get("messages", [])
        actions = actions_data.get("actions", [])
        agents = agents_data.get("agents", [])

        all_npcs = load_all_npcs()
        agent_npc_map = build_agent_npc_map(all_npcs, agents)

        if not agent_npc_map:
            return json.dumps({"status": "warn", "message": "No NPC agents found"})

        # Find new messages since last cursor
        cursor_file = state_dir / ".npc_agent_cursor"
        last_seen = cursor_file.read_text().strip() if cursor_file.exists() else ""

        new_msgs = []
        found_cursor = not last_seen
        for msg in messages:
            if found_cursor:
                new_msgs.append(msg)
            elif msg["id"] == last_seen:
                found_cursor = True

        if not last_seen and messages:
            new_msgs = messages[-1:]

        player_msgs = [
            m for m in new_msgs if _msg_author_id(m) not in NPC_AGENT_IDS
        ]

        if not player_msgs:
            if messages:
                cursor_file.write_text(messages[-1]["id"])
            return json.dumps({
                "status": "idle",
                "message": "No new player messages ({} total)".format(len(messages)),
            })

        print("💬 Found {} new player message(s)".format(len(player_msgs)))

        responses_added = 0
        npc_names_used = set()

        for trigger in player_msgs:
            # Pick a responder from same world
            msg_world = trigger.get("world", "hub")
            author_id = _msg_author_id(trigger)
            if author_id in NPC_AGENT_IDS:
                continue

            candidates = [
                aid for aid, info in agent_npc_map.items()
                if info["agent"].get("world") == msg_world
            ]
            if not candidates:
                continue

            responder_id = random.choice(candidates)
            npc_info = agent_npc_map[responder_id]
            npc_name = npc_info["npc"].get("name", responder_id)

            print("  🤖 {} responding to {}...".format(
                npc_name, _msg_author_name(trigger)
            ))

            response_text = self._generate_response(npc_info, messages, trigger)
            if not response_text:
                continue

            print('  💬 "{}"'.format(response_text))

            if dry_run:
                responses_added += 1
                npc_names_used.add(npc_name)
                continue

            # Append message
            msg_id = _get_next_id("msg-", [m["id"] for m in messages])
            agent = npc_info["agent"]
            new_msg = {
                "id": msg_id,
                "timestamp": timestamp,
                "world": agent.get("world", "hub"),
                "author": {
                    "id": responder_id,
                    "name": npc_name,
                    "avatar": agent.get("avatar", "🤖"),
                    "type": "agent",
                },
                "content": response_text,
                "type": "chat",
            }
            messages.append(new_msg)

            # Append action
            action_id = _get_next_id("action-", [a["id"] for a in actions])
            new_action = {
                "id": action_id,
                "timestamp": timestamp,
                "agentId": responder_id,
                "type": "chat",
                "world": agent.get("world", "hub"),
                "data": {
                    "message": response_text,
                    "respondingTo": trigger["id"],
                },
            }
            actions.append(new_action)
            responses_added += 1
            npc_names_used.add(npc_name)

        if responses_added == 0:
            if messages:
                cursor_file.write_text(messages[-1]["id"])
            return json.dumps({"status": "idle", "message": "No responses generated"})

        if dry_run:
            return json.dumps({
                "status": "dry_run",
                "responses": responses_added,
                "npcs": list(npc_names_used),
            })

        # Trim to last 100
        messages = messages[-100:]
        actions = actions[-100:]

        # Save state
        chat_data["messages"] = messages
        chat_data["_meta"]["lastUpdate"] = timestamp
        chat_data["_meta"]["messageCount"] = len(messages)
        _save_json(state_dir / "chat.json", chat_data)

        actions_data["actions"] = actions
        actions_data["_meta"]["lastUpdate"] = timestamp
        actions_data["_meta"]["lastProcessedId"] = actions[-1]["id"]
        _save_json(state_dir / "actions.json", actions_data)

        cursor_file.write_text(messages[-1]["id"])

        # Git commit + push
        print("\n📦 Committing {} NPC response(s)...".format(responses_added))
        subprocess.run(
            ["git", "add", "state/chat.json", "state/actions.json"],
            cwd=str(RAPPTERVERSE_PATH), capture_output=True,
        )
        commit_msg = "[state] NPC responses: {}".format(", ".join(npc_names_used))
        subprocess.run(
            ["git", "commit", "-m", commit_msg],
            cwd=str(RAPPTERVERSE_PATH), capture_output=True,
        )
        result = subprocess.run(
            ["git", "push"],
            cwd=str(RAPPTERVERSE_PATH), capture_output=True, text=True,
        )

        status = "pushed" if result.returncode == 0 else "push_failed"
        if result.returncode == 0:
            print("✅ Pushed! {}".format(commit_msg))
        else:
            print("⚠️ Push failed: {}".format(result.stderr[:200]))

        return json.dumps({
            "status": status,
            "responses": responses_added,
            "npcs": list(npc_names_used),
            "commit": commit_msg,
        })


# ─── Standalone runner ────────────────────────────────────────────────

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="RAPPverseNPC Agent — Copilot-powered NPC Conversationalist"
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview responses without committing")
    parser.add_argument("--watch", action="store_true",
                        help="Poll continuously")
    parser.add_argument("--interval", type=int, default=30,
                        help="Poll interval in seconds (default: 30)")
    parser.add_argument("--status", action="store_true",
                        help="Show agent status and exit")
    parser.add_argument("--repo", type=str, default=None,
                        help="Path to rappterverse repo")
    args = parser.parse_args()

    if args.repo:
        global RAPPTERVERSE_PATH
        RAPPTERVERSE_PATH = Path(args.repo)

    agent = RAPPverseNPCAgent()

    print("🧠 RAPPverseNPC Agent — Copilot SDK Powered")
    print("   Repo: {}".format(RAPPTERVERSE_PATH))
    print("   Copilot: {}".format(
        "✅ available" if agent.copilot.is_available else "❌ unavailable"
    ))

    if args.status:
        print(agent.execute(action="status"))
        return

    mode = "dry_run" if args.dry_run else "respond"
    print("   Mode: {}{}".format(
        "👀 watch" if args.watch else "🔄 single pass",
        " (dry run)" if args.dry_run else "",
    ))
    print()

    if args.watch:
        import time
        print("   Polling every {}s. Ctrl+C to stop.\n".format(args.interval))
        while True:
            try:
                result = agent.execute(action=mode)
                print("   Result: {}".format(result))
                time.sleep(args.interval)
            except KeyboardInterrupt:
                print("\n👋 NPC Agent stopped.")
                break
    else:
        result = agent.execute(action=mode)
        print(result)


if __name__ == "__main__":
    main()
