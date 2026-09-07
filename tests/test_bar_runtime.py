import json
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import tarfile
import unittest
from unittest.mock import patch
import uuid

from bar_runtime_fixtures import ROOT, app_fixture, runtime, runtime_inputs

COMMIT = "a" * 40
VERSION = runtime.source_version()


class BarRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.work = ROOT / ".test-scratch" / f"bar-runtime-tests-{uuid.uuid4().hex}"
        self.payload = self.work / "payload"
        self.payload.mkdir(parents=True)
        self.stages = runtime_inputs(self.work / "stages", self.payload, COMMIT, VERSION)

    def tearDown(self):
        shutil.rmtree(self.work)

    def archive(self, architecture="arm64"):
        return self.payload / runtime.runtime_filename(VERSION, architecture)

    def repack(self, architecture="arm64"):
        self.archive(architecture).unlink()
        runtime.pack_runtime(self.stages[architecture], self.archive(architecture), 1_700_000_000)

    def test_metadata_matches_actual_consumer_schema_and_helper_for_both_architectures(self):
        runtime.verify_bootstrap(self.payload, COMMIT, VERSION)
        script = """
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [metadataFile, helperFile, schemaFile, packageFile] = process.argv.slice(1);
const { validateMetadata } = await import(pathToFileURL(helperFile));
const metadata = JSON.parse(fs.readFileSync(metadataFile));
const Ajv = createRequire(packageFile)('ajv/dist/2020').default;
const validate = new Ajv({ allErrors: true }).compile(JSON.parse(fs.readFileSync(schemaFile)));
assert.ok(validate(metadata), JSON.stringify(validate.errors));
for (const arch of ['arm64', 'x86_64']) validateMetadata(metadata, arch, metadata.version, metadata.source_commit);
metadata.variants.arm64.node.url = metadata.variants.arm64.node.url.replace(`/v${metadata.variants.arm64.node.version}/`, '/latest/');
assert.throws(() => validateMetadata(metadata, 'arm64', metadata.version, metadata.source_commit));
assert.equal(validate(metadata), false);
"""
        result = subprocess.run(
            [os.environ.get("BAR_TEST_NODE", "node"), "--input-type=module", "-e", script,
             str(self.payload / runtime.METADATA), str(ROOT / "macos/Resources" / runtime.HELPER),
             str(ROOT / "macos/Resources/runtime-bootstrap.schema.json"), str(ROOT / "typescript/package.json")],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_resources_or_either_runtime_refuse_signing(self):
        for file in (self.payload / runtime.METADATA, self.payload / runtime.HELPER,
                     self.archive(), self.archive("x86_64")):
            saved = file.read_bytes()
            file.unlink()
            with self.assertRaisesRegex(ValueError, "missing regular"):
                runtime.verify_bootstrap(self.payload, COMMIT, VERSION)
            file.write_bytes(saved)

    def test_changed_helper_and_runtime_hashes_are_rejected(self):
        helper = self.payload / runtime.HELPER
        helper.write_bytes(helper.read_bytes() + b"// changed\n")
        with self.assertRaisesRegex(ValueError, "helper digest"):
            runtime.verify_bootstrap(self.payload, COMMIT, VERSION)
        shutil.copyfile(ROOT / "macos/Resources" / runtime.HELPER, helper)
        with self.archive().open("ab") as file:
            file.write(b"changed")
        with self.assertRaisesRegex(ValueError, "digest/size"):
            runtime.verify_bootstrap(self.payload, COMMIT, VERSION)

    def test_changed_source_and_stale_node_pin_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            runtime.verify_bootstrap(self.payload, "b" * 40, VERSION)
        metadata = json.loads((self.payload / runtime.METADATA).read_text())
        metadata["variants"]["arm64"]["node"]["binary_sha256"] = "0" * 64
        runtime.write_json(self.payload / runtime.METADATA, metadata)
        with self.assertRaisesRegex(ValueError, "Node pin is stale"):
            runtime.verify_bootstrap(self.payload, COMMIT, VERSION)

    def test_stale_abi_or_source_pin_record_is_rejected(self):
        file = self.stages["arm64"] / runtime.BUILD_RECORD
        original = json.loads(file.read_text())
        for key, value in (("node_abi", 136), ("node_pins_sha256", "0" * 64),
                           ("package_lock_sha256", "0" * 64), ("ui_lock_sha256", "0" * 64)):
            runtime.write_json(file, {**original, key: value})
            self.repack()
            with self.assertRaisesRegex(ValueError, "Node ABI pin is stale"):
                runtime.verify_runtime_archive(self.archive(), COMMIT, VERSION, "arm64")

    def test_intel_native_dependency_cannot_enter_the_arm64_archive(self):
        native = self.stages["arm64"] / runtime.native_paths("arm64")[0]
        native.write_bytes(b"\xcf\xfa\xed\xfe" + struct.pack("<I", 0x01000007) + bytes(24))
        runtime.write_json(self.stages["arm64"] / runtime.BUILD_RECORD,
                           runtime.build_record(self.stages["arm64"], COMMIT, VERSION, "arm64"))
        self.repack()
        with self.assertRaisesRegex(ValueError, "architecture mismatch"):
            runtime.verify_runtime_archive(self.archive(), COMMIT, VERSION, "arm64")

    def test_missing_packaged_ui_and_native_dependencies_are_rejected(self):
        for name in ("ui/dist/index.html", "node_modules/sharp/package.json",
                     runtime.native_paths("arm64")[0], runtime.native_paths("arm64")[2]):
            file = self.stages["arm64"] / name
            saved = file.read_bytes()
            file.unlink()
            self.repack()
            with self.assertRaisesRegex(ValueError, "dependency/resource is missing"):
                runtime.verify_runtime_archive(self.archive(), COMMIT, VERSION, "arm64")
            file.write_bytes(saved)

    def test_only_explicit_foreign_targets_are_pruned_with_matching_binaries_and_licenses_retained(self):
        stage = self.stages["arm64"]
        names = runtime.platform_extras("arm64")
        pairs = runtime.platform_extra_pairs("arm64")
        matching = set(pairs.values())
        originals = {}
        for name in matching:
            file = stage / name
            originals[name] = file.read_bytes() if file.exists() else None
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"fixture matching binary")
        license_file = stage / "node_modules/@github/copilot-darwin-arm64/LICENSE.md"
        license_file.write_text("fixture license retained")
        for name in names:
            (stage / name).parent.mkdir(parents=True, exist_ok=True)
            (stage / name).write_bytes(b"fixture foreign platform binding")
        self.assertEqual(set(runtime.prune_platform_extras(stage, "arm64")), names)
        for name in matching:
            self.assertEqual((stage / name).read_bytes(), b"fixture matching binary")
        self.assertEqual(license_file.read_text(), "fixture license retained")
        self.assertTrue((stage / runtime.native_paths("arm64")[0]).exists())
        for name, original in originals.items():
            if original is None:
                (stage / name).unlink()
            else:
                (stage / name).write_bytes(original)
        record_file = stage / runtime.BUILD_RECORD
        record = json.loads(record_file.read_text())
        record["omitted_platform_files"] = [runtime.native_paths("arm64")[0]]
        runtime.write_json(record_file, record)
        self.repack()
        with self.assertRaisesRegex(ValueError, "unexpected runtime dependency omission"):
            runtime.verify_runtime_archive(self.archive(), COMMIT, VERSION, "arm64")

    def test_native_checksum_and_package_lock_changes_are_rejected(self):
        file = self.stages["arm64"] / runtime.native_paths("arm64")[0]
        file.write_bytes(file.read_bytes() + b"tampered")
        self.repack()
        with self.assertRaisesRegex(ValueError, "native dependency digest"):
            runtime.verify_runtime_archive(self.archive(), COMMIT, VERSION, "arm64")
        runtime.write_json(self.stages["arm64"] / runtime.BUILD_RECORD,
                           runtime.build_record(self.stages["arm64"], COMMIT, VERSION, "arm64"))
        lock = self.stages["arm64"] / "npm-shrinkwrap.json"
        lock.write_text(lock.read_text() + "\n")
        self.repack()
        with self.assertRaisesRegex(ValueError, "package/lock bytes changed"):
            runtime.verify_runtime_archive(self.archive(), COMMIT, VERSION, "arm64")

    def test_safe_symlinks_round_trip_and_escaping_links_fail(self):
        link = self.stages["arm64"] / "node_modules/.bin/openrappter"
        link.parent.mkdir()
        link.symlink_to("../../bin/openrappter.mjs")
        self.repack()
        runtime.verify_runtime_archive(self.archive(), COMMIT, VERSION, "arm64")
        link.unlink()
        link.symlink_to("../../../../outside")
        self.repack()
        with self.assertRaisesRegex(ValueError, "link escapes"):
            runtime.verify_runtime_archive(self.archive(), COMMIT, VERSION, "arm64")

    def test_case_colliding_and_special_archive_members_fail(self):
        for member in (tarfile.TarInfo("runtime/PACKAGE.json"), tarfile.TarInfo("runtime/socket")):
            if member.name.endswith("socket"):
                member.type = tarfile.FIFOTYPE
            self.archive().unlink()
            with tarfile.open(self.archive(), "w:gz") as archive:
                archive.add(self.stages["arm64"] / "package.json", arcname="runtime/package.json")
                archive.addfile(member)
            with self.assertRaisesRegex(ValueError, "case-colliding|special"):
                runtime.verify_runtime_archive(self.archive(), COMMIT, VERSION, "arm64")

    def test_output_is_deterministic_and_existing_bytes_are_not_overwritten(self):
        duplicate = self.work / "duplicate.tar.gz"
        os.utime(self.stages["arm64"] / "package.json", (1, 1))
        runtime.pack_runtime(self.stages["arm64"], duplicate, 1_700_000_000)
        self.assertEqual(self.archive().read_bytes(), duplicate.read_bytes())
        with self.assertRaisesRegex(ValueError, "never replace"):
            runtime.pack_runtime(self.stages["arm64"], duplicate, 1_700_000_000)
        with self.assertRaisesRegex(ValueError, "already exist"):
            runtime.create_metadata(self.payload, COMMIT, VERSION)

    def test_node_bytes_are_checked_before_executing_and_real_probe_checks_abi(self):
        node = self.work / "fake-node"
        node.write_bytes(b"inert Node fixture")
        with patch.object(runtime.subprocess, "run") as execute:
            with self.assertRaisesRegex(ValueError, "binary differs"):
                runtime.verify_node(node, "arm64")
            execute.assert_not_called()
        pins = runtime.load_pins()
        pins["variants"]["arm64"].update(binary_sha256=runtime.file_sha(node), binary_size=node.stat().st_size)
        probe = {"version": pins["variants"]["arm64"]["version"], "abi": 136, "arch": "arm64", "platform": "darwin"}
        with patch.object(runtime, "load_pins", return_value=pins), patch.object(runtime.subprocess, "run",
                return_value=subprocess.CompletedProcess([], 0, json.dumps(probe))):
            with self.assertRaisesRegex(ValueError, "architecture/version/ABI"):
                runtime.verify_node(node, "arm64")

    def test_node_archive_pin_is_checked_before_extraction(self):
        with self.assertRaisesRegex(ValueError, "archive differs"):
            runtime.extract_toolchain(self.archive(), self.work / "node", "arm64")
        self.assertFalse((self.work / "node").exists())

    def test_source_version_is_derived_and_stale_lock_versions_fail(self):
        source = self.work / "source"
        package = source / "typescript"
        package.mkdir(parents=True)
        runtime.write_json(package / "package.json", {"version": "7.8.9"})
        runtime.write_json(package / "package-lock.json", {"version": "7.8.8", "packages": {"": {"version": "7.8.9"}}})
        with patch.object(runtime, "ROOT", source):
            with self.assertRaisesRegex(ValueError, "versions disagree"):
                runtime.source_version()
            runtime.write_json(package / "package-lock.json", {"version": "7.8.9", "packages": {"": {"version": "7.8.9"}}})
            self.assertEqual(runtime.source_version(), "7.8.9")
            runtime.write_json(package / "package.json", {"version": "7.8.9-beta.1"})
            with self.assertRaisesRegex(ValueError, "must be X.Y.Z"):
                runtime.source_version()

    def test_source_identity_rejects_dirty_or_untracked_inputs_before_and_after_build(self):
        with patch.object(runtime.subprocess, "check_output", side_effect=[COMMIT, ""]), \
                patch.object(runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            self.assertEqual(runtime.verify_source(COMMIT), VERSION)
        with patch.object(runtime.subprocess, "check_output", return_value="b" * 40):
            with self.assertRaisesRegex(ValueError, "exact commit"):
                runtime.verify_source(COMMIT)
        with patch.object(runtime.subprocess, "check_output", return_value=COMMIT), \
                patch.object(runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)):
            with self.assertRaisesRegex(ValueError, "tracked changes"):
                runtime.verify_source(COMMIT)
        with patch.object(runtime.subprocess, "check_output", side_effect=[COMMIT, "typescript/src/uncommitted.ts\n"]), \
                patch.object(runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            with self.assertRaisesRegex(ValueError, "untracked build inputs"):
                runtime.verify_source(COMMIT)

    def test_workflows_preserve_two_tested_architectures_sealing_order_and_the_publish_gate(self):
        script = """
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = process.argv[1];
const yaml = createRequire(path.join(root, 'typescript/package.json'))('yaml');
const load = name => yaml.parse(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const build = load('build-bar-candidate.yml');
assert.deepEqual(build.jobs.runtime.strategy.matrix.include, [
  { architecture: 'arm64', runner: 'macos-14', machine: 'arm64' },
  { architecture: 'x86_64', runner: 'macos-15-intel', machine: 'x86_64' },
]);
assert.equal(build.jobs['signed-candidate'].needs, 'runtime');
assert.ok(!JSON.stringify(build.jobs.runtime).includes('secrets.'));
const signing = build.jobs['signed-candidate'].steps;
assert.ok(signing.findIndex(step => step.run?.includes('bar_runtime.py manifest'))
  < signing.findIndex(step => step.run?.includes('security import')));
const upload = signing.find(step => step.uses?.startsWith('actions/upload-artifact@'));
for (const name of ['runtime-bootstrap.json', 'verified-runtime-bootstrap.mjs', '-darwin-arm64.tar.gz', '-darwin-x86_64.tar.gz']) {
  assert.ok(upload.with.path.includes(name), `missing signed candidate input: ${name}`);
}
const candidate = load('build-candidate.yml').jobs.candidate.steps.map(step => step.run ?? '').join('\\n');
assert.ok(candidate.indexOf('cp bar-inputs/*') < candidate.indexOf('buildProvenance'));
assert.ok(candidate.indexOf('bar_runtime.py chunks') < candidate.indexOf('buildProvenance'));
assert.ok(candidate.includes('--parts-root candidate-parts'));
assert.ok(candidate.indexOf('buildProvenance') < candidate.indexOf('tar --sort=name'));
assert.ok(candidate.indexOf('check-transport') < candidate.indexOf('git push origin candidates'));
const publishCandidate = load('build-candidate.yml').jobs.candidate.steps.find(step => step.run?.includes('git push origin candidates')).run;
assert.ok(publishCandidate.includes('cp "candidate-parts/$name" "$path/$name"'));
assert.ok(publishCandidate.indexOf('done < candidate-part-checksums') < publishCandidate.indexOf('git add "$path" "$index"'));
assert.ok(publishCandidate.indexOf('git add "$path" "$index"') < publishCandidate.indexOf('git commit -m'));
assert.equal((publishCandidate.match(/git push origin candidates/g) ?? []).length, 1);
const release = load('release-bar.yml').jobs;
assert.equal(release['release-constitution'].name, 'Release Constitution');
assert.deepEqual(release.publish.needs, ['release-constitution', 'verify-dmg']);
const authority = release['release-constitution'].steps.find(step => step.with?.repository === 'kody-w/openrappter-release-train');
assert.equal(authority.with.ref, '931dd60f77c1e8b3a5c096fae6a5969061ccf569');
const publish = release.publish.steps.find(step => step.uses?.startsWith('softprops/action-gh-release@'));
assert.equal(publish.with.overwrite_files, false);
assert.ok(publish.with.files.includes('homebrew-proposal/runtime-bootstrap-proof.json'));
assert.ok(publish.with.files.includes('publish-runtimes/openrappter-runtime-'));
for (const job of Object.values(release)) {
  for (const step of job.steps ?? []) {
    if (step.run?.includes('bar_candidate.py verify') || step.run?.includes('bar_candidate.py cask')) {
      assert.ok(step.run.includes('--parts-root bar-release/candidate-parts'));
    }
  }
}
assert.ok(release.publish.steps.some(step => step.run?.includes('bar_runtime.py export')));
assert.ok(!JSON.stringify(release).includes('build-mac-app.sh'));
assert.ok(!JSON.stringify(release).includes('notarytool submit'));
"""
        result = subprocess.run(
            [os.environ.get("BAR_TEST_NODE", "node"), "--input-type=module", "-e", script, str(ROOT)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_app_requires_exact_sealed_resources_and_plist_commit(self):
        app = self.work / "OpenRappter Bar.app"
        app_fixture(app, self.payload, COMMIT, VERSION)
        runtime.verify_app(app, self.payload, COMMIT, VERSION)
        helper = app / "Contents/Resources" / runtime.HELPER
        helper.write_text("changed sealed resource")
        with self.assertRaisesRegex(ValueError, "sealed bootstrap resource"):
            runtime.verify_app(app, self.payload, COMMIT, VERSION)
        shutil.copyfile(self.payload / runtime.HELPER, helper)
        helper.unlink()
        with self.assertRaisesRegex(ValueError, "missing regular"):
            runtime.verify_app(app, self.payload, COMMIT, VERSION)
        shutil.copyfile(self.payload / runtime.HELPER, helper)
        info = app / "Contents/Info.plist"
        value = plistlib.loads(info.read_bytes())
        value["OpenRappterSourceCommit"] = "b" * 40
        info.write_bytes(plistlib.dumps(value))
        with self.assertRaisesRegex(ValueError, "source commit mismatch"):
            runtime.verify_app(app, self.payload, COMMIT, VERSION)

    def test_git_transport_size_limit_fails_without_omitting_or_splitting(self):
        bundle = self.work / "candidate.tar.gz"
        bundle.write_bytes(b"small")
        self.assertEqual(runtime.check_transport(bundle), 5)
        with bundle.open("wb") as file:
            file.truncate(runtime.GIT_BLOB_LIMIT + 1)
        with self.assertRaisesRegex(ValueError, "approved runtime chunk"):
            runtime.check_transport(bundle)


if __name__ == "__main__":
    unittest.main()
