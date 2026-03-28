# Background Daemon and Cron

openrappter can run as a persistent background daemon with scheduled agent jobs.

## Daemon Setup

### macOS (launchd)
Installed automatically via the install script or menu bar app. Runs as a user-level LaunchAgent.

### Linux (systemd)
```bash
# Created by install script
systemctl --user enable openrappter
systemctl --user start openrappter
```

## Pre-configured Cron Jobs

| Job | Schedule | Agent | Description |
|-----|----------|-------|-------------|
| `daily-tip` | 9:00 AM | DailyTipAgent | Daily feature tip (30-day onboarding) |
| `dream-mode` | 3:00 AM | DreamAgent | Memory consolidation |
| `morning-brief` | 8:00 AM | MorningBriefAgent | Daily summary |

## Custom Cron Jobs

Via CronAgent:

```typescript
await cronAgent.execute({
  action: 'create',
  name: 'health-check',
  schedule: '*/5 * * * *',    // every 5 minutes
  agentName: 'SelfHealingCron',
  kwargs: { url: 'https://myapp.com/health' }
});
```

Or via config:

```yaml
# ~/.openrappter/config.yaml
cron:
  health-check:
    schedule: "*/5 * * * *"
    agent: SelfHealingCron
    kwargs:
      url: https://myapp.com/health
```

## Self-Healing Pattern

See [[SelfHealingCronAgent]] for autonomous health monitoring with auto-repair.

## Files
- `typescript/src/agents/CronAgent.ts` — Job scheduling
- `typescript/src/agents/DailyTipAgent.ts` — Daily tips
- `typescript/src/agents/DreamAgent.ts` — Memory consolidation
- `typescript/src/storage/sqlite.ts` — Job persistence

## Related
- [[SelfHealingCronAgent]]
- [[Getting Started]]
- [[Config System]]

---

#guides #daemon #cron
