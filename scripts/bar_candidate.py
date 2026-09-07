#!/usr/bin/env python3
"""Bind the native Bar, its download, and a cask proposal to candidate bytes."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
import urllib.request
import bar_runtime
import bar_runtime_chunks as chunks

REPOSITORY = "kody-w/openrappter"
AUTHORITY = "kody-w/openrappter-release-train"
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
FILENAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,180}")
MAX_BUNDLE = 1024 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def identity(commit, version):
    require(isinstance(commit, str) and HEX40.fullmatch(commit), "source commit must be exact")
    require(isinstance(version, str) and VERSION.fullmatch(version), "Bar version must be X.Y.Z")


def regular(root, name):
    require(isinstance(name, str) and FILENAME.fullmatch(name), "unsafe candidate filename")
    file = root / name
    require(file.is_file() and not file.is_symlink(), f"missing regular artifact: {name}")
    return file


def write_json(file, value):
    file.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def record(root, commit, version, notary, parts_root=None):
    identity(commit, version)
    require(notary.get("status") == "Accepted", "notarization must be Accepted")
    require(re.fullmatch(r"[0-9a-fA-F-]{36}", notary.get("id", "")), "missing notarization submission")
    bar_runtime.verify_bootstrap(root, commit, version, parts_root=parts_root)
    name = f"OpenRappter-Bar-{version}.dmg"
    dmg = regular(root, name)
    require(dmg.stat().st_size > 0, "empty DMG")
    sha = digest(dmg.read_bytes())
    value = {
        "schema": "openrappter-bar-candidate/v1",
        "source_commit": commit,
        "version": version,
        "release_tag": f"v{version}-bar",
        "architectures": ["arm64", "x86_64"],
        "dmg": {"name": name, "sha256": sha, "size": dmg.stat().st_size},
        "notarization": {"id": notary["id"], "status": "Accepted"},
    }
    (root / f"{name}.sha256").write_text(f"{sha}  {name}\n")
    write_json(root / "macos-bar.json", value)
    return value


def verify(root, commit, version, expected_sha=None, parts_root=None):
    identity(commit, version)
    value = json.loads(regular(root, "macos-bar.json").read_text())
    require(set(value) == {"schema", "source_commit", "version", "release_tag", "architectures", "dmg", "notarization"}, "Bar manifest is not closed")
    require(value["schema"] == "openrappter-bar-candidate/v1", "wrong Bar schema")
    require(value["source_commit"] == commit and value["version"] == version and value["release_tag"] == f"v{version}-bar", "Bar identity mismatch")
    require(value["architectures"] == ["arm64", "x86_64"], "Bar must be universal")
    require(set(value["notarization"]) == {"id", "status"} and value["notarization"]["status"] == "Accepted", "Bar notarization rejected")
    require(re.fullmatch(r"[0-9a-fA-F-]{36}", value["notarization"]["id"]), "missing notarization submission")
    name = f"OpenRappter-Bar-{version}.dmg"
    artifact = value["dmg"]
    require(set(artifact) == {"name", "sha256", "size"} and artifact["name"] == name, "wrong DMG identity")
    require(isinstance(artifact["sha256"], str) and HEX64.fullmatch(artifact["sha256"]), "invalid DMG digest")
    dmg = regular(root, name)
    require(type(artifact["size"]) is int and dmg.stat().st_size == artifact["size"] and artifact["size"] > 0, "DMG size mismatch")
    require(digest(dmg.read_bytes()) == artifact["sha256"], "DMG checksum mismatch")
    require(expected_sha is None or expected_sha == artifact["sha256"], "DMG differs from constitution-checked artifact")
    require(regular(root, f"{name}.sha256").read_text() == f"{artifact['sha256']}  {name}\n", "DMG checksum sidecar mismatch")
    bar_runtime.verify_bootstrap(root, commit, version, parts_root=parts_root)
    return value


def verify_payload(root, commit, version, expected_sha=None, parts_root=None):
    value = verify(root, commit, version, expected_sha, parts_root)
    provenance = json.loads(regular(root, "provenance.json").read_text())
    require(provenance.get("schema") == "openrappter-candidate-provenance/v1" and provenance.get("channel") == "candidate" and provenance.get("stable") is False, "wrong candidate provenance")
    require(provenance.get("source_repository") == REPOSITORY and provenance.get("source_commit") == commit and provenance.get("source_tag") is None, "candidate source identity mismatch")
    candidate_id = "tag-" + base64.urlsafe_b64encode(f"v{version}".encode()).decode().rstrip("=")
    require(provenance.get("candidate_kind") == "release" and provenance.get("candidate_id") == candidate_id and provenance.get("intended_release_tag") == f"v{version}", "Bar requires an intended release candidate, not a snapshot")
    versions = provenance.get("versions", {})
    require(set(versions) == {"npm", "pypi", "runtime", "channel"} and versions["npm"] == version, "candidate version identities mismatch")
    require(all(isinstance(v, str) and v for v in versions.values()), "incomplete candidate versions")
    rows = provenance.get("files", [])
    require(isinstance(rows, list) and rows, "missing candidate file provenance")
    names = set()
    for row in rows:
        require(isinstance(row, dict) and set(row) == {"path", "sha256"}, "invalid candidate file record")
        name = row["path"]
        require(name not in names and name not in {"provenance.json", "SHA256SUMS"}, "duplicate/self-referential candidate file")
        names.add(name)
        require(bar_runtime.file_sha(regular(root, name)) == row["sha256"], f"candidate bytes changed: {name}")
    require({"macos-bar.json", value["dmg"]["name"], value["dmg"]["name"] + ".sha256", "install.sh", "install.ps1"} <= names, "Bar/installers missing from promoted provenance")
    require({bar_runtime.METADATA, bar_runtime.HELPER} <= names, "sealed bootstrap resources missing from promoted provenance")
    for architecture in bar_runtime.ARCHITECTURES:
        file = bar_runtime.runtime_filename(version, architecture)
        require(len(names.intersection({file, file + ".parts.json"})) == 1,
                "both sealed bootstrap resources and runtimes require exactly one direct archive or descriptor in provenance")
    require(not any(name.endswith(".part") for name in names), "runtime parts must be siblings outside the outer candidate")
    require(f"openrappter-{version}.tgz" in names and any(n.endswith(".whl") for n in names)
            and f"openrappter-{versions['pypi']}.tar.gz" in names, "canonical package candidate bytes are required")
    require({p.name for p in root.iterdir()} == names | {"provenance.json", "SHA256SUMS"}, "unlisted candidate files")
    checks = {}
    for line in regular(root, "SHA256SUMS").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,180})", line)
        require(match and match[2] not in checks, "invalid candidate checksum manifest")
        checks[match[2]] = match[1]
    require(set(checks) == names | {"provenance.json"}, "incomplete candidate checksums")
    for name, sha in checks.items():
        require(bar_runtime.file_sha(regular(root, name)) == sha, f"candidate checksum mismatch: {name}")
    return value


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def resolve_identity(commit, version, fetch=fetch_json):
    identity(commit, version)
    base = f"https://raw.githubusercontent.com/{AUTHORITY}"
    head = fetch(f"{base}/main/heads/beta.json")
    require(head.get("schema") == "openrappter-ring-head/v1" and head.get("ring") == "beta" and head.get("target_repository") == "kody-w/openrappter-beta", "wrong beta authority head")
    require(HEX40.fullmatch(head.get("authority_commit", "")) and HEX40.fullmatch(head.get("target_manifest_commit", "")), "mutable authority reference")
    promotion_id = head.get("promotion_id", "")
    require(HEX64.fullmatch(promotion_id) and head.get("receipt_path") == f"receipts/beta/{promotion_id}.json", "invalid receipt location")
    receipt_url = f"{base}/{head['authority_commit']}/{head['receipt_path']}"
    receipt = fetch(receipt_url)
    manifest = fetch(f"https://raw.githubusercontent.com/kody-w/openrappter-beta/{head['target_manifest_commit']}/.ring/manifest.json")
    require(canonical(receipt) == head.get("receipt_sha256") and canonical(manifest) == head.get("target_manifest_sha256"), "authority digest mismatch")
    require(receipt.get("schema") == "openrappter-promotion-receipt/v1" and receipt.get("receipt_kind") == "promotion" and receipt.get("promotion_id") == promotion_id, "beta is not finalized")
    require(receipt.get("target_manifest_commit") == head["target_manifest_commit"] and receipt.get("target_manifest_sha256") == head["target_manifest_sha256"], "receipt target mismatch")
    require(manifest.get("status") == "published", "beta is not published")
    require(receipt.get("source_repository") == REPOSITORY and receipt.get("source_commit") == commit and receipt.get("version") == version and receipt.get("source_tag") is None, "receipt source identity mismatch")
    require(receipt.get("intended_release_tag") == f"v{version}" and receipt.get("artifact_provenance") == "github-candidate-bundle-sha256", "not a release candidate")
    sha = receipt.get("artifact_sha256", "")
    candidate_id = "tag-" + base64.urlsafe_b64encode(f"v{version}".encode()).decode().rstrip("=")
    pattern = rf"https://raw\.githubusercontent\.com/kody-w/openrappter/[0-9a-f]{{40}}/candidates/{commit}/release/{candidate_id}/{sha}\.tar\.gz"
    require(HEX64.fullmatch(sha) and re.fullmatch(pattern, receipt.get("artifact_url", "")) and receipt.get("install_url") == receipt["artifact_url"], "untrusted candidate URL")
    release = {key: receipt[key] for key in ("source_commit", "version", "intended_release_tag", "channel_version", "artifact_url", "install_url", "artifact_sha256", "artifact_provenance")}
    release.update(schema="openrappter-release/v1", mode="normal", source_tag=f"v{version}-bar", rollback_receipt=None)
    return release, {"head": head, "receipt": receipt, "manifest": manifest, "receipt_url": receipt_url}


def extract(bundle, destination, sha):
    require(bar_runtime.file_sha(bundle) == sha, "candidate bundle checksum mismatch")
    require(not destination.exists(), "candidate destination must not exist")
    with tarfile.open(bundle, "r:gz") as archive:
        members = []
        names = set()
        total = 0
        for member in archive.getmembers():
            if member.name in {".", "./"} and member.isdir():
                continue
            name = member.name.removeprefix("./")
            require(member.isfile() and FILENAME.fullmatch(name) and name not in names, "candidate archive must contain unique flat regular files")
            names.add(name)
            total += member.size
            require(total <= MAX_BUNDLE and len(names) <= 256, "candidate archive exceeds limits")
            members.append((member, name))
        destination.mkdir(parents=True)
        for member, name in members:
            with archive.extractfile(member) as source, (destination / name).open("xb") as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)


def materialize(output, commit, version):
    release, evidence = resolve_identity(commit, version)
    output.mkdir(parents=True, exist_ok=False)
    bundle = output / "candidate.tar.gz"
    with urllib.request.urlopen(release["artifact_url"], timeout=120) as source, bundle.open("xb") as target:
        total = 0
        while chunk := source.read(1024 * 1024):
            total += len(chunk)
            require(total <= MAX_BUNDLE, "candidate download exceeds limit")
            target.write(chunk)
    extract(bundle, output / "release-dist", release["artifact_sha256"])
    root = output / "release-dist"
    parts_root = output / "candidate-parts"
    parts_root.mkdir()
    metadata = bar_runtime.bootstrap_metadata(root, commit, version)
    for architecture, variant in metadata["variants"].items():
        artifact = variant["runtime"]
        representation = bar_runtime.runtime_representation(root, artifact)
        if representation.name != artifact["file"]:
            descriptor = chunks.load_descriptor(representation, artifact, commit, version, architecture)
            chunks.fetch_parts(descriptor, release["artifact_url"], parts_root)
    value = verify_payload(root, commit, version, parts_root=parts_root)
    write_json(output / "release.json", release)
    write_json(output / "authority-evidence.json", evidence)
    return value


def cask_proposal(root, commit, version, sha, evidence, chain, output, parts_root=None):
    require(isinstance(sha, str) and HEX64.fullmatch(sha), "cask requires an exact DMG digest")
    value = verify_payload(root, commit, version, sha, parts_root)
    receipt = evidence["receipt"]
    require(canonical(receipt) == evidence["head"]["receipt_sha256"] and receipt["source_commit"] == commit and receipt["version"] == version, "cask receipt identity mismatch")
    require(receipt["receipt_kind"] == "promotion" and receipt["artifact_provenance"] == "github-candidate-bundle-sha256", "cask requires a finalized candidate receipt")
    require([item.get("ring") for item in chain] == ["nightly", "alpha", "canary", "beta"], "cask requires the complete frozen receipt chain")
    references = []
    for item in chain:
        row = item["receipt"]
        require(row["receipt_kind"] == "promotion" and row["source_commit"] == commit and row["version"] == version and row["artifact_sha256"] == receipt["artifact_sha256"], "cask chain identity mismatch")
        require(HEX40.fullmatch(item["authority_commit"]) and HEX64.fullmatch(row["promotion_id"]), "cask authority reference must be immutable")
        require(item["receipt_path"] == f"receipts/{item['ring']}/{row['promotion_id']}.json", "cask authority receipt path mismatch")
        references.append({
            "ring": item["ring"],
            "url": f"https://raw.githubusercontent.com/{AUTHORITY}/{item['authority_commit']}/{item['receipt_path']}",
            "sha256": canonical(row),
        })
    require(canonical(chain[-1]["receipt"]) == canonical(receipt), "cask beta receipt changed")
    require(evidence["receipt_url"] == references[-1]["url"], "cask beta receipt URL mismatch")
    url = f"https://github.com/{REPOSITORY}/releases/download/{value['release_tag']}/{value['dmg']['name']}"
    output.mkdir(parents=True, exist_ok=False)
    (output / "openrappter-bar.rb").write_text(
        f'cask "openrappter-bar" do\n  version "{version}"\n  sha256 "{sha}"\n\n'
        f'  url "{url}"\n  name "OpenRappter Bar"\n'
        '  desc "Menu bar companion for the OpenRappter AI agent gateway"\n'
        f'  homepage "https://github.com/{REPOSITORY}"\n\n'
        '  depends_on macos: :sonoma\n  app "OpenRappter Bar.app"\n'
        '  zap trash: "~/Library/Preferences/com.openrappter.bar.plist"\nend\n'
    )
    proof = {
        "schema": "openrappter-bar-cask-proposal/v1", "source_commit": commit,
        "version": version, "url": url, "sha256": sha,
        "candidate_sha256": receipt["artifact_sha256"],
        "authority_receipt_url": evidence["receipt_url"],
        "authority_receipt_sha256": evidence["head"]["receipt_sha256"],
        "authority_receipts": references,
        "publication": "proposal-only",
    }
    write_json(output / "receipt.json", proof)
    write_json(output / "runtime-bootstrap-proof.json", proof)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["record", "verify", "materialize", "cask"])
    parser.add_argument("--commit", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--notary", type=Path)
    parser.add_argument("--expected-sha")
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--chain", type=Path)
    parser.add_argument("--parts-root", type=Path)
    args = parser.parse_args()
    if args.command == "record":
        value = record(args.root, args.commit, args.version, json.loads(args.notary.read_text()), args.parts_root)
    elif args.command == "verify":
        value = verify_payload(args.root, args.commit, args.version, args.expected_sha, args.parts_root)
    elif args.command == "materialize":
        value = materialize(args.output, args.commit, args.version)
    else:
        require(args.expected_sha is not None, "cask requires the constitution-checked DMG digest")
        cask_proposal(args.root, args.commit, args.version, args.expected_sha, json.loads(args.evidence.read_text()), json.loads(args.chain.read_text()), args.output, args.parts_root)
        return
    print(value["dmg"]["sha256"])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Bar candidate refused: {error}", file=sys.stderr)
        raise SystemExit(1)
