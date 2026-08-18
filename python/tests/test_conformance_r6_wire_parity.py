"""R6 has to be able to notice the wire changing.

R6 asserts the brainstem keeps wire parity with the RAPP kernel — the point
being that a client trained against a RAPP brainstem keeps working here. It
checked ``"response" not in body`` for the reply envelope, and ``response`` is
a substring of ``send_response``, a standard ``BaseHTTPRequestHandler`` method.
Renaming every ``"response":`` key in the brainstem left R6 reporting parity.

Renaming the reply field is the exact breakage R6 exists to prevent.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import conformance  # noqa: E402


ROUTES = '''
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            pass
        elif self.path == "/version":
            pass
        elif self.path == "/agents":
            pass
        elif self.path == "/models":
            pass

    def do_POST(self):
        if self.path == "/chat":
            self.send_response(200)
            self.wfile.write(json.dumps({%s}).encode())
'''


@pytest.fixture
def brainstem(tmp_path, monkeypatch):
    def write(body):
        path = tmp_path / "brainstem.py"
        path.write_text(body, encoding="utf-8")
        monkeypatch.setattr(conformance, "BRAINSTEM", str(path))
        return path
    return write


def test_a_faithful_brainstem_passes(brainstem):
    brainstem(ROUTES % '"response": reply')
    ok, detail = conformance.r6_kernel_parity()
    assert ok, detail


def test_send_response_alone_is_not_the_envelope(brainstem):
    # Every route present, `send_response` present, and no reply field at all.
    # This is what R6 used to accept.
    brainstem(ROUTES % '"reply": reply')
    ok, detail = conformance.r6_kernel_parity()
    assert not ok, detail
    assert "response" in detail


def test_a_missing_route_is_caught(brainstem):
    body = ROUTES % '"response": reply'
    brainstem(body.replace('"/models"', '"/model-list"'))
    ok, detail = conformance.r6_kernel_parity()
    assert not ok, detail
    assert "/models" in detail


def test_the_shipped_brainstem_keeps_parity():
    # Anti-vacuity: the rule must not be so strict that the brainstem it ships
    # alongside fails it.
    ok, detail = conformance.r6_kernel_parity()
    assert ok, detail
