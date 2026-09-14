"""Independent canonical RAPP/1 digest check; reads replay/source evidence only."""
import json
import pathlib
import sys

BASE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "vendor/rapp1"))
import rapp as R


def main():
    pages = json.loads(pathlib.Path(sys.argv[1]).read_bytes())
    frames = {}
    for directory in sys.argv[2:]:
        for filename in pathlib.Path(directory).glob("**/frames/[0-9]*.json"):
            frame = json.loads(filename.read_bytes())
            frames[frame["frame_hash"]] = frame
    checkpoints = 0
    guest_checkpoints = 0
    for page in pages:
        expected = page["timelineDigest"]
        payload = {key: value for key, value in page.items() if key != "timelineDigest"}
        assert R.H("rapp/1:particle", payload) == expected
        for point in [page["baseline"], *page["steps"]]:
            if point["state"] is None:
                assert point["stateDigest"] is None
            else:
                assert R.H("rapp/1:particle", point["state"]) == point["stateDigest"]
                checkpoints += 1
            for source in point["sourceFrameHashes"]:
                assert source in frames, f"Missing exact source frame {source}"
            if point.get("guest") is not None:
                assert R.H("rapp/1:particle", point["guest"]) == point["guestDigest"]
                guest_checkpoints += 1
    print(json.dumps({
        "verifier": "unmodified canonical rapp.py H(rapp/1:particle, value)",
        "pages": len(pages), "stateCheckpoints": checkpoints,
        "guestCheckpoints": guest_checkpoints, "sourceFrames": len(frames),
        "digestsVerified": True, "sourceReferencesVerified": True,
        "writes": 0, "modelCalls": 0, "toolExecutions": 0,
    }, indent=2))


if __name__ == "__main__":
    main()
