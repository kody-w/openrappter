# Config System

YAML/JSON configuration with Zod schema validation and file-watcher hot-reload.

## Config Location

- Primary: `~/.openrappter/config.yaml`
- Override: Environment variables (`${VAR}` substitution)
- Runtime: Dashboard API updates

## Utilities

| Function | Purpose |
|----------|---------|
| `parseConfigContent(text)` | JSON5 parsing (comments + trailing commas) |
| `validateConfig(config)` | Zod validation → `{ success, errors? }` |
| `mergeConfigs(a, b)` | Deep merge preserving all sections |
| `substituteEnvVars(config)` | Replace `${VAR}` placeholders |
| `exportJsonSchema()` | JSON Schema for tooling |

## Related
- [[Architecture Overview]]
- [[Getting Started]]

---

#architecture #config
