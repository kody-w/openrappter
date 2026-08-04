"""The suite must say why an unsupported interpreter cannot run it.

macOS ships 3.9 as ``/usr/bin/python3``. Running ``pytest tests/`` there used to
fail with

    RuntimeError: There is no current event loop in thread 'MainThread'.

raised from ``GatewayServer.__init__`` — which reads like a gateway bug. It is
not one: ``asyncio.Lock`` bound a loop at construction before 3.10. The failure
was also order-dependent (the file passes 31/31 alone, fails in a full run), so
it sent you hunting a race that does not exist. It cost real time before anyone
thought to check the interpreter.
"""

import re
import sys
from pathlib import Path

from tests.conftest import MIN_PYTHON, unsupported_python_message


class TestUnsupportedPythonMessage:
    def test_supported_versions_produce_no_message(self):
        for version in [(3, 10, 0), (3, 11, 4), (3, 12, 1), (3, 13, 0), (4, 0, 0)]:
            assert unsupported_python_message(version) is None, version

    def test_unsupported_versions_produce_a_message(self):
        for version in [(3, 9, 6), (3, 8, 10), (2, 7, 18)]:
            assert unsupported_python_message(version) is not None, version

    def test_the_message_names_both_versions_and_the_interpreter(self):
        message = unsupported_python_message((3, 9, 6), "/usr/bin/python3")
        assert "3.9.6" in message
        assert "3.10" in message
        assert "/usr/bin/python3" in message

    def test_the_message_names_the_real_cause_not_the_symptom(self):
        """The whole point is to stop the next person debugging the gateway."""
        message = unsupported_python_message((3, 9, 6))
        assert "asyncio.Lock" in message
        assert "event loop" in message

    def test_macos_gets_the_system_python_hint(self):
        message = unsupported_python_message((3, 9, 6), platform="darwin")
        assert "/usr/bin/python3" in message
        assert "brew" in message

    def test_other_platforms_do_not_get_the_macos_hint(self):
        message = unsupported_python_message((3, 9, 6), "python3", platform="linux")
        assert "brew" not in message

    def test_the_boundary_is_exactly_the_declared_minimum(self):
        assert unsupported_python_message((MIN_PYTHON[0], MIN_PYTHON[1] - 1, 0)) is not None
        assert unsupported_python_message(MIN_PYTHON) is None


class TestMinimumStaysInSyncWithPackaging:
    def test_min_python_matches_requires_python(self):
        """A guard that disagrees with pyproject would block a supported version."""
        pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(
            encoding="utf-8"
        )
        match = re.search(r'requires-python\s*=\s*"\s*>=\s*([0-9]+)\.([0-9]+)', pyproject)
        assert match is not None, "requires-python not found in pyproject.toml"
        assert (int(match.group(1)), int(match.group(2))) == MIN_PYTHON

    def test_the_running_interpreter_satisfies_the_minimum(self):
        """If this fails, the guard let something through that it should not have."""
        assert sys.version_info >= MIN_PYTHON
