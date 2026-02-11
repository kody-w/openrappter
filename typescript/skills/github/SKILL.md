---
name: github
description: Interact with GitHub repositories, issues, pull requests, and actions using the gh CLI.
metadata: {"openclaw":{"emoji":"🐙","requires":{"bins":["gh"]}}}
---

# GitHub

Manage GitHub resources with the `gh` CLI.

## Issues

```bash
# List open issues
gh issue list

# Create an issue
gh issue create --title "Bug report" --body "Description"

# View an issue
gh issue view 123
```

## Pull Requests

```bash
# List PRs
gh pr list

# Create a PR
gh pr create --title "Feature" --body "Description"

# Review a PR
gh pr diff 456
gh pr review 456 --approve
```

## Actions

```bash
# List workflow runs
gh run list

# View a specific run
gh run view 789

# Re-run a failed workflow
gh run rerun 789
```

## API Access

```bash
# Query the GraphQL API
gh api graphql -f query='{ viewer { login } }'

# REST API
gh api repos/owner/repo/releases
```
