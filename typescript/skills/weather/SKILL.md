---
name: weather
description: Get current weather and forecasts (no API key required).
homepage: https://wttr.in/:help
metadata: {"openclaw":{"emoji":"🌤️","requires":{"bins":["curl"]}}}
---

# Weather

Get weather information using free services.

## Quick Weather

```bash
curl -s "wttr.in/London?format=3"
# Output: London: ⛅️ +8°C
```

## Detailed Format

```bash
curl -s "wttr.in/London?format=%l:+%c+%t+%h+%w"
```

## Full Forecast

```bash
curl -s "wttr.in/London?T"
```

## Tips

- URL-encode spaces: `wttr.in/New+York`
- Airport codes: `wttr.in/JFK`
- Units: `?m` (metric) `?u` (USCS)
- Today only: `?1`
- Current only: `?0`

## Open-Meteo (JSON, No Key)

```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current_weather=true"
```
