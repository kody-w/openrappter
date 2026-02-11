---
name: goplaces
description: Search for nearby places, restaurants, and businesses using Google Places or OpenStreetMap.
metadata: {"openclaw":{"emoji":"📍","requires":{"env":["GOOGLE_PLACES_API_KEY"]},"primaryEnv":"GOOGLE_PLACES_API_KEY"}}
---

# GoPlaces

Find nearby places and businesses.

## Search Nearby

```bash
curl -s "https://maps.googleapis.com/maps/api/place/nearbysearch/json?\
location=37.7749,-122.4194&radius=1500&type=restaurant&key=$GOOGLE_PLACES_API_KEY" | \
jq '.results[] | {name, rating, vicinity}'
```

## Text Search

```bash
curl -s "https://maps.googleapis.com/maps/api/place/textsearch/json?\
query=coffee+shop+San+Francisco&key=$GOOGLE_PLACES_API_KEY" | \
jq '.results[:5] | .[] | {name, formatted_address, rating}'
```

## Place Details

```bash
curl -s "https://maps.googleapis.com/maps/api/place/details/json?\
place_id=PLACE_ID&key=$GOOGLE_PLACES_API_KEY" | jq '.result | {name, formatted_phone_number, website}'
```
