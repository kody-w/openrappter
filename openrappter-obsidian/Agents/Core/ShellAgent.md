# ShellAgent

Execute shell commands, read/write files, list directories. The workhorse for filesystem and system operations.

## Actions

| Action | Description | Key Params |
|--------|-------------|------------|
| `bash` | Execute shell command | `command` |
| `read` | Read file contents | `path` |
| `write` | Write to file | `path`, `content` |
| `list` | List directory | `path` |

Parses natural language to infer actions ("list files in /tmp" → action: `list`).

## Files
- `typescript/src/agents/ShellAgent.ts`
- `python/openrappter/agents/shell_agent.py`

## Related
- [[BasicAgent]] | [[Agent Index]]

---

#agents #core
