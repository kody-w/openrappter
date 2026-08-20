"""A brace in a description is punctuation, not the end of the manifest.

``js_declared_manifest`` read a manifest block by counting braces and then
matching ``key: value`` per line. Neither step knew what a string was, so the
gate disagreed with JavaScript about what an agent had declared.

Measured against real JavaScript semantics over the 35 shipped JS/TS agents,
**6 were already being misread**: two had a description truncated at an
apostrophe (``Place real phone calls on the owner\\``), two truncated at a
line-continuing ``'a ' + 'b'`` concatenation, and two carried a literal
``\\u2014`` the runtime renders as an em dash.

Constructed-but-valid manifests fared worse, because the failure was not
limited to values:

* ``description: 'Emit } to close.'`` ended the block at the brace inside the
  string. Every field after it vanished and R3 reported the agent "lacks
  ['version', 'capabilities']".
* ``description: 'Emits JSON that starts with {'`` meant the block never
  closed, ``js_declared_manifest`` returned ``None``, and R2 reported the
  agent "carries no rapp-agent/1.0 manifest" — of a file whose manifest the
  runtime loads perfectly.
* A ``// returns { ok: true`` comment *inside* the manifest did the same.
* A nested object hoisted its keys into the manifest, so a nested
  ``capabilities`` overwrote the real one and the gate read a capability list
  the agent had never declared.

The first two directions fail loudly, which is the safe way to be wrong. The
last does not: it makes the gate confidently wrong about what an agent may do.

These tests state the values real JavaScript produces. Where node is present
they also diff the parser against it across every shipped agent, which is the
form that closes the class rather than the six instances.
"""

import json
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import conformance  # noqa: E402


HEAD = """\
export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/demo',
  version: '1.0.0',
"""
TAIL = """\
  capabilities: ['process-exec', 'filesystem-write'],
} as const;
"""


def _parse(tmp_path, middle, tail=TAIL, name="Demo.ts"):
    path = tmp_path / name
    path.write_text(HEAD + middle + tail, encoding="utf-8")
    return conformance.js_declared_manifest(str(path))


# ── values the old line regex truncated or left encoded ──────────────────────

VALUE_CASES = [
    pytest.param(
        r"  description: 'Acts on the owner\'s behalf.'," + "\n",
        "Acts on the owner's behalf.",
        id="escaped-single-quote",
    ),
    pytest.param(
        '  description: "She said \\"go\\" once.",\n',
        'She said "go" once.',
        id="escaped-double-quote",
    ),
    pytest.param(
        r"  description: 'em\u2014dash'," + "\n",
        "em\u2014dash",
        id="unicode-escape-decoded",
    ),
    pytest.param(
        r"  description: 'tab\there'," + "\n",
        "tab\there",
        id="short-escape-decoded",
    ),
    pytest.param(
        "  description: 'first half ' +\n    'second half',\n",
        "first half second half",
        id="concatenation-across-lines",
    ),
    pytest.param(
        "  description: 'Returns {ok: true} on success.',\n",
        "Returns {ok: true} on success.",
        id="balanced-braces-in-string",
    ),
    pytest.param(
        "  description: 'Emit } to close.',\n",
        "Emit } to close.",
        id="close-brace-in-string",
    ),
    pytest.param(
        "  description: 'Emits JSON that starts with {',\n",
        "Emits JSON that starts with {",
        id="open-brace-in-string",
    ),
    pytest.param(
        "  description: 'see [docs] here',\n",
        "see [docs] here",
        id="brackets-in-string",
    ),
    pytest.param(
        "  description: `a template value`,\n",
        "a template value",
        id="template-literal-value",
    ),
]


@pytest.mark.parametrize("middle,expected", VALUE_CASES)
def test_a_value_reads_as_javascript_reads_it(tmp_path, middle, expected):
    man = _parse(tmp_path, middle)
    assert man is not None, "the manifest disappeared entirely"
    assert man["description"] == expected


@pytest.mark.parametrize("middle,_expected", VALUE_CASES)
def test_a_value_never_costs_the_fields_around_it(tmp_path, middle, _expected):
    # The truncating failures dropped whatever followed. R3's required fields
    # are the thing that has to survive.
    man = _parse(tmp_path, middle) or {}
    for key in ("schema", "name", "version", "description", "capabilities"):
        assert key in man, f"{key} was lost while reading the value before it"
    assert man["capabilities"] == ["process-exec", "filesystem-write"]


# ── braces that are not structure ────────────────────────────────────────────

@pytest.mark.parametrize("comment", [
    pytest.param("  // returns { ok: true\n", id="line-comment-open-brace"),
    pytest.param("  // closes with }\n", id="line-comment-close-brace"),
    pytest.param("  /* a { in a block comment */\n", id="block-comment-brace"),
    pytest.param("  // an apostrophe's fine too\n", id="comment-apostrophe"),
])
def test_a_comment_inside_the_manifest_is_not_structure(tmp_path, comment):
    man = _parse(tmp_path, comment)
    assert man is not None, "a comment made the manifest invisible"
    assert man["capabilities"] == ["process-exec", "filesystem-write"]


