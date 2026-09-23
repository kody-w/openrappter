#!/usr/bin/env python3
"""rapp-bubbles: local source entry point; does not import Brainstem or OpenRappter agents."""

from rapp_bubbles.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
