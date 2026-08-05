"""The Python redactor, and proof it agrees with the TypeScript one.

The word list already had a cross-runtime test. The *walker* did not, which is
how the two came to disagree: TypeScript recursed and Python did not, so a
secret one level down was printed by one runtime and hidden by the other.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

from openrappter.gateway.observability import _redact_fields
from openrappter.security.redact import MAX_REDACT_DEPTH, TOO_DEEP, redact_secrets


def secret(tag: str) -> str:
    """Build the value at runtime; a literal would be rewritten by scanning."""
    return "-".join(["S3CR3T", tag, "v1"])


class TestGatewayFields:
    def test_a_secret_nested_in_a_dict_does_not_reach_the_log(self):
        value = secret("nested")
        out = repr(_redact_fields({"context": {"api_key": value}, "status": 200}))
        assert value not in out

    def test_a_secret_inside_a_list_does_not_reach_the_log(self):
        value = secret("listed")
        out = repr(_redact_fields({"items": [{"api_key": value}]}))
        assert value not in out

    def test_flat_secrets_are_still_caught(self):
        value = secret("flat")
        out = _redact_fields({"api_key": value, "status": 200})
        assert out["api_key"] == "[REDACTED]"

    def test_ordinary_fields_stay_readable(self):
        # Without this, redacting everything would satisfy the tests above.
        out = _redact_fields(
            {"host": "127.0.0.1", "port": 18790, "outcome": "success", "duration_ms": 4.2}
        )
        assert out == {
            "host": "127.0.0.1",
            "port": 18790,
            "outcome": "success",
            "duration_ms": 4.2,
        }


class TestDepthLimit:
    def test_it_does_not_pass_through_a_structure_it_never_inspected(self):
        value = secret("deep")
        node = {"api_key": value}
        for _ in range(MAX_REDACT_DEPTH + 4):
            node = {"child": node}

        assert value not in repr(redact_secrets(node))

    def test_it_marks_where_it_stopped(self):
        node = {"leaf": 1}
        for _ in range(MAX_REDACT_DEPTH + 4):
            node = {"child": node}

        assert TOO_DEEP in repr(redact_secrets(node))

    def test_everything_within_reach_is_still_redacted(self):
        value = secret("shallow")
        node = {"api_key": value}
        for _ in range(5):
            node = {"child": node}

        rendered = repr(redact_secrets(node))
        assert value not in rendered
        assert TOO_DEEP not in rendered


class TestSecretNameCoversWhatItHolds:
    @pytest.mark.parametrize(
        "payload",
        [
            {"api_key": {"raw": secret("obj")}},
            {"api_key": [secret("arr")]},
        ],
        ids=["object value", "list value"],
    )
    def test_a_secret_name_covers_a_structured_value(self, payload):
        rendered = repr(redact_secrets(payload))
        assert "S3CR3T" not in rendered

    def test_a_non_string_scalar_under_a_secret_name_is_redacted(self):
        assert redact_secrets({"api_key": 1234567890})["api_key"] == "***REDACTED***"

    def test_an_absent_secret_is_left_alone_rather_than_invented(self):
        out = redact_secrets({"api_key": "", "token": None})
        assert out["api_key"] == ""
        assert out["token"] is None


TS_REDACT = (
    Path(__file__).resolve().parents[2] / "typescript" / "src" / "security" / "redact.ts"
)


class TestRuntimeAgreement:
    """The two walkers must make the same decisions, not merely exist."""

    def test_the_typescript_walker_shares_the_limit_and_the_marker(self):
        source = TS_REDACT.read_text(encoding="utf-8")

        match = re.search(r"MAX_REDACT_DEPTH = (\d+)", source)
        assert match, "TypeScript no longer declares MAX_REDACT_DEPTH"
        assert int(match.group(1)) == MAX_REDACT_DEPTH, (
            "the runtimes would stop recursing at different depths"
        )
        assert f"'{TOO_DEEP}'" in source, "the runtimes would mark the cut differently"

    @pytest.mark.skipif(
        not (TS_REDACT.parents[2] / "node_modules" / ".bin" / "tsx").exists(),
        reason="TypeScript toolchain not installed",
    )
    def test_both_runtimes_redact_the_same_cases(self, tmp_path):
        cases = {
            "flat": {"api_key": secret("a"), "port": 18790},
            "nested": {"context": {"api_key": secret("b")}},
            "in a list": {"items": [{"api_key": secret("c")}]},
            "object value": {"api_key": {"raw": secret("d")}},
            "readable": {"host": "127.0.0.1", "key_count": 7, "public_key": "ssh-x"},
        }

        ts_root = TS_REDACT.parents[2]
        script = tmp_path / "agree.ts"
        script.write_text(
            "import { redactSecrets } from "
            f"'{TS_REDACT.with_suffix('.js')}';\n"
            "const cases = JSON.parse(process.argv[2]);\n"
            "const out: Record<string, unknown> = {};\n"
            "for (const [name, value] of Object.entries(cases)) "
            "out[name] = redactSecrets(value);\n"
            "console.log(JSON.stringify(out));\n",
            encoding="utf-8",
        )

        result = subprocess.run(
            [str(ts_root / "node_modules" / ".bin" / "tsx"), str(script), json.dumps(cases)],
            capture_output=True,
            text=True,
            cwd=ts_root,
        )
        assert result.returncode == 0, result.stderr

        typescript = json.loads(result.stdout)
        python = {name: redact_secrets(value) for name, value in cases.items()}
        assert typescript == python