def test_a_string_element_containing_a_bracket_does_not_end_the_array(tmp_path):
    man = _parse(tmp_path, "  description: 'x',\n",
                 tail="  capabilities: ['process-exec', 'a]b'],\n};\n")
    assert man["capabilities"] == ["process-exec", "a]b"]


# ── nesting, the direction that fails quietly ────────────────────────────────

def test_a_nested_object_does_not_hoist_its_keys(tmp_path):
    man = _parse(tmp_path, "  description: 'x',\n",
                 tail=TAIL.replace("} as const;", "  ui: {\n"
                                   "    label: 'Demo',\n"
                                   "  },\n} as const;"))
    assert man["ui"] == {"label": "Demo"}
    assert "label" not in man, "a nested key was hoisted into the manifest"


def test_a_nested_capabilities_does_not_overwrite_the_declared_one(tmp_path):
    # The quiet failure: last key written won, so a nested list the agent
    # never declared became the list the gate enforced.
    man = _parse(tmp_path, "  description: 'x',\n",
                 tail=TAIL.replace("} as const;", "  examples: {\n"
                                   "    capabilities: [],\n"
                                   "  },\n} as const;"))
    assert man["capabilities"] == ["process-exec", "filesystem-write"]
    assert man["examples"] == {"capabilities": []}


def test_a_quoted_key_is_still_a_key(tmp_path):
    man = _parse(tmp_path, "  description: 'x',\n  'display_name': 'Demo',\n")
    assert man["display_name"] == "Demo"


# ── the shipped agents ───────────────────────────────────────────────────────

def _js_agents():
    return [p for p in conformance.all_agent_files() if not p.endswith(".py")]


def test_there_are_js_agents_to_check():
    # Anti-vacuity: every assertion below is over this list.
    assert len(_js_agents()) >= 10


def test_every_shipped_manifest_parses():
    unread = [str(Path(p).relative_to(conformance.ROOT))
              for p in _js_agents() if conformance.js_declared_manifest(p) is None]
    assert not unread, f"manifest unreadable: {unread}"


def test_no_shipped_value_carries_an_escape_javascript_would_have_decoded():
    # `\u2014` and `\'` reaching a caller mean the value was copied out of the
    # source rather than read as a string.
    bad = []
    for path in _js_agents():
        man = conformance.js_declared_manifest(path) or {}
        for key, value in man.items():
            for text in ([value] if isinstance(value, str) else
                         value if isinstance(value, list) else []):
                if not isinstance(text, str):
                    continue
                if any(e in text for e in ("\\u", "\\x", "\\'", '\\"', "\\\\")):
                    bad.append(f"{Path(path).name}:{key}={text[-40:]!r}")
    assert not bad, "undecoded escapes: " + "; ".join(bad[:4])


def test_no_shipped_value_ends_mid_escape():
    # `'Place real phone calls on the owner\` is what truncation looked like.
    bad = [f"{Path(p).name}:{k}"
           for p in _js_agents()
           for k, v in (conformance.js_declared_manifest(p) or {}).items()
           if isinstance(v, str) and v.endswith("\\")]
    assert not bad, "values truncated at an escape: " + "; ".join(bad[:4])


NODE_DIFF = r"""
const fs = require("fs");
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = {};
for (const [rel, raw] of Object.entries(spec)) {
  try {
    out[rel] = new Function("return (" + raw.replace(/\bas\s+const\s*$/, "") + ")")();
  } catch (e) { out[rel] = null; }
}
process.stdout.write(JSON.stringify(out));
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_every_shipped_manifest_matches_real_javascript(tmp_path):
    """The class-closing form: the parser must agree with the language.

    Six of the thirty-five disagreed before this change.
    """
    blocks, mine = {}, {}
    for path in _js_agents():
        rel = str(Path(path).relative_to(conformance.ROOT))
        body = Path(path).read_text(encoding="utf-8", errors="replace")
        import re
        for m in re.finditer(r"(?m)^\s*(?:export\s+)?(?:const|let|var)?\s*"
                             r"__manifest__\s*[:=]", body):
            if len(re.findall(r"(?<!\\)`", body[:m.start()])) % 2:
                continue
            block = conformance._js_balanced_block(body, m.end())
            if block:
                blocks[rel] = body[block[0]:block[1]]
                mine[rel] = conformance.js_declared_manifest(path)
                break
    assert blocks, "no manifest blocks extracted"

    script = tmp_path / "diff.cjs"
    script.write_text(textwrap.dedent(NODE_DIFF), encoding="utf-8")
    spec = tmp_path / "blocks.json"
    spec.write_text(json.dumps(blocks), encoding="utf-8")
    proc = subprocess.run(["node", str(script), str(spec)],
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    truth = json.loads(proc.stdout)

    divergent = []
    for rel, expected in truth.items():
        if expected is None:
            continue  # node could not evaluate it; nothing to compare against
        got = mine.get(rel) or {}
        for key in set(expected) | set(got):
            if expected.get(key) != got.get(key):
                divergent.append(f"{rel}:{key} js={expected.get(key)!r} "
                                 f"parsed={got.get(key)!r}")
    assert not divergent, "\n".join(divergent[:6])
