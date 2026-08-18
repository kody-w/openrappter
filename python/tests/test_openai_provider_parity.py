"""The two runtimes must default to the same OpenAI model.

`providers/openai.ts` and `providers/openai_compatible.py` describe the same
provider against the same endpoint. They defaulted to different models —
`gpt-4o` and `gpt-4o-mini` — which differ in both cost and capability, so the
same call answered from a different model depending on which runtime you asked.

Neither value was written down anywhere, and nothing compared them. The grail
brainstem settles which is right: its default and its safety net are both
`gpt-4o`, and TypeScript matched it. For contrast the Copilot provider already
agreed across runtimes on `gpt-4.1`, which is what a decision looks like next to
drift. #276

Read out of the TypeScript source rather than duplicated here, so this fails if
either side moves alone.
"""

import re
from pathlib import Path

from openrappter.providers.openai_compatible import DEFAULT_BASE_URL, DEFAULT_MODEL

TS_PROVIDER = (
    Path(__file__).resolve().parents[2] / 'typescript' / 'src' / 'providers' / 'openai.ts'
)


def _ts_const(name):
    source = TS_PROVIDER.read_text(encoding='utf-8')
    match = re.search(rf'const {name}\s*=\s*[\'"]([^\'"]+)[\'"]', source)
    assert match, f'{name} not found in {TS_PROVIDER.name}'
    return match.group(1)


def test_the_typescript_provider_is_readable():
    # Guards the reader: a regex that matched nothing would make the comparisons
    # below pass against an empty string.
    assert TS_PROVIDER.exists()
    assert _ts_const('DEFAULT_MODEL').startswith('gpt-')


def test_default_model_matches_typescript():
    assert DEFAULT_MODEL == _ts_const('DEFAULT_MODEL')


def test_default_base_url_matches_typescript():
    # The constant is spelled `OPENAI_API_URL` on that side. The names differ,
    # the values must not.
    assert DEFAULT_BASE_URL == _ts_const('OPENAI_API_URL')
