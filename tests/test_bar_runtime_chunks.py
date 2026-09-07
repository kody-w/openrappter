import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import unittest
import uuid

from bar_runtime_fixtures import ROOT, runtime
import bar_runtime_chunks as chunks

COMMIT = "a" * 40
VERSION = runtime.source_version()


class RuntimeChunkTests(unittest.TestCase):
    def setUp(self):
        self.work = ROOT / ".test-scratch" / f"chunk-tests-{uuid.uuid4().hex}"
        self.work.mkdir(parents=True)
        self.parts = self.work / "parts"
        self.file = self.work / runtime.runtime_filename(VERSION, "arm64")
        self.file.write_bytes(b"opaque runtime archive fixture")
        self.pin = {"file": self.file.name, "sha256": runtime.file_sha(self.file), "size": self.file.stat().st_size}
        self.descriptor_file = self.work / chunks.descriptor_name(self.pin)
        self.descriptor = chunks.split_archive(self.file, self.pin, COMMIT, VERSION, "arm64", self.parts, self.descriptor_file)
        candidate_id = "tag-" + base64.urlsafe_b64encode(f"v{VERSION}".encode()).decode().rstrip("=")
        self.url = f"https://raw.githubusercontent.com/kody-w/openrappter/{'b' * 40}/candidates/{COMMIT}/release/{candidate_id}/{'c' * 64}.tar.gz"

    def tearDown(self):
        shutil.rmtree(self.work)

    def test_descriptor_is_closed_and_exactly_binds_the_sealed_runtime(self):
        self.assertEqual(chunks.load_descriptor(self.descriptor_file, self.pin, COMMIT, VERSION, "arm64"), self.descriptor)
        part = self.descriptor["parts"][0]
        self.assertEqual(part["file"], f"runtime-arm64-0000-{part['sha256']}.part")
        self.assertEqual(set(self.descriptor), {"schema", "source_commit", "version", "architecture", "file", "sha256", "size", "parts"})
        for field, value in (("schema", "other"), ("source_commit", "b" * 40), ("version", "7.8.9"),
                             ("architecture", "x86_64"), ("file", "other.tar.gz"), ("sha256", "0" * 64), ("size", 1)):
            changed = {**self.descriptor, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                chunks.validate_descriptor(changed, self.pin, COMMIT, VERSION, "arm64")
        with self.assertRaisesRegex(ValueError, "not closed"):
            chunks.validate_descriptor({**self.descriptor, "url": "https://other.example/"}, self.pin, COMMIT, VERSION, "arm64")

    def test_real_32_mib_boundaries_and_streamed_reassembly_are_exact(self):
        self.file.unlink()
        with self.file.open("wb") as target:
            block = bytes(range(256)) * 4096
            for _ in range(64):
                target.write(block)
            target.write(b"last chunk suffix")
        pin = {"file": self.file.name, "sha256": runtime.file_sha(self.file), "size": self.file.stat().st_size}
        parts = self.work / "large-parts"
        descriptor = chunks.split_archive(self.file, pin, COMMIT, VERSION, "arm64", parts, self.work / "large.parts.json")
        self.assertEqual([p["size"] for p in descriptor["parts"]], [chunks.CHUNK_BYTES, chunks.CHUNK_BYTES, 17])
        output = self.work / "joined.tar.gz"
        chunks.verify_parts(descriptor, parts, output)
        self.assertEqual(runtime.file_sha(output), pin["sha256"])
        self.assertEqual(output.stat().st_size, pin["size"])
        with self.assertRaises(FileExistsError):
            chunks.verify_parts(descriptor, parts, output)
        self.assertEqual(runtime.file_sha(output), pin["sha256"], "existing output is never replaced")

    def test_part_order_names_paths_extra_fields_and_invalid_counts_are_refused(self):
        cases = []
        for name in ("../outside", "/absolute", "runtime-arm64-0001-" + "0" * 64 + ".part"):
            value = copy.deepcopy(self.descriptor)
            value["parts"][0]["file"] = name
            cases.append(value)
        for size in (0, -1, True, chunks.CHUNK_BYTES + 1):
            value = copy.deepcopy(self.descriptor)
            value["parts"][0]["size"] = size
            cases.append(value)
        value = copy.deepcopy(self.descriptor)
        value["parts"][0]["url"] = "https://other.example/"
        cases.extend([value, {**self.descriptor, "parts": []}, {**self.descriptor, "parts": self.descriptor["parts"] * 65}])
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                chunks.validate_descriptor(value, self.pin, COMMIT, VERSION, "arm64")

    def test_nonfinal_chunks_must_be_full_and_the_sum_must_match(self):
        value = copy.deepcopy(self.descriptor)
        second = copy.deepcopy(value["parts"][0])
        second["file"] = second["file"].replace("-0000-", "-0001-")
        value["parts"].append(second)
        value["size"] *= 2
        pin = {key: value[key] for key in ("file", "sha256", "size")}
        with self.assertRaisesRegex(ValueError, "boundary"):
            chunks.validate_descriptor(value, pin, COMMIT, VERSION, "arm64")
        value = copy.deepcopy(self.descriptor)
        value["size"] += 1
        pin["size"] = value["size"]
        with self.assertRaisesRegex(ValueError, "sum"):
            chunks.validate_descriptor(value, pin, COMMIT, VERSION, "arm64")

    def test_missing_short_changed_and_symlinked_parts_fail(self):
        file = self.parts / self.descriptor["parts"][0]["file"]
        original = file.read_bytes()
        for value in (None, original[:-1], bytes(len(original))):
            file.unlink()
            if value is not None:
                file.write_bytes(value)
            with self.assertRaisesRegex(ValueError, "missing regular|size mismatch|checksum mismatch"):
                chunks.verify_parts(self.descriptor, self.parts)
            if file.exists():
                file.unlink()
            file.write_bytes(original)
        file.unlink()
        file.symlink_to(self.file)
        with self.assertRaisesRegex(ValueError, "regular runtime part"):
            chunks.verify_parts(self.descriptor, self.parts)

    def test_per_part_success_cannot_hide_a_wrong_whole_archive_hash(self):
        value = copy.deepcopy(self.descriptor)
        value["sha256"] = "0" * 64
        output = self.work / "bad.tar.gz"
        with self.assertRaisesRegex(ValueError, "reassembled runtime"):
            chunks.verify_parts(value, self.parts, output)
        self.assertFalse(output.exists(), "failed reassembly must not leave a usable output")

    def test_urls_are_derived_only_from_the_same_frozen_candidate_directory(self):
        part = self.descriptor["parts"][0]
        self.assertEqual(chunks.part_url(self.url, self.descriptor, part), self.url.rsplit("/", 1)[0] + "/" + part["file"])
        for url in (self.url.replace("b" * 40, "main"), self.url.replace(COMMIT, "d" * 40),
                    self.url.replace("raw.githubusercontent.com", "other.example"), self.url + "?download=1", self.url + "#part"):
            with self.assertRaisesRegex(ValueError, "frozen or source-bound"):
                chunks.part_url(url, self.descriptor, part)

    def test_available_parts_download_verify_and_missing_parts_fail_closed(self):
        requested = []
        def opener(request, timeout):
            requested.append(request.full_url)
            self.assertEqual(timeout, 120)
            return io.BytesIO(self.file.read_bytes())
        output = self.work / "downloaded"
        chunks.fetch_parts(self.descriptor, self.url, output, opener)
        self.assertEqual(requested, [self.url.rsplit("/", 1)[0] + "/" + self.descriptor["parts"][0]["file"]])
        chunks.verify_parts(self.descriptor, output)
        def unavailable(request, timeout):
            raise OSError("missing immutable part")
        with self.assertRaisesRegex(OSError, "missing immutable"):
            chunks.fetch_parts(self.descriptor, self.url, self.work / "missing", unavailable)
        with self.assertRaisesRegex(ValueError, "checksum/size mismatch"):
            chunks.fetch_parts(self.descriptor, self.url, self.work / "changed",
                               lambda request, timeout: io.BytesIO(bytes(self.pin["size"])))
        self.assertEqual(list((self.work / "changed").iterdir()), [])

    def test_readonly_validation_spools_only_inside_the_repository_and_cleans_up(self):
        with chunks.assembled_archive(self.descriptor, self.parts) as archive:
            self.assertTrue(archive.is_relative_to(ROOT / ".test-scratch"))
            self.assertEqual(runtime.file_sha(archive), self.pin["sha256"])
        self.assertFalse(archive.exists())


if __name__ == "__main__":
    unittest.main()
