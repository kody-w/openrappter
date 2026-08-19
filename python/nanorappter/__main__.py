"""Entry point for `python3 -m nanorappter`.

Both the module docstring and the CLI's own help text advertise
`python3 -m nanorappter status`. Without this file that command fails with
"No module named nanorappter.__main__" -- the `if __name__ == "__main__"`
guard in __init__.py only fires for `python3 nanorappter/__init__.py`, which
is not what anything documents.
"""
from . import _main

_main()
