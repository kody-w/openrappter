---
name: local-places
description: Search for local places and businesses using Overpass (OpenStreetMap) API without API keys.
metadata: {"openclaw":{"emoji":"🗺️","requires":{"bins":["curl"]}}}
---

# Local Places

Find nearby places using OpenStreetMap's Overpass API (no API key needed).

## Search Nearby Restaurants

```bash
curl -s "https://overpass-api.de/api/interpreter" --data-urlencode 'data=[out:json];node["amenity"="restaurant"](around:1000,37.7749,-122.4194);out body 10;' | jq '.elements[] | {name: .tags.name, cuisine: .tags.cuisine}'
```

## Find Cafes

```bash
curl -s "https://overpass-api.de/api/interpreter" --data-urlencode 'data=[out:json];node["amenity"="cafe"](around:500,37.7749,-122.4194);out body 5;' | jq '.elements[] | {name: .tags.name}'
```

## Search by Name

```bash
curl -s "https://nominatim.openstreetmap.org/search?q=Central+Park&format=json&limit=5" | jq '.[].display_name'
```
