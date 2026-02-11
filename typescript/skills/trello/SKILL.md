---
name: trello
description: Manage Trello boards, lists, and cards via the Trello REST API.
metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["jq"],"env":["TRELLO_API_KEY","TRELLO_TOKEN"]}}}
---

# Trello

Manage Trello boards, lists, and cards.

## List Boards

```bash
curl -s "https://api.trello.com/1/members/me/boards?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" | jq '.[].name'
```

## Get Lists in a Board

```bash
curl -s "https://api.trello.com/1/boards/BOARD_ID/lists?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" | jq '.[] | {name, id}'
```

## Create a Card

```bash
curl -s -X POST "https://api.trello.com/1/cards" \
  -d "key=$TRELLO_API_KEY&token=$TRELLO_TOKEN&idList=LIST_ID&name=New+Card&desc=Description" | jq '{name, url}'
```

## Move a Card

```bash
curl -s -X PUT "https://api.trello.com/1/cards/CARD_ID" \
  -d "key=$TRELLO_API_KEY&token=$TRELLO_TOKEN&idList=NEW_LIST_ID"
```
