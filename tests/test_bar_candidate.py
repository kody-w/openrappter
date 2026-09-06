import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("bar_candidate", ROOT / "scripts/bar_candidate.py")
bar = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bar)
COMMIT = "a" * 40
VERSION = "1.14.0"
NOTARY = {"status": "Accepted", "id": "12345678-1234-1234-1234-123456789abc"}


class BarCandidateTests(unittest.TestCase):
    def setUp(self):
        self.work = ROOT / f".bar-candidate-tests-{uuid.uuid4().hex}"
        self.work.mkdir()
        self.payload = self.work / "payload"
        self.payload.mkdir()
        for name in (
            "OpenRappter-Bar-1.14.0.dmg", "openrappter-1.14.0.tgz",
            "openrappter-1.14.0-py3-none-any.whl", "openrappter-1.14.0.tar.gz",
            "install.sh", "install.ps1",
        ):
            (self.payload / name).write_bytes(f"fixture {name}\n".encode())
        self.record = bar.record(self.payload, COMMIT, VERSION, NOTARY)
        self.provenance = {
            "schema": "openrappter-candidate-provenance/v1",
            "source_repository": bar.REPOSITORY, "channel": "candidate",
            "source_commit": COMMIT, "source_tag": None, "stable": False,
            "candidate_kind": "release", "candidate_id": "tag-djEuMTQuMA",
            "intended_release_tag": "v1.14.0",
            "versions": {"npm": VERSION, "pypi": VERSION, "runtime": VERSION, "channel": "0.1.0-beta.11"},
            "files": [{"path": p.name, "sha256": bar.digest(p.read_bytes())} for p in sorted(self.payload.iterdir())],
        }
        bar.write_json(self.payload / "provenance.json", self.provenance)
        self.checksums()

    def tearDown(self):
        shutil.rmtree(self.work)

    def checksums(self):
        (self.payload / "SHA256SUMS").write_text("".join(
            f"{bar.digest(p.read_bytes())}  {p.name}\n"
            for p in sorted(self.payload.iterdir()) if p.name != "SHA256SUMS"
        ))

    def bundle(self):
        file = self.work / "candidate.tar.gz"
        with tarfile.open(file, "w:gz") as archive:
            for p in sorted(self.payload.iterdir()):
                archive.add(p, arcname=f"./{p.name}")
        return file

    def evidence(self):
        sha = bar.digest(self.bundle().read_bytes())
        manifest = {"status": "published"}
        receipt = {
            "schema": "openrappter-promotion-receipt/v1", "receipt_kind": "promotion",
            "source_repository": bar.REPOSITORY, "source_commit": COMMIT,
            "source_tag": None, "version": VERSION, "intended_release_tag": f"v{VERSION}",
            "channel_version": "0.1.0-beta.11", "promotion_id": "c" * 64,
            "target_manifest_commit": "b" * 40, "target_manifest_sha256": bar.canonical(manifest),
            "artifact_provenance": "github-candidate-bundle-sha256", "artifact_sha256": sha,
            "artifact_url": f"https://raw.githubusercontent.com/kody-w/openrappter/{'d' * 40}/candidates/{COMMIT}/release/tag-djEuMTQuMA/{sha}.tar.gz",
        }
        receipt["install_url"] = receipt["artifact_url"]
        head = {
            "schema": "openrappter-ring-head/v1", "ring": "beta",
            "target_repository": "kody-w/openrappter-beta", "authority_commit": "e" * 40,
            "target_manifest_commit": "b" * 40, "promotion_id": "c" * 64,
            "receipt_path": f"receipts/beta/{'c' * 64}.json",
            "receipt_sha256": bar.canonical(receipt), "target_manifest_sha256": bar.canonical(manifest),
        }
        return {"head": head, "receipt": receipt, "manifest": manifest, "receipt_url": f"https://raw.githubusercontent.com/{bar.AUTHORITY}/{'e' * 40}/{head['receipt_path']}"}

    def test_complete_bar_bytes_are_bound_to_canonical_candidate(self):
        self.assertEqual(bar.verify_payload(self.payload, COMMIT, VERSION), self.record)

    def test_post_signing_byte_change_is_rejected(self):
        (self.payload / self.record["dmg"]["name"]).write_bytes(b"rebuilt")
        with self.assertRaisesRegex(ValueError, "DMG"):
            bar.verify_payload(self.payload, COMMIT, VERSION)

    def test_rewritten_local_manifest_cannot_override_candidate_provenance(self):
        dmg = self.payload / self.record["dmg"]["name"]
        dmg.write_bytes(b"replacement signed bytes")
        bar.record(self.payload, COMMIT, VERSION, NOTARY)
        self.checksums()
        with self.assertRaisesRegex(ValueError, "candidate bytes changed"):
            bar.verify_payload(self.payload, COMMIT, VERSION)

    def test_expected_published_digest_is_mandatory_identity(self):
        with self.assertRaisesRegex(ValueError, "constitution-checked"):
            bar.verify_payload(self.payload, COMMIT, VERSION, "0" * 64)

    def test_unaccepted_notarization_and_wrong_version_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Accepted"):
            bar.record(self.payload, COMMIT, VERSION, {**NOTARY, "status": "Invalid"})
        with self.assertRaisesRegex(ValueError, "version must"):
            bar.verify_payload(self.payload, COMMIT, "1.14.0;echo bad")
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            bar.verify_payload(self.payload, "f" * 40, VERSION)

    def test_package_only_or_snapshot_candidate_cannot_release_bar(self):
        for name in ("macos-bar.json", self.record["dmg"]["name"]):
            file = self.payload / name
            saved = file.read_bytes()
            file.unlink()
            with self.assertRaisesRegex(ValueError, "missing regular artifact"):
                bar.verify_payload(self.payload, COMMIT, VERSION)
            file.write_bytes(saved)
        self.provenance["candidate_kind"] = "snapshot"
        bar.write_json(self.payload / "provenance.json", self.provenance)
        with self.assertRaisesRegex(ValueError, "not a snapshot"):
            bar.verify_payload(self.payload, COMMIT, VERSION)

    def test_unlisted_files_and_symlinks_are_rejected(self):
        (self.payload / "unlisted").write_text("unexpected")
        with self.assertRaisesRegex(ValueError, "unlisted"):
            bar.verify_payload(self.payload, COMMIT, VERSION)
        (self.payload / "unlisted").unlink()
        file = self.payload / "install.sh"
        file.unlink()
        file.symlink_to("install.ps1")
        with self.assertRaisesRegex(ValueError, "regular artifact"):
            bar.verify_payload(self.payload, COMMIT, VERSION)

    def test_exact_bundle_extracts_without_rebuilding(self):
        bundle = self.bundle()
        destination = self.work / "extracted"
        bar.extract(bundle, destination, bar.digest(bundle.read_bytes()))
        self.assertEqual(bar.verify_payload(destination, COMMIT, VERSION), self.record)
        with self.assertRaisesRegex(ValueError, "must not exist"):
            bar.extract(bundle, destination, bar.digest(bundle.read_bytes()))

    def test_tampered_bundle_and_traversing_member_are_rejected(self):
        bundle = self.bundle()
        with self.assertRaisesRegex(ValueError, "bundle checksum"):
            bar.extract(bundle, self.work / "bad", "0" * 64)
        with tarfile.open(bundle, "w:gz") as archive:
            archive.add(self.payload / "install.sh", arcname="../escaped")
        with self.assertRaisesRegex(ValueError, "flat regular"):
            bar.extract(bundle, self.work / "bad", bar.digest(bundle.read_bytes()))
        self.assertFalse((self.work / "escaped").exists())

    def test_immutable_beta_resolution_preserves_candidate_and_bar_tag_identities(self):
        evidence = self.evidence()
        def fetch(url):
            if url.endswith("/heads/beta.json"):
                return evidence["head"]
            if "/receipts/beta/" in url:
                return evidence["receipt"]
            return evidence["manifest"]
        release, resolved = bar.resolve_identity(COMMIT, VERSION, fetch)
        self.assertEqual(release["source_tag"], "v1.14.0-bar")
        self.assertEqual(release["intended_release_tag"], "v1.14.0")
        self.assertEqual(resolved["receipt"], evidence["receipt"])
        evidence["receipt"]["source_commit"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "authority digest"):
            bar.resolve_identity(COMMIT, VERSION, fetch)

    def test_cask_is_only_a_reviewable_proposal_bound_to_receipt_and_dmg(self):
        evidence = self.evidence()
        chain = [
            {"ring": ring, "authority_commit": "e" * 40,
             "receipt": {**evidence["receipt"], "promotion_id": str(index) * 64},
             "receipt_path": f"receipts/{ring}/{str(index) * 64}.json"}
            for index, ring in enumerate(("nightly", "alpha", "canary"), 1)
        ] + [{"ring": "beta", "authority_commit": "e" * 40,
              "receipt": evidence["receipt"], "receipt_path": evidence["head"]["receipt_path"]}]
        output = self.work / "proposal"
        bar.cask_proposal(self.payload, COMMIT, VERSION, self.record["dmg"]["sha256"], evidence, chain, output)
        cask = (output / "openrappter-bar.rb").read_text()
        self.assertIn('version "1.14.0"', cask)
        self.assertIn(self.record["dmg"]["sha256"], cask)
        self.assertIn("/v1.14.0-bar/OpenRappter-Bar-1.14.0.dmg", cask)
        proof = json.loads((output / "receipt.json").read_text())
        self.assertEqual(proof["publication"], "proposal-only")
        self.assertEqual(proof["candidate_sha256"], evidence["receipt"]["artifact_sha256"])
        self.assertEqual([row["ring"] for row in proof["authority_receipts"]], ["nightly", "alpha", "canary", "beta"])
        with self.assertRaisesRegex(ValueError, "constitution-checked"):
            bar.cask_proposal(self.payload, COMMIT, VERSION, "0" * 64, evidence, chain, self.work / "bad-proposal")
        with self.assertRaisesRegex(ValueError, "complete frozen receipt chain"):
            bar.cask_proposal(self.payload, COMMIT, VERSION, self.record["dmg"]["sha256"], evidence, chain[1:], self.work / "bad-proposal")

    @unittest.skipUnless(sys.platform == "darwin", "native packaging shell contract runs in macOS CI")
    def test_native_verifier_checks_trust_and_version_without_mutating_the_dmg(self):
        commands = self.work / "commands"
        commands.mkdir()
        calls = self.work / "calls.jsonl"
        fixture = self.work / "fixture-app"
        (fixture / "Contents/MacOS").mkdir(parents=True)
        (fixture / "Contents/MacOS/OpenRappterBar").write_bytes(b"mock executable")
        (fixture / "Contents/Info.plist").write_text(
            '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
            '<key>CFBundleShortVersionString</key><string>1.14.0</string>'
            '<key>CFBundleIdentifier</key><string>com.openrappter.bar</string>'
            '</dict></plist>'
        )
        stub = f"""#!{sys.executable}
import json,os,shutil,sys
from pathlib import Path
name=Path(sys.argv[0]).name
with open(os.environ["BAR_TEST_CALLS"],"a") as file:
    file.write(json.dumps([name,*sys.argv[1:]])+"\\n")
if name=="codesign" and "--display" in sys.argv:
    print(os.environ.get("BAR_TEST_AUTHORITY","Authority=Developer ID Application: Fixture"),file=sys.stderr)
if name=="hdiutil" and sys.argv[1]=="attach":
    mount=Path(sys.argv[sys.argv.index("-mountpoint")+1])
    shutil.copytree(os.environ["BAR_TEST_APP"],mount/"OpenRappter Bar.app")
if name=="hdiutil" and sys.argv[1]=="detach":
    shutil.rmtree(Path(sys.argv[2])/"OpenRappter Bar.app")
"""
        for command in ("hdiutil", "codesign", "xcrun", "spctl", "lipo"):
            file = commands / command
            file.write_text(stub)
            file.chmod(0o700)
        env = {
            **os.environ, "PATH": f"{commands}{os.pathsep}{os.environ['PATH']}",
            "BAR_TEST_CALLS": str(calls), "BAR_TEST_APP": str(fixture),
        }
        dmg = self.payload / self.record["dmg"]["name"]
        command = ["bash", str(ROOT / "macos/scripts/verify-dmg.sh"), str(dmg), VERSION, self.record["dmg"]["sha256"]]
        result = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        invoked = [json.loads(line) for line in calls.read_text().splitlines()]
        self.assertIn(["xcrun", "stapler", "validate", str(dmg)], invoked)
        self.assertTrue(any(row[:3] == ["spctl", "--assess", "--type"] and "execute" in row for row in invoked))
        self.assertTrue(any(row[0] == "lipo" and row[1:4] == ["-verify_arch", "arm64", "x86_64"] for row in invoked))
        self.assertTrue(any(row[0] == "hdiutil" and "-readonly" in row for row in invoked))
        self.assertFalse(any("staple" in row or "--sign" in row for row in invoked))
        self.assertEqual(bar.digest(dmg.read_bytes()), self.record["dmg"]["sha256"])
        calls.unlink()
        rejected = subprocess.run([*command[:-1], "0" * 64], env=env, capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertFalse(calls.exists(), "a digest mismatch must stop before any native tool")
        untrusted = subprocess.run(command, env={**env, "BAR_TEST_AUTHORITY": "Authority=Apple Development: Fixture"}, capture_output=True, text=True)
        self.assertNotEqual(untrusted.returncode, 0, "development signing is not Developer ID distribution")
        plist = fixture / "Contents/Info.plist"
        plist.write_text(plist.read_text().replace("1.14.0", "1.14.1"))
        wrong_version = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertNotEqual(wrong_version.returncode, 0, "a different bundled version must be rejected")


if __name__ == "__main__":
    unittest.main()
