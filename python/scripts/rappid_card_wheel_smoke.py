#!/usr/bin/env python3
"""Install a directly built wheel and prove lazy/core/card imports."""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import venv


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheel", required=True)
    parser.add_argument("--work-dir", required=True)
    args = parser.parse_args()

    root = pathlib.Path(args.work_dir).resolve()
    shutil.rmtree(root, ignore_errors=True)
    venv.EnvBuilder(with_pip=True).create(root)
    python = root / "bin" / "python"
    openrappter = root / "bin" / "openrappter"
    run([str(python), "-m", "pip", "install", "--quiet", args.wheel])

    package = pathlib.Path(
        subprocess.check_output(
            [
                str(python),
                "-c",
                "import openrappter.rappid_card as c; print(c.__path__[0])",
            ],
            text=True,
        ).strip()
    )
    vectors = package / "test_vectors"
    hidden = package / "test_vectors.hidden"
    vectors.rename(hidden)
    try:
        run([str(python), "-c", "import openrappter; import openrappter.rappid_card"])
        run([str(openrappter), "--help"], stdout=subprocess.DEVNULL)
        run([str(openrappter), "rappid-card", "--help"], stdout=subprocess.DEVNULL)
    finally:
        hidden.rename(vectors)

    run(
        [
            str(python),
            "-c",
            (
                "from openrappter.rappid_card import load_rappid_card_deck; "
                "assert len(load_rappid_card_deck()['vectors']) == 63"
            ),
        ]
    )
    shutil.rmtree(root)


if __name__ == "__main__":
    main()
