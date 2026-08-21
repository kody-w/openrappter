#!/usr/bin/env python3
"""Canonical normalized hashing of a soul.md default.

Single source of truth for "is this soul.md an unmodified historical default?"
Used by:
  * tests/gen_soul_hashes.sh  — to build rapp_brainstem/soul_defaults.sha256
  * test_local_agents.py      — to self-enforce the manifest stays in sync
  * install.sh                — to decide, on upgrade, whether to refresh the soul

The install-time PowerShell path (install.ps1) re-implements the SAME algorithm
natively (Get-FileHash on a normalized temp copy). Keep the two in lock-step; the
normalization below is deliberately trivial and ASCII-only so a .NET string
implementation produces byte-identical results for any valid UTF-8 soul.

Normalization (all steps operate on bytes; every byte touched is < 0x80, so this
is UTF-8 safe and locale-independent):
  1. strip a leading UTF-8 BOM (EF BB BF) — matches .NET File.ReadAllText(UTF8)
  2. CRLF -> LF, then any lone CR -> LF
  3. strip trailing SPACE (0x20) and TAB (0x09) from each line
  4. collapse trailing newlines to exactly one
  5. sha256 of the result, lowercase hex

Why normalize instead of hashing raw bytes: a pristine default can pick up
mechanical drift in transit (Windows CRLF via `irm | iex` or git autocrlf, an
editor's trailing newline, a stray trailing space, a BOM) without a human ever
editing its content. Those variants must still be recognized as "unmodified
default". A real customization changes content and never collides with a default
hash. Anything we cannot confidently normalize simply won't match — and the
installer's rule is: no match => preserve the file untouched.
"""

import hashlib
import sys

_BOM = b"\xef\xbb\xbf"


def normalize(data):
    """Return the canonical normalized bytes for a soul.md payload."""
    if data[:3] == _BOM:
        data = data[3:]
    data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    lines = [ln.rstrip(b" \t") for ln in data.split(b"\n")]
    text = b"\n".join(lines).rstrip(b"\n")
    return text + b"\n"


def normalized_sha256_bytes(data):
    """Normalized SHA-256 (lowercase hex) of an in-memory soul payload."""
    return hashlib.sha256(normalize(data)).hexdigest()


def normalized_sha256(path):
    """Normalized SHA-256 (lowercase hex) of a soul.md file on disk."""
    with open(path, "rb") as fh:
        return normalized_sha256_bytes(fh.read())


def _main(argv):
    # `soul_hash.py FILE` hashes FILE; `soul_hash.py` or `soul_hash.py -` reads stdin.
    if len(argv) > 2:
        sys.stderr.write("usage: soul_hash.py [FILE|-]\n")
        return 2
    if len(argv) == 2 and argv[1] != "-":
        data = open(argv[1], "rb").read()
    else:
        data = sys.stdin.buffer.read()
    sys.stdout.write(normalized_sha256_bytes(data) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
