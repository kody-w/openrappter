---
name: 1password
description: Set up and use 1Password CLI (op). Use when installing the CLI, enabling desktop app integration, signing in, or reading/injecting/running secrets via op.
homepage: https://developer.1password.com/docs/cli/get-started/
metadata: {"openclaw":{"emoji":"🔐","requires":{"bins":["op"]},"install":[{"id":"brew","kind":"brew","formula":"1password-cli","bins":["op"],"label":"Install 1Password CLI (brew)"}]}}
---

# 1Password CLI

Manage secrets through the 1Password CLI (`op`).

## Setup

1. Install: `brew install 1password-cli`
2. Enable desktop app integration in 1Password preferences
3. Sign in: `op signin`
4. Verify: `op whoami`

## Common Commands

```bash
# List vaults
op vault list

# Get an item
op item get "Item Name" --vault "Vault"

# Read a secret field
op read "op://Vault/Item/field"

# Run a command with secrets injected
op run --env-file=.env -- your-command

# Inject secrets into a template
op inject -i template.env -o .env
```

## Best Practices

- Use `op run` or `op inject` instead of writing secrets to disk
- Never paste secrets into logs, chat, or code
- Use `--account` flag for multi-account setups
