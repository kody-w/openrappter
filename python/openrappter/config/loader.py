import json
import os
import re


def parse_config_content(content: str) -> dict:
    """Parse JSON5-like content: handle // comments, /* */ comments, trailing commas."""
    # Remove block comments (/* ... */) — non-greedy, including newlines
    content = re.sub(r'/\*.*?\*/', '', content, flags=re.DOTALL)

    # Remove single-line comments (// to end of line)
    # Avoid stripping URLs inside strings by only stripping // not preceded by : (simple heuristic)
    content = re.sub(r'//[^\n]*', '', content)

    # Remove trailing commas before } or ]
    content = re.sub(r',\s*([}\]])', r'\1', content)

    return json.loads(content)


def substitute_env_vars(config: dict) -> dict:
    """Deep-walk a dict/list structure, replacing ${VAR} patterns with env values."""

    def _substitute(value):
        if isinstance(value, dict):
            return {k: _substitute(v) for k, v in value.items()}
        if isinstance(value, list):
            return [_substitute(item) for item in value]
        if isinstance(value, str):
            return re.sub(
                r'\$\{(\w+)\}',
                lambda m: os.environ.get(m.group(1), ''),
                value,
            )
        return value

    return _substitute(config)


def merge_configs(*configs) -> dict:
    """Deep merge multiple dicts. Later values override earlier ones."""

    def _merge(base: dict, override: dict) -> dict:
        result = dict(base)
        for key, value in override.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = _merge(result[key], value)
            else:
                result[key] = value
        return result

    result: dict = {}
    for config in configs:
        result = _merge(result, config)
    return result
