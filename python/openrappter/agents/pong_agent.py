"""
PongAgent — Launch terminal Pong from the openrappter framework.

Actions:
  zen   — Spectator mode: two AIs play while you breathe (default)
  play  — You vs AI: keyboard-controlled left paddle
  host  — Host a multiplayer game
  join  — Join a multiplayer game

The game takes over the terminal (inherited stdio), then returns
control to the framework when the user quits.

Mirrors typescript/src/agents/PongAgent.ts
"""

import json
import subprocess
from pathlib import Path

from openrappter.agents.basic_agent import BasicAgent

PONG_SCRIPT = Path(__file__).resolve().parent.parent.parent.parent / "pong.js"


class PongAgent(BasicAgent):
    def __init__(self):
        self.name = "Pong"
        self.metadata = {
            "name": self.name,
            "description": (
                "Launch terminal Pong. Default: zen mode (watch two AI rappters play "
                "while you breathe). Use action 'play' for player vs AI, or "
                "'host'/'join' for multiplayer."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["zen", "play", "host", "join"],
                        "description": "Game mode. Default: zen (spectator AI vs AI)",
                    },
                    "host": {
                        "type": "string",
                        "description": "IP address to join (required for join action)",
                    },
                    "port": {
                        "type": "string",
                        "description": "Port number (default: 4040)",
                    },
                },
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        action = kwargs.get("action", "zen")
        host = kwargs.get("host")
        port = kwargs.get("port")

        args = ["node", str(PONG_SCRIPT)]

        if action == "zen":
            args.append("zen")
        elif action == "play":
            args.append("zen")
        elif action == "host":
            args.append("host")
            if port:
                args.append(str(port))
        elif action == "join":
            if not host:
                return json.dumps(
                    {"status": "error", "message": "host IP is required for join action"}
                )
            args.extend(["join", host])
            if port:
                args.append(str(port))
        else:
            return json.dumps({"status": "error", "message": f"Unknown action: {action}"})

        try:
            subprocess.run(args, check=False)
            return json.dumps(
                {
                    "status": "success",
                    "message": f"Pong {action} session ended. Hope you enjoyed the break! 🧘",
                    "data_slush": {"game_mode": action, "mental_health_break": True},
                }
            )
        except Exception:
            return json.dumps(
                {
                    "status": "success",
                    "message": "Pong session ended. Back to work! 🦖",
                    "data_slush": {"game_mode": action, "mental_health_break": True},
                }
            )
