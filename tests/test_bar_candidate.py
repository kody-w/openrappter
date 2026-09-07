import importlib.util
import base64
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import unittest
from unittest.mock import patch
import uuid
import io
from bar_runtime_fixtures import app_fixture, runtime, runtime_inputs
import bar_runtime_chunks as chunks

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("bar_candidate", ROOT / "scripts/bar_candidate.py")
bar = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bar)
COMMIT = "a" * 40
VERSION = runtime.source_version()
CANDIDATE_ID = "tag-" + base64.urlsafe_b64encode(f"v{VERSION}".encode()).decode().rstrip("=")
NOTARY = {"status": "Accepted", "id": "12345678-1234-1234-1234-123456789abc"}


class BarCandidateTests(unittest.TestCase):
    def setUp(self):
        self.work = ROOT / ".test-scratch" / f"bar-candidate-tests-{uuid.uuid4().hex}"
        self.work.mkdir(parents=True)
        self.payload = self.work / "payload"
        self.payload.mkdir()
        for name in (
            f"OpenRappter-Bar-{VERSION}.dmg", f"openrappter-{VERSION}.tgz",
            f"openrappter-{VERSION}-py3-none-any.whl", f"openrappter-{VERSION}.tar.gz",
            "install.sh", "install.ps1",
        ):
            (self.payload / name).write_bytes(f"fixture {name}\n".encode())
        runtime_inputs(self.work / "stages", self.payload, COMMIT, VERSION)
        self.record = bar.record(self.payload, COMMIT, VERSION, NOTARY)
        self.provenance = {
            "schema": "openrappter-candidate-provenance/v1",
            "source_repository": bar.REPOSITORY, "channel": "candidate",
            "source_commit": COMMIT, "source_tag": None, "stable": False,
            "candidate_kind": "release", "candidate_id": CANDIDATE_ID,
            "intended_release_tag": f"v{VERSION}", "source_date_epoch": 1_700_000_000,
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

    def chunked_payload(self):
        parts = self.work / "candidate-parts"
        descriptors = {}
        metadata = json.loads((self.payload / runtime.METADATA).read_text())
        for architecture, variant in metadata["variants"].items():
            artifact = variant["runtime"]
            archive = self.payload / artifact["file"]
            descriptors[architecture] = chunks.split_archive(
                archive, artifact, COMMIT, VERSION, architecture, parts,
                self.payload / chunks.descriptor_name(artifact))
            archive.unlink()
        self.refresh_provenance()
        return parts, descriptors

    def refresh_provenance(self):
        self.provenance["files"] = [{"path": file.name, "sha256": runtime.file_sha(file)}
                                    for file in sorted(self.payload.iterdir())
                                    if file.name not in ("SHA256SUMS", "provenance.json")]
        bar.write_json(self.payload / "provenance.json", self.provenance)
        self.checksums()

    def bundle(self):
        file = self.work / "candidate.tar.gz"
        def normalize(info):
            info.mtime = info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.pax_headers = {}
            return info
        with file.open("wb") as target, gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for p in sorted(self.payload.iterdir()):
                    archive.add(p, arcname=f"./{p.name}", filter=normalize)
        return file

    def chain(self):
        sha = bar.digest(self.bundle().read_bytes())
        url = f"https://raw.githubusercontent.com/kody-w/openrappter/{'d' * 40}/candidates/{COMMIT}/release/{CANDIDATE_ID}/{sha}.tar.gz"
        rows, prior = [], "f" * 64
        rings = ("nightly", "alpha", "canary", "beta")
        for index, ring in enumerate(rings):
            promotion_id = str(index + 1) * 64
            manifest = {
                "schema": "openrappter-ring/v1", "ring": ring,
                "source": {"repository": bar.REPOSITORY, "commit": COMMIT, "tag": None},
                "version": VERSION, "artifact": {"url": url, "install_url": url, "sha256": sha,
                                               "provenance": "github-candidate-bundle-sha256"},
                "promoted_at": "2026-01-01T00:00:00Z", "predecessor": rings[index - 1] if index else None,
                "status": "published", "reason": None, "receipt": None, "promotion_id": promotion_id,
                "intended_release_tag": f"v{VERSION}", "channel_version": "0.1.0-beta.11",
            }
            receipt = {
                "schema": "openrappter-promotion-receipt/v1", "receipt_kind": "promotion",
                "source_repository": bar.REPOSITORY, "source_commit": COMMIT,
                "source_tag": None, "version": VERSION, "intended_release_tag": f"v{VERSION}",
                "channel_version": "0.1.0-beta.11", "promotion_id": promotion_id,
                "target_manifest_commit": str(index + 1) * 40, "target_manifest_sha256": bar.canonical(manifest),
                "target_repository": f"kody-w/openrappter-{ring}", "target_ring": ring,
                "predecessor_manifest_sha256": prior, "sequence": index + 1,
                "emitted_at": f"2026-01-01T00:00:0{index}Z",
                "artifact_provenance": "github-candidate-bundle-sha256", "artifact_sha256": sha,
                "artifact_url": url, "install_url": url,
            }
            rows.append({"ring": ring, "authority_commit": "e" * 40, "receipt": receipt,
                         "receipt_path": f"receipts/{ring}/{promotion_id}.json", "manifest": manifest})
            prior = bar.canonical(manifest)
        return rows

    def evidence(self):
        beta = self.chain()[-1]
        receipt, manifest = beta["receipt"], beta["manifest"]
        head = {
            "schema": "openrappter-ring-head/v1", "ring": "beta",
            "target_repository": "kody-w/openrappter-beta", "authority_commit": "e" * 40,
            "target_manifest_commit": receipt["target_manifest_commit"], "promotion_id": receipt["promotion_id"],
            "receipt_path": beta["receipt_path"],
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
        self.assertEqual(release["source_tag"], f"v{VERSION}-bar")
        self.assertEqual(release["intended_release_tag"], f"v{VERSION}")
        self.assertEqual(resolved["receipt"], evidence["receipt"])
        evidence["receipt"]["source_commit"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "authority digest"):
            bar.resolve_identity(COMMIT, VERSION, fetch)

    def test_cask_is_only_a_reviewable_proposal_bound_to_receipt_and_dmg(self):
        evidence = self.evidence()
        chain = self.chain()
        output = self.work / "proposal"
        bar.cask_proposal(self.payload, COMMIT, VERSION, self.record["dmg"]["sha256"], evidence, chain, output)
        cask = (output / "openrappter-bar.rb").read_text()
        self.assertIn(f'version "{VERSION}"', cask)
        self.assertIn(self.record["dmg"]["sha256"], cask)
        self.assertIn(f"/v{VERSION}-bar/OpenRappter-Bar-{VERSION}.dmg", cask)
        proof = json.loads((output / "receipt.json").read_text())
        self.assertEqual(proof["publication"], "proposal-only")
        self.assertEqual(proof["candidate_sha256"], evidence["receipt"]["artifact_sha256"])
        self.assertEqual([row["ring"] for row in proof["authority_receipts"]], ["nightly", "alpha", "canary", "beta"])
        self.assertEqual((output / "receipt.json").read_bytes(), (output / "runtime-bootstrap-proof.json").read_bytes())
        with self.assertRaisesRegex(ValueError, "constitution-checked"):
            bar.cask_proposal(self.payload, COMMIT, VERSION, "0" * 64, evidence, chain, self.work / "bad-proposal")
        with self.assertRaisesRegex(ValueError, "complete frozen receipt chain"):
            bar.cask_proposal(self.payload, COMMIT, VERSION, self.record["dmg"]["sha256"], evidence, chain[1:], self.work / "bad-proposal")

    def test_generated_proof_and_both_archives_pass_the_actual_bootstrap_consumer(self):
        evidence, chain = self.evidence(), self.chain()
        output = self.work / "proposal"
        bar.cask_proposal(self.payload, COMMIT, VERSION, self.record["dmg"]["sha256"], evidence, chain, output)
        documents = {}
        for item in chain:
            documents[f"https://raw.githubusercontent.com/{bar.AUTHORITY}/{item['authority_commit']}/{item['receipt_path']}"] = item["receipt"]
            receipt = item["receipt"]
            documents[f"https://raw.githubusercontent.com/{receipt['target_repository']}/{receipt['target_manifest_commit']}/.ring/manifest.json"] = item["manifest"]
        bar.write_json(self.work / "documents.json", documents)
        consumer_work = self.work / "consumer"
        consumer_work.mkdir()
        script = """
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [bundle, metadataFile, proofFile, documentsFile, helper, work] = process.argv.slice(1);
const { validateMetadata, verifyApproval, extractCandidate, extractRuntime, fileDigest } = await import(pathToFileURL(helper));
const read = async file => JSON.parse(await fs.readFile(file));
const metadata = await read(metadataFile), proof = await read(proofFile), documents = await read(documentsFile);
const fetchJSON = async url => {
  assert.ok(Object.hasOwn(documents, url), `unexpected network request: ${url}`);
  return structuredClone(documents[url]);
};
const approval = await verifyApproval(proof, metadata, fetchJSON);
assert.equal(approval.sha256, await fileDigest(bundle));
for (const arch of ['arm64', 'x86_64']) {
  validateMetadata(metadata, arch, metadata.version, metadata.source_commit);
  const signal = new AbortController().signal;
  const selected = await extractCandidate(bundle, path.join(work, arch), metadata, arch, proof, signal);
  assert.equal(await fileDigest(selected.archive), metadata.variants[arch].runtime.sha256);
  const runtime = await extractRuntime(selected.archive, path.join(work, `${arch}-runtime`), signal);
  assert.equal((await read(path.join(runtime, 'package.json'))).version, metadata.version);
  assert.equal((await read(path.join(runtime, 'runtime-build.json'))).architecture, arch);
}
await assert.rejects(verifyApproval({ ...proof, authority_receipts: proof.authority_receipts.slice(1) }, metadata, fetchJSON));
const changed = structuredClone(metadata);
changed.variants.arm64.runtime.sha256 = '0'.repeat(64);
await assert.rejects(extractCandidate(bundle, path.join(work, 'tampered-pin'), changed, 'arm64', proof, new AbortController().signal));
"""
        result = subprocess.run(
            [os.environ.get("BAR_TEST_NODE", "node"), "--input-type=module", "-e", script,
             str(self.bundle()), str(self.payload / runtime.METADATA),
             str(output / "runtime-bootstrap-proof.json"), str(self.work / "documents.json"),
             str(ROOT / "macos/Resources" / runtime.HELPER), str(consumer_work)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("runtime-bootstrap-proof.json", {row["path"] for row in self.provenance["files"]},
                         "post-gate proof must not make the candidate identity self-referential")

    def test_both_runtimes_must_be_flat_provenance_files(self):
        name = runtime.runtime_filename(VERSION, "x86_64")
        self.provenance["files"] = [row for row in self.provenance["files"] if row["path"] != name]
        bar.write_json(self.payload / "provenance.json", self.provenance)
        self.checksums()
        with self.assertRaisesRegex(ValueError, "both sealed bootstrap resources and runtimes"):
            bar.verify_payload(self.payload, COMMIT, VERSION)

    def test_runtime_tarballs_cannot_substitute_for_the_python_sdist(self):
        name = f"openrappter-{VERSION}.tar.gz"
        (self.payload / name).unlink()
        self.provenance["files"] = [row for row in self.provenance["files"] if row["path"] != name]
        bar.write_json(self.payload / "provenance.json", self.provenance)
        self.checksums()
        with self.assertRaisesRegex(ValueError, "canonical package candidate"):
            bar.verify_payload(self.payload, COMMIT, VERSION)

    def test_chunked_candidate_requires_all_parts_and_preserves_the_original_runtime_bytes(self):
        parts, descriptors = self.chunked_payload()
        self.assertEqual(bar.verify_payload(self.payload, COMMIT, VERSION, parts_root=parts), self.record)
        with self.assertRaisesRegex(ValueError, "parts directory is required"):
            bar.verify_payload(self.payload, COMMIT, VERSION)
        output = self.work / "runtime-archives"
        runtime.export_runtime_archives(self.payload, parts, COMMIT, VERSION, output)
        for descriptor in descriptors.values():
            self.assertEqual(runtime.file_sha(output / descriptor["file"]), descriptor["sha256"])
        first = parts / descriptors["arm64"]["parts"][0]["file"]
        first.unlink()
        with self.assertRaisesRegex(ValueError, "missing regular runtime part"):
            bar.verify_payload(self.payload, COMMIT, VERSION, parts_root=parts)

    def test_direct_and_chunked_representations_cannot_both_appear(self):
        parts, descriptors = self.chunked_payload()
        descriptor = descriptors["arm64"]
        chunks.verify_parts(descriptor, parts, self.payload / descriptor["file"])
        with self.assertRaisesRegex(ValueError, "exactly one"):
            bar.verify_payload(self.payload, COMMIT, VERSION, parts_root=parts)

    def test_parts_cannot_be_smuggled_into_outer_provenance_or_left_unlisted(self):
        parts, descriptors = self.chunked_payload()
        part = parts / descriptors["arm64"]["parts"][0]["file"]
        shutil.copyfile(part, self.payload / part.name)
        self.refresh_provenance()
        with self.assertRaisesRegex(ValueError, "siblings outside"):
            bar.verify_payload(self.payload, COMMIT, VERSION, parts_root=parts)
        (self.payload / part.name).unlink()
        self.refresh_provenance()
        (parts / "unlisted.part").write_bytes(b"unexpected")
        with self.assertRaisesRegex(ValueError, "unlisted runtime parts"):
            bar.verify_payload(self.payload, COMMIT, VERSION, parts_root=parts)

    def test_materialization_downloads_frozen_sibling_parts_before_claiming_success(self):
        parts, _ = self.chunked_payload()
        evidence = self.evidence()
        release = {"artifact_url": evidence["receipt"]["artifact_url"],
                   "artifact_sha256": evidence["receipt"]["artifact_sha256"]}
        bundle = self.bundle().read_bytes()
        original_fetch = chunks.fetch_parts
        requested = []
        def fetch(descriptor, candidate_url, output):
            def opener(request, timeout):
                requested.append(request.full_url)
                self.assertEqual(request.full_url.rsplit("/", 1)[0], candidate_url.rsplit("/", 1)[0])
                return io.BytesIO((parts / request.full_url.rsplit("/", 1)[1]).read_bytes())
            return original_fetch(descriptor, candidate_url, output, opener)
        output = self.work / "materialized"
        with patch.object(bar, "resolve_identity", return_value=(release, evidence)), \
                patch.object(bar.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(bundle)), \
                patch.object(chunks, "fetch_parts", side_effect=fetch):
            self.assertEqual(bar.materialize(output, COMMIT, VERSION), self.record)
        self.assertEqual(len(requested), 2)
        self.assertTrue((output / "release.json").is_file())
        self.assertEqual(bar.verify_payload(output / "release-dist", COMMIT, VERSION,
                                           parts_root=output / "candidate-parts"), self.record)
        failed = self.work / "unavailable"
        with patch.object(bar, "resolve_identity", return_value=(release, evidence)), \
                patch.object(bar.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(bundle)), \
                patch.object(chunks, "fetch_parts", side_effect=OSError("immutable part unavailable")):
            with self.assertRaisesRegex(OSError, "immutable part unavailable"):
                bar.materialize(failed, COMMIT, VERSION)
        self.assertFalse((failed / "release.json").exists(), "unavailable parts cannot yield release evidence")

    def test_frozen_proof_publication_also_requires_verified_chunk_bytes(self):
        parts, descriptors = self.chunked_payload()
        evidence, chain = self.evidence(), self.chain()
        output = self.work / "chunk-proof"
        bar.cask_proposal(self.payload, COMMIT, VERSION, self.record["dmg"]["sha256"],
                          evidence, chain, output, parts_root=parts)
        self.assertEqual((output / "runtime-bootstrap-proof.json").read_bytes(), (output / "receipt.json").read_bytes())
        part = parts / descriptors["x86_64"]["parts"][0]["file"]
        data = part.read_bytes()
        part.write_bytes(bytes(len(data)))
        with self.assertRaisesRegex(ValueError, "runtime part checksum"):
            bar.cask_proposal(self.payload, COMMIT, VERSION, self.record["dmg"]["sha256"],
                              evidence, chain, self.work / "bad-proof", parts_root=parts)

    @unittest.skipUnless(sys.platform == "darwin", "macOS packaging shell")
    def test_signed_app_build_refuses_missing_bootstrap_before_swift_or_signing(self):
        commands = self.work / "commands"
        commands.mkdir()
        called = self.work / "unexpected-build"
        for name in ("swift", "codesign"):
            file = commands / name
            file.write_text(f"#!/bin/bash\nprintf 'unexpected' > '{called}'\nexit 99\n")
            file.chmod(0o700)
        env = {**os.environ, "PATH": str(commands) + os.pathsep + os.environ["PATH"],
               "REQUIRE_SIGNING": "1", "CODESIGN_IDENTITY": "Developer ID Application: fixture",
               "SOURCE_COMMIT": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
               "VERSION": VERSION, "RUNTIME_INPUTS": str(self.work / "missing")}
        result = subprocess.run(["bash", str(ROOT / "macos/scripts/build-mac-app.sh")],
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing regular runtime resource", result.stderr)
        self.assertFalse(called.exists())

    @unittest.skipUnless(sys.platform == "darwin", "native packaging shell contract runs in macOS CI")
    def test_native_verifier_checks_trust_and_version_without_mutating_the_dmg(self):
        commands = self.work / "commands"
        commands.mkdir()
        calls = self.work / "calls.jsonl"
        fixture = self.work / "fixture-app"
        app_fixture(fixture, self.payload, COMMIT, VERSION)
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
        command = ["bash", str(ROOT / "macos/scripts/verify-dmg.sh"), str(dmg), VERSION, self.record["dmg"]["sha256"], COMMIT]
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
        rejected = subprocess.run([*command[:4], "0" * 64, COMMIT], env=env, capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertFalse(calls.exists(), "a digest mismatch must stop before any native tool")
        untrusted = subprocess.run(command, env={**env, "BAR_TEST_AUTHORITY": "Authority=Apple Development: Fixture"}, capture_output=True, text=True)
        self.assertNotEqual(untrusted.returncode, 0, "development signing is not Developer ID distribution")
        plist = fixture / "Contents/Info.plist"
        plist.write_text(plist.read_text().replace(VERSION, "999.0.0"))
        wrong_version = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertNotEqual(wrong_version.returncode, 0, "a different bundled version must be rejected")


if __name__ == "__main__":
    unittest.main()
