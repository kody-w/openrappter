# New Agent Template

> Use this checklist when creating a new agent. See [[Creating an Agent]] for the full guide.

## Agent: {{name}}

### Purpose
_What does this agent do?_

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| | | | |

### Actions

| Action | Description |
|--------|-------------|
| | |

### Implementation Checklist

- [ ] Create file: `*Agent.ts` or `*_agent.py`
- [ ] Define metadata in constructor (name, description, parameters)
- [ ] Implement `perform()` method
- [ ] Return JSON with `status` field
- [ ] Add `data_slush` if downstream agents need data
- [ ] Write tests
- [ ] Test in both runtimes (if parity required)

### Data Slush Output

```json
{
  "data_slush": {

  }
}
```

### Dependencies
- Upstream agents:
- Downstream agents:

---

#template #agents
