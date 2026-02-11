---
name: ordercli
description: Order food delivery from supported services via the ordercli command-line tool.
metadata: {"openclaw":{"emoji":"🥡","requires":{"bins":["ordercli"]},"install":[{"id":"go","kind":"go","module":"github.com/steipete/ordercli/cmd/ordercli@latest","bins":["ordercli"],"label":"Install ordercli (go)"}]}}
---

# OrderCLI

Order food delivery from the command line.

## Browse Restaurants

```bash
ordercli restaurants --location "Vienna, Austria"
```

## View Menu

```bash
ordercli menu --restaurant "Restaurant Name"
```

## Place an Order

```bash
ordercli order --restaurant "Restaurant Name" --items "Margherita Pizza, Tiramisu"
```

## Check Order Status

```bash
ordercli status
```
