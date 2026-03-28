# Creating an Agent

Follow the [[Single File Agent Pattern]]: one file, metadata in the constructor, implement `perform()`.

## Step 1: Create the File

**TypeScript:** `typescript/src/agents/MyAgent.ts`
**Python:** `python/openrappter/agents/my_agent.py`

Or for user agents: `~/.openrappter/agents/`

## Step 2: Write the Agent

### TypeScript

```typescript
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class WeatherAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' },
          units: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature units' }
        },
        required: ['location']
      }
    };
    super('Weather', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const location = kwargs.location as string;
    const units = (kwargs.units as string) || 'celsius';

    // Access sloshed context
    const timeOfDay = this.getSignal('temporal.time_of_day');

    // Your logic here
    const weather = await fetchWeather(location, units);

    return JSON.stringify({
      status: 'success',
      location,
      temperature: weather.temp,
      conditions: weather.desc,
      data_slush: {                    // Forward to downstream agents
        temperature: weather.temp,
        is_severe: weather.temp > 35
      }
    });
  }
}
```

### Python

```python
from openrappter.agents.basic_agent import BasicAgent
import json

class WeatherAgent(BasicAgent):
    def __init__(self):
        self.name = 'Weather'
        self.metadata = {
            "name": self.name,
            "description": "Get current weather for a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "City name"},
                    "units": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                },
                "required": ["location"]
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        location = kwargs.get('location', '')
        units = kwargs.get('units', 'celsius')
        time_of_day = self.get_signal('temporal.time_of_day')

        weather = fetch_weather(location, units)

        return json.dumps({
            "status": "success",
            "location": location,
            "temperature": weather["temp"],
            "data_slush": {"temperature": weather["temp"]}
        })
```

## Step 3: Auto-Discovery

- Built-in agents: discovered automatically by `AgentRegistry`
- User agents at `~/.openrappter/agents/`: also auto-discovered
- File naming: `*Agent.ts` or `*_agent.py`

## Step 4: Test

```bash
# TypeScript
cd typescript && npx vitest run src/__tests__/parity/my-agent.test.ts

# Python
cd python && pytest tests/test_my_agent.py
```

## Conventions

| Rule | Detail |
|------|--------|
| Return format | `{"status": "success\|error", ...}` |
| Data slush | Include `data_slush` key for downstream agents |
| Context | Access via `this.context` / `self.context` |
| Signals | Use `getSignal('key.subkey', default)` |

## Alternative: Let AI Create It

Use [[LearnNewAgent]] to generate agents from natural language:

```
> Create an agent that checks weather for any city
```

## Related
- [[Single File Agent Pattern]]
- [[BasicAgent]]
- [[Agent Index]]
- [[Data Sloshing]]
- [[Data Slush Pipeline]]

---

#guides #agents
