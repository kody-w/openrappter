# LearnNewAgent

Meta-agent that **generates new agents from natural language** at runtime. Actions: `create`, `list`, `delete`.

## How It Works

1. Parse description — extract name, params, imports, tags from NL
2. Generate code — [[Single File Agent Pattern]] with factory pattern (TS) or direct imports (PY)
3. Write to `~/.openrappter/agents/`
4. Hot-load — dynamic `import()` (TS) or `importlib` (PY)

## Intelligence

- Keywords → parameters: `file`/`path` → `path` param, `url` → `url` param
- Keywords → imports: `fs`, `crypto`, `https` → Node builtins
- Name: filters stop words, takes first 2 keywords >3 chars, CamelCase joins

Core agents (BasicAgent, ShellAgent, etc.) are protected from deletion.

## Files
- `typescript/src/agents/LearnNewAgent.ts`
- `python/openrappter/agents/learn_new_agent.py`
- Tests: 61 tests

## Related
- [[OuroborosAgent]] | [[Single File Agent Pattern]] | [[Agent Index]]

---

#agents #core #meta
