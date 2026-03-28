# SelfHealingCronAgent

Autonomous health check loop: monitors a URL, detects failures, runs repair commands, notifies on status changes.

## Actions

| Action | Description |
|--------|-------------|
| `setup` | Create a health check job with URL, repair command, notification config |
| `check` | Run a single health check cycle |
| `status` | Current health status + uptime percentage |
| `history` | All check history |
| `teardown` | Remove a health check job |

## Health Check Cycle

```
1. Fetch health URL (via WebAgent)
   -> healthy? -> record "healthy", action_taken='none'
   -> unhealthy?
     2. Run repair command (via ShellAgent)
     3. Re-check health URL
        -> recovered? -> action_taken='restarted_recovered'
        -> still down? -> action_taken='restarted_still_down'
     4. Notify via MessageAgent
```

## Data Slush

Always includes `action_taken` in output:
- `none` — Service was healthy
- `restarted_recovered` — Restart fixed the issue
- `restarted_still_down` — Restart didn't help

## Agent Dependencies

Uses injectable agents via `setAgents()`:
- [[WebAgent]] — Health URL fetch
- [[ShellAgent]] — Repair command execution
- MessageAgent — Status notifications

## Files
- `typescript/src/agents/SelfHealingCronAgent.ts`
- `python/openrappter/agents/self_healing_cron_agent.py`
- Tests: `typescript/src/__tests__/parity/showcase-healing-loop.test.ts`

## Related
- [[Agent Index]]
- [[Showcase Demos]] — Demo #17 "Healing Loop"

---

#agents #specialized #resilience
