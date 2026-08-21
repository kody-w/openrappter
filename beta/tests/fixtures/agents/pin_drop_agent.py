import hashlib
import json
import math
import os
from datetime import datetime, timezone

from agents.basic_agent import BasicAgent


class PinDropAgent(BasicAgent):
    def __init__(self):
        self.name = "PinDropAgent"
        self.metadata = {
            "name": self.name,
            "description": (
                "Drops a local proof pin for a recipient at supplied coordinates."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "Recipient for the pin.",
                    },
                    "lat": {
                        "type": "number",
                        "description": "Pin latitude.",
                    },
                    "lon": {
                        "type": "number",
                        "description": "Pin longitude.",
                    },
                },
                "required": ["to", "lat", "lon"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, to="", lat=None, lon=None, **kwargs):
        recipient = str(to or "").strip()[:160]
        if not recipient:
            raise ValueError("PinDropAgent needs a recipient.")
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            raise ValueError("PinDropAgent needs valid latitude and longitude.")
        if (
            not math.isfinite(lat)
            or not math.isfinite(lon)
            or not -90 <= lat <= 90
            or not -180 <= lon <= 180
        ):
            raise ValueError("PinDropAgent coordinates are out of range.")
        at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        payload = {"to": recipient, "lat": lat, "lon": lon, "at": at}
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()[:16]
        pin_id = f"pin-{digest}"
        agents_dir = os.path.dirname(os.path.abspath(__file__))
        destination = os.path.join(agents_dir, f"{pin_id}.json")
        temporary = f"{destination}.{os.getpid()}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        return (
            f"PIN_DROPPED id={pin_id} to={recipient} "
            f"lat={lat:.5f} lon={lon:.5f}"
        )
