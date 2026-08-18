"""Tests for Config Hotswap showcase — mirrors TypeScript showcase-config-hotswap.test.ts."""

import json
import os

import pytest

from openrappter.config.loader import merge_configs, parse_config_content, substitute_env_vars
from openrappter.config.schema import get_config_json_schema, validate_config


# ---------------------------------------------------------------------------
# 1. JSON5 parsing: comments and trailing commas
# ---------------------------------------------------------------------------

def test_parse_config_content_handles_comments_and_trailing_commas():
    content = """
{
    // This is a single-line comment
    "gateway": {
        "port": 3000, /* inline block comment */
        "host": "localhost", // trailing comment
    },
    "models": [
        "gpt-4",
        "claude-3", /* last item trailing comma */
    ],
}
"""
    result = parse_config_content(content)
    assert result['gateway']['port'] == 3000
    assert result['gateway']['host'] == 'localhost'
    assert result['models'] == ['gpt-4', 'claude-3']


# ---------------------------------------------------------------------------
# 2. Valid config validation
# ---------------------------------------------------------------------------

def test_validate_config_returns_success_for_valid_config():
    data = {
        'gateway': {'port': 8080, 'host': '0.0.0.0'},
        'models': [{'name': 'gpt-4', 'provider': 'openai'}],
        'agents': {'maxConcurrent': 5},
    }
    result = validate_config(data)
    assert result['success'] is True
    assert result['data'] == data


# ---------------------------------------------------------------------------
# 3. Invalid config validation
# ---------------------------------------------------------------------------

def test_validate_config_returns_error_for_invalid_config():
    # Not a dict
    result = validate_config("not a dict")  # type: ignore[arg-type]
    assert result['success'] is False
    assert 'error' in result


def test_validate_config_returns_error_for_no_recognized_sections():
    result = validate_config({'unknown_key': 'value'})
    assert result['success'] is False
    assert 'error' in result
    assert len(result['error']) > 0


# ---------------------------------------------------------------------------
# 4. Deep merge
# ---------------------------------------------------------------------------

def test_merge_configs_preserves_keys_from_both_and_later_overrides():
    base = {
        'gateway': {'port': 3000, 'host': 'localhost'},
        'memory': {'enabled': True},
    }
    override = {
        'gateway': {'port': 4000},  # overrides port, preserves host
        'agents': {'maxConcurrent': 10},
    }
    result = merge_configs(base, override)

    # Later override wins for shared key
    assert result['gateway']['port'] == 4000
    # Keys from base that are not in override are preserved
    assert result['gateway']['host'] == 'localhost'
    # Keys from base not in override are preserved at top level
    assert result['memory']['enabled'] is True
    # Keys unique to override are present
    assert result['agents']['maxConcurrent'] == 10


# ---------------------------------------------------------------------------
# 5. Env var substitution: ${VAR} replaced
# ---------------------------------------------------------------------------

def test_substitute_env_vars_replaces_known_variable(monkeypatch):
    monkeypatch.setenv('MY_HOST', 'prod.example.com')
    config = {'gateway': {'host': '${MY_HOST}', 'port': 443}}
    result = substitute_env_vars(config)
    assert result['gateway']['host'] == 'prod.example.com'
    assert result['gateway']['port'] == 443  # non-string values unchanged


# ---------------------------------------------------------------------------
# 6. Missing env vars → empty string
# ---------------------------------------------------------------------------

def test_substitute_env_vars_missing_var_becomes_empty_string(monkeypatch):
    # Ensure the variable is not set
    monkeypatch.delenv('MISSING_VAR', raising=False)
    config = {'gateway': {'token': '${MISSING_VAR}'}}
    result = substitute_env_vars(config)
    assert result['gateway']['token'] == ''


# ---------------------------------------------------------------------------
# 6b. ${VAR:-default} — the documented fallback form
#
# The docs site shows `api_key: ${ANTHROPIC_API_KEY:-sk-placeholder}`, but the
# pattern was `\$\{(\w+)\}`, and neither ':' nor '-' is \w. That example matched
# nothing and survived into the config as the literal string, to be rejected
# later as a bad credential rather than at load time. Both runtimes had the same
# gap, so fixing only one would have traded a bug for a parity divergence.
# ---------------------------------------------------------------------------

def test_substitute_env_vars_uses_default_when_unset(monkeypatch):
    monkeypatch.delenv('ABSENT_API_KEY', raising=False)
    config = {'providers': {'api_key': '${ABSENT_API_KEY:-sk-placeholder}'}}
    result = substitute_env_vars(config)
    assert result['providers']['api_key'] == 'sk-placeholder'


def test_substitute_env_vars_prefers_the_variable_over_the_default(monkeypatch):
    monkeypatch.setenv('PRESENT_API_KEY', 'sk-real')
    config = {'providers': {'api_key': '${PRESENT_API_KEY:-sk-placeholder}'}}
    result = substitute_env_vars(config)
    assert result['providers']['api_key'] == 'sk-real'


def test_substitute_env_vars_default_may_contain_punctuation(monkeypatch):
    monkeypatch.delenv('ABSENT_URL', raising=False)
    config = {'providers': {'url': '${ABSENT_URL:-http://localhost:8080/v1}'}}
    result = substitute_env_vars(config)
    assert result['providers']['url'] == 'http://localhost:8080/v1'


def test_substitute_env_vars_empty_variable_is_not_replaced_by_default(monkeypatch):
    # Set but empty is a deliberate value, not an absent one. TypeScript's `??`
    # draws the line in the same place, and the two runtimes have to agree.
    monkeypatch.setenv('EMPTY_API_KEY', '')
    config = {'providers': {'api_key': '${EMPTY_API_KEY:-sk-placeholder}'}}
    result = substitute_env_vars(config)
    assert result['providers']['api_key'] == ''


# ---------------------------------------------------------------------------
# 7. JSON Schema export
# ---------------------------------------------------------------------------

def test_get_config_json_schema_has_all_required_properties():
    schema = get_config_json_schema()
    assert schema['type'] == 'object'
    props = schema['properties']
    for section in ('gateway', 'models', 'agents', 'channels', 'memory', 'cron'):
        assert section in props, f"Missing section '{section}' in schema properties"
        assert 'description' in props[section], (
            f"Section '{section}' missing 'description'"
        )
