"""Detached Show-and-Tell context collector entry point."""

import sys

from openrappter.show_and_tell import run_collector


def main() -> int:
    if len(sys.argv) != 4:
        print(
            "Show-and-Tell collector requires root, session id, and nonce.",
            file=sys.stderr,
        )
        return 2
    run_collector(sys.argv[1], sys.argv[2], sys.argv[3])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
