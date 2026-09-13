"""Exact upstream checker, with its existing detached-JWS verifier dependency supplied."""
import base64
import hashlib
import importlib.util
import json
import pathlib
import sys

BASE = pathlib.Path(__file__).resolve().parents[1]
VENDOR = BASE / "vendor/rapp1"
COMMIT = "dda32d741c7218f41443a5bd17eebfe0eae82cb7"
HEAD = "83ca275f35cca96e43d75c99d338326c1a39b2240eabf57eb7c29ac96cc90818"


def main():
    manifest = json.loads((VENDOR / "adoption.json").read_bytes())
    assert manifest["commit"] == COMMIT and manifest["head"]["frame_hash"] == HEAD
    for name, record in manifest["files"].items():
        data = (VENDOR / name).read_bytes()
        assert len(data) == record["bytes"] and hashlib.sha256(data).hexdigest() == record["sha256"], name
    spec = importlib.util.spec_from_file_location("bootstrap", VENDOR / "anchor/bootstrap_verify.py")
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    profile_path = VENDOR / "anchor/bootstrap/sha256-1666e44acf532f854d4bf74868c9af9f9b362055692189ac858a7c8b52dcd5bb.json"
    profile = bootstrap.verify_profile(profile_path.read_bytes(), (VENDOR / "anchor/bootstrap_verify.py").read_bytes())
    chain = bootstrap.verify_chain((VENDOR / "anchor/chain.jsonl").read_bytes(), profile)
    assert len(chain) == 16 and chain[-1]["frame_hash"] == HEAD
    sys.path.insert(0, str(VENDOR))
    import rapp as reference
    import rapp_check as checker

    root = pathlib.Path(sys.argv[1]).resolve()
    registry = json.loads(pathlib.Path(sys.argv[2]).read_bytes()) if len(sys.argv) > 2 else []
    keys = {item["kid"]: item for item in registry}

    def verify_signature(value, signature):
        header, _, _ = reference.parse_detached_jws(signature)
        key = keys.get(header["kid"])
        if key is None:
            return False, "Signer is not in the explicitly selected fixture registry"
        for lifecycle in ("revoked_utc", "superseded_utc"):
            if key[lifecycle] is not None and value["utc"] >= key[lifecycle]:
                return False, "Key is revoked or superseded"
        unsigned = {name: entry for name, entry in value.items() if name != "sig"}
        return reference.verify_detached_jws(unsigned, signature, base64.b64decode(key["spki_der_b64"]), header["kid"])

    # The upstream checker has no registry CLI option. Its existing reference
    # verifier callback is supplied here; neither checker nor verifier bytes change.
    original = reference.verify_frame

    def bound_verify(frame, head=None, stream_id_of_record=None, signature_verifier=None):
        return original(frame, head, stream_id_of_record, signature_verifier or verify_signature)

    reference.verify_frame = bound_verify
    verdict, findings, evidence = checker.check_repo(str(root))
    frames = list(root.glob("**/frames/[0-9]*.json"))
    assert frames, "A zero-artifact CLEAN verdict is not conformance evidence"
    assert verdict == "COMPLIANT" and not findings, (verdict, findings)
    print(json.dumps({
        "checkerCommit": COMMIT, "authorityHead": HEAD, "authorityFrames": len(chain),
        "verdict": verdict, "framesScanned": len(frames),
        "signedFrames": sum(json.loads(f.read_bytes())["sig"] is not None for f in frames),
        "streamsScanned": len({f.parent for f in frames}), "findings": findings, "evidence": evidence,
    }, indent=2))


if __name__ == "__main__":
    main()
