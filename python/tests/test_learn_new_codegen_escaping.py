"""Generated agent source must be escaped for the context it lands in.

LearnNewAgent writes a Python module from a description a user supplies in an
ordinary "create an agent that ..." request. That text was interpolated into
the generated source twice without being encoded for either position.

Both reproduced before this file existed:

  1. A triple quote in the description closed the module docstring, and
     everything after it became module-level code that ran on import. The
     module compiled cleanly, so nothing downstream had reason to object.

  2. The metadata description escaped quotes and *then* sliced to 200
     characters, which can cut between a backslash and the character it
     escapes. Python's own diagnostic named it:

         unterminated string literal ... perhaps you escaped the end quote?

The TypeScript runtime had the identical pair (openrappter#59); fixing one and
not the other would have left the two bodies disagreeing about what a
description may contain.
"""

import json
import os

import pytest

from openrappter.agents.learn_new_agent import (
    LearnNewAgent,
    docstring_safe,
    py_string_literal,
)


@pytest.fixture
def generate():
    agent = LearnNewAgent()

    def _generate(description: str) -> str:
        return agent._generate_agent_code(description, 'demo', 'DemoAgent')

    return _generate


def _compiles(source: str):
    try:
        compile(source, '<generated>', 'exec')
        return True, ''
    except SyntaxError as exc:
        return False, f'{exc.msg} (line {exc.lineno})'


class TestGeneratedSourceIsEscaped:
    def test_a_triple_quote_cannot_close_the_docstring_and_run_as_code(self, generate):
        source = generate('x """\nimport os\nos.environ["LEARN_NEW_PWNED"]="yes"\n"""  y')
        os.environ.pop('LEARN_NEW_PWNED', None)

        exec(compile(source, '<generated>', 'exec'), {})

        assert os.environ.get('LEARN_NEW_PWNED') is None

    def test_the_docstring_still_carries_the_text(self, generate):
        """A fix that simply dropped the description would also pass the test above."""
        source = generate('before """ after')
        header = source.splitlines()[1]

        assert 'before' in header
        assert 'after' in header

    @pytest.mark.parametrize('label,description', [
        ('trailing backslash', 'ends with a backslash \\'),
        ('escape cut at the truncation boundary', 'A' * 199 + '"' + 'B' * 20),
        ('embedded newlines and quotes', 'line1\n"quoted"\nline2'),
        ('control characters', 'tab\there\x00null'),
        ('a lone double quote', 'say "hi"'),
        ('a backslash-u sequence', 'literal \\u0041 text'),
        ('braces', 'uses {curly} braces {{doubled}}'),
    ])
    def test_generates_compilable_source(self, generate, label, description):
        ok, error = _compiles(generate(description))
        assert ok, f'{label}: {error}'

    def test_generated_source_compiles_without_warnings(self, generate):
        """A docstring is a string literal, so Python processes escapes in it.

        The first version of the fix escaped the terminator but not backslashes,
        which compiled but emitted `SyntaxWarning: invalid escape sequence` from
        the generated module. Warning-free is the property; compiling is not
        enough.
        """
        import warnings

        for description in [
            'a path C:\\temp\\new and a trailing one \\',
            'has "quotes" and a backslash \\ and unicode \u00e9',
            'null\x00byte and \x07bell',
        ]:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter('always')
                compile(generate(description), '<generated>', 'exec')
            assert caught == [], f'{description!r} -> {[str(w.message) for w in caught]}'

    def test_the_metadata_description_survives_as_the_original_text(self, generate):
        description = 'has "quotes" and a backslash \\ and unicode é'
        source = generate(description)

        namespace = {}
        exec(compile(source, '<generated>', 'exec'), namespace)
        agent = namespace['DemoAgent']()

        assert agent.metadata['description'] == description


class TestPyStringLiteral:
    @pytest.mark.parametrize('value', [
        'plain', 'say "hi"', 'back\\slash', 'new\nline', 'nul\x00', 'emoji 😀', '{braces}',
    ])
    def test_round_trips_through_python_and_json(self, value):
        assert json.loads(py_string_literal(value)) == value
        assert eval(py_string_literal(value)) == value  # noqa: S307 - generated literal

    def test_truncates_before_encoding_so_escaping_is_never_cut(self):
        literal = py_string_literal('A' * 199 + '"BBBB', 200)

        assert len(eval(literal)) == 200  # noqa: S307
        assert eval(literal).endswith('"')  # noqa: S307


class TestDocstringSafe:
    def test_neutralises_the_docstring_terminator(self):
        assert '"""' not in docstring_safe('a """ b')

    def test_flattens_newlines_so_the_body_cannot_escape(self):
        assert docstring_safe('a\nb\r\nc') == 'a b c'

    def test_leaves_ordinary_text_alone(self):
        assert docstring_safe('a normal description') == 'a normal description'
