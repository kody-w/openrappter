"""The config vocabulary both runtimes have to share.

TypeScript's Zod schema declared 21 top-level sections; this validator required
one of six and rejected everything else, so a file holding only `logging` or
only `security` was valid there and refused here. Nothing compared the two.

contracts/config-sections.json is the pin. The equivalent TypeScript test is
typescript/src/__tests__/integration/config-section-parity.test.ts.
"""

import json
from pathlib import Path

from openrappter.config.schema import RECOGNIZED_SECTIONS, validate_config

CONTRACT = (
    Path(__file__).resolve().parents[2] / 'contracts' / 'config-sections.json'
)


def _contract_sections():
    return set(json.loads(CONTRACT.read_text())['sections'])


def test_contract_file_is_present_and_populated():
    # Guards the loader: an empty or missing contract would make the comparison
    # below pass against nothing.
    sections = _contract_sections()
    assert len(sections) >= 20
    assert 'gateway' in sections


def test_recognized_sections_match_the_contract():
    assert RECOGNIZED_SECTIONS == _contract_sections()


def test_a_logging_only_config_is_accepted():
    # The concrete case that failed: valid in TypeScript, rejected here.
    result = validate_config({'logging': {'level': 'debug'}})
    assert result['success'] is True


def test_a_security_only_config_is_accepted():
    result = validate_config({'security': {'approvalPolicy': 'deny'}})
    assert result['success'] is True


def test_a_config_with_no_recognized_section_is_still_rejected():
    result = validate_config({'nonsense': True})
    assert result['success'] is False
    assert 'recognized section' in result['error']
