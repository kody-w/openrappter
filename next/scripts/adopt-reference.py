"""Extract exact, public canonical authority/checker bytes; no network or source writes."""
import hashlib
import json
import pathlib
import subprocess
import sys

COMMIT = "dda32d741c7218f41443a5bd17eebfe0eae82cb7"
HEAD = "83ca275f35cca96e43d75c99d338326c1a39b2240eabf57eb7c29ac96cc90818"


def main():
    source = pathlib.Path(sys.argv[1]).resolve()
    destination = pathlib.Path("vendor/rapp1").resolve()
    if pathlib.Path.cwd().name != "next" or destination.exists():
        raise SystemExit("Run once from next/ with an absent vendor/rapp1 destination")
    files = [
        "LICENSE", "rapp.py", "rapp_check.py", "rapp_registry.py",
        "anchor/bootstrap_verify.py", "anchor/chain.jsonl", "anchor/index.json",
        "anchor/bootstrap/index.json",
        "anchor/bootstrap/sha256-1666e44acf532f854d4bf74868c9af9f9b362055692189ac858a7c8b52dcd5bb.json",
    ]
    records = {}
    for name in files:
        data = subprocess.check_output(["git", "-C", str(source), "show", f"{COMMIT}:{name}"])
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        records[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    index = json.loads((destination / "anchor/index.json").read_bytes())
    if index["head"]["revision"] != "rev-15" or index["head"]["frame_hash"] != HEAD:
        raise SystemExit("Unexpected authority")
    (destination / "adoption.json").write_text(json.dumps({
        "repository": "https://github.com/kody-w/rapp-1",
        "commit": COMMIT,
        "head": index["head"],
        "files": records,
        "rule": "Unmodified public Apache-2.0 reference bytes. Not an application protocol.",
    }, indent=2) + "\n")
    print(json.dumps({"commit": COMMIT, "files": len(records), "head": HEAD}))


if __name__ == "__main__":
    main()
