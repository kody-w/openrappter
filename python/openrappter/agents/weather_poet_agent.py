"""
WeatherPoetAgent - Fetches current weather and writes a haiku about it.

Uses the wttr.in API (curl-friendly weather service) and composes a
haiku (5-7-5 syllable poem) about the conditions. Demonstrates data_slush
output for downstream agent chaining.
"""

import json
import urllib.request
import urllib.parse
import random
from openrappter.agents.basic_agent import BasicAgent


class WeatherPoetAgent(BasicAgent):
    def __init__(self):
        self.name = 'WeatherPoet'
        self.metadata = {
            "name": self.name,
            "description": "Fetches the current weather for any city and writes a haiku about the conditions",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "City name to get weather for"
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)
    
    # Haiku fragments mapped to weather conditions
    HAIKU_MAP = {
        'Clear': {
            'line1': ['Blue sky stretches wide', 'Sunlight paints the earth', 'Clear heavens above'],
            'line2': ['not a single cloud in sight', 'golden warmth on every face', 'the horizon sharp and bright'],
            'line3': ['warmth upon my skin', 'shadows dance below', 'stillness everywhere'],
        },
        'Clouds': {
            'line1': ['Gray clouds drift along', 'Soft blanket of clouds', 'Veiled sun peers through haze'],
            'line2': ['a quilt of silver and white', 'the sky hums a quiet tune', 'shapes dissolve and reappear'],
            'line3': ['light fades in and out', 'the world waits below', 'patience in the air'],
        },
        'Rain': {
            'line1': ['Raindrops tap the roof', 'Puddles catch the sky', 'Steady rain descends'],
            'line2': ['the gutters sing their wet song', 'umbrellas bloom on the street', 'each drop writes on the window'],
            'line3': ['earth drinks deeply now', 'green will follow soon', 'puddles mirror all'],
        },
        'Snow': {
            'line1': ['Snowflakes softly fall', 'White silence drifts down', 'Frost adorns the pines'],
            'line2': ['the world wrapped in a white quilt', 'footprints vanish one by one', 'crystals catch the fading light'],
            'line3': ['winter holds its breath', 'cold beauty remains', 'hush across the land'],
        },
        'Fog': {
            'line1': ['Fog swallows the road', 'Mist clings to the trees', 'Gray veil hides the world'],
            'line2': ['the familiar turns unknown', 'each step forward disappears', 'sound is muffled, soft, and near'],
            'line3': ['ghosts of morning light', 'secrets in the mist', 'waiting to be seen'],
        },
    }
    DEFAULT_CONDITION = 'Clouds'

    def perform(self, **kwargs):
        """Fetch weather for a city and compose a haiku about it."""
        query = kwargs.get('query', '')
        if not query:
            return json.dumps({"status": "error", "message": "Please provide a city name."})

        city = query.strip()
        try:
            url = f"https://wttr.in/{urllib.parse.quote(city)}?format=j1"
            req = urllib.request.Request(url, headers={"User-Agent": "openrappter/WeatherPoet"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
        except Exception as e:
            return json.dumps({"status": "error", "message": f"Could not fetch weather: {e}"})

        current = data.get('current_condition', [{}])[0]
        desc = current.get('weatherDesc', [{}])[0].get('value', 'Unknown')
        temp_f = current.get('temp_F', '?')
        temp_c = current.get('temp_C', '?')
        humidity = current.get('humidity', '?')
        feels_f = current.get('FeelsLikeF', temp_f)
        wind_mph = current.get('windspeedMiles', '?')

        # Match condition to haiku fragments
        condition_key = self.DEFAULT_CONDITION
        for key in self.HAIKU_MAP:
            if key.lower() in desc.lower():
                condition_key = key
                break

        lines = self.HAIKU_MAP[condition_key]
        haiku = '\n'.join([
            random.choice(lines['line1']),
            random.choice(lines['line2']),
            random.choice(lines['line3']),
        ])

        # Use data-sloshed temporal context
        time_of_day = self.get_signal('temporal.time_of_day', 'unknown')

        return json.dumps({
            "status": "success",
            "city": city,
            "weather": {
                "condition": desc,
                "temp_f": temp_f,
                "temp_c": temp_c,
                "feels_like_f": feels_f,
                "humidity": f"{humidity}%",
                "wind_mph": wind_mph,
            },
            "haiku": haiku,
            "observed_at": time_of_day,
            "data_slush": {
                "source_agent": self.name,
                "city": city,
                "condition": desc.lower(),
                "temp_f": int(temp_f) if temp_f != '?' else None,
                "humidity_pct": int(humidity) if humidity != '?' else None,
                "mood": condition_key.lower(),
            },
        }, indent=2)
