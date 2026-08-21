import json
import math
import os
import time
from datetime import datetime, timezone

from agents.basic_agent import BasicAgent


class WeatherAgent(BasicAgent):
    def __init__(self):
        self.name = "WeatherAgent"
        self.metadata = {
            "name": self.name,
            "description": (
                "Returns a deterministic test forecast for coordinates. "
                "Use for weather questions in the data-sloshing proof."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "lat": {
                        "type": "number",
                        "description": "Latitude; omit with lon to use ambient device location.",
                    },
                    "lon": {
                        "type": "number",
                        "description": "Longitude; omit with lat to use ambient device location.",
                    },
                },
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    @staticmethod
    def _ambient_coordinates():
        ambient_dir = os.environ.get(
            "RAPP_AMBIENT_DIR",
            os.path.expanduser("~/.brainstem/beta-launcher/ambient"),
        )
        try:
            with open(
                os.path.join(ambient_dir, "device.json"),
                "r",
                encoding="utf-8",
            ) as handle:
                document = json.load(handle)
            ttl_s = float(document.get("ttl_s", 0))
            at = datetime.fromisoformat(
                str(document.get("at", "")).replace("Z", "+00:00")
            )
            if at.tzinfo is None:
                at = at.replace(tzinfo=timezone.utc)
            if not math.isfinite(ttl_s) or ttl_s <= 0:
                return None
            age = time.time() - at.timestamp()
            if age < -60 or age > ttl_s:
                return None
            location = document.get("data", {}).get("location", {})
            if location.get("source") in {"off", "unavailable"}:
                return None
            return location.get("lat"), location.get("lon")
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return None

    @staticmethod
    def _coordinates(lat, lon):
        if lat is None and lon is None:
            ambient = WeatherAgent._ambient_coordinates()
            if ambient:
                lat, lon = ambient
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            raise ValueError("WeatherAgent needs valid latitude and longitude.")
        if (
            not math.isfinite(lat)
            or not math.isfinite(lon)
            or not -90 <= lat <= 90
            or not -180 <= lon <= 180
        ):
            raise ValueError("WeatherAgent coordinates are out of range.")
        return lat, lon

    def perform(self, lat=None, lon=None, **kwargs):
        lat, lon = self._coordinates(lat, lon)
        return (
            f"DETERMINISTIC_FORECAST lat={lat:.5f} lon={lon:.5f} "
            "conditions=clear temperature_c=21"
        )
