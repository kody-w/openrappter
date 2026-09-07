"""Small inert archives built by the real producer for contract tests."""
import json
from pathlib import Path
import shutil
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import bar_runtime as runtime


def stage_runtime(work, architecture, commit, version):
    stage = work / architecture
    stage.mkdir(parents=True)
    files = {
        "package.json": (ROOT / "typescript/package.json").read_bytes(),
        "npm-shrinkwrap.json": (ROOT / "typescript/package-lock.json").read_bytes(),
        "LICENSE": (ROOT / "LICENSE").read_bytes(),
        "dist/index.js": b"export const fixture = true;\n",
        "bin/openrappter.mjs": b"export const fixture = true;\n",
        "ui/dist/index.html": b"<!doctype html><html></html>",
        "ui/dist/release-ring-selector.js": b"export const fixture = true;\n",
        "ui/dist/release-ring-selector.d.ts": b"export declare const fixture: true;\n",
        "ui/dist/assets/index.js": b"export const fixture = true;\n",
    }
    for name in ("better-sqlite3", "sharp", "@github/copilot"):
        files[f"node_modules/{name}/package.json"] = json.dumps({"name": name}).encode()
    cpu = 0x0100000C if architecture == "arm64" else 0x01000007
    for name in runtime.native_paths(architecture):
        files[name] = b"\xcf\xfa\xed\xfe" + struct.pack("<I", cpu) + bytes(24)
    for name, content in files.items():
        destination = stage / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    runtime.write_json(stage / runtime.BUILD_RECORD, runtime.build_record(stage, commit, version, architecture))
    return stage


def runtime_inputs(work, destination, commit, version):
    stages = {}
    for architecture in runtime.ARCHITECTURES:
        stage = stage_runtime(work, architecture, commit, version)
        runtime.pack_runtime(stage, destination / runtime.runtime_filename(version, architecture), 1_700_000_000)
        stages[architecture] = stage
    runtime.create_metadata(destination, commit, version)
    return stages


def app_fixture(destination, payload, commit, version):
    import plistlib
    contents = destination / "Contents"
    (contents / "Resources").mkdir(parents=True)
    (contents / "MacOS").mkdir()
    (contents / "MacOS/OpenRappterBar").write_bytes(b"inert app fixture")
    with (contents / "Info.plist").open("wb") as file:
        plistlib.dump({
            "CFBundleIdentifier": "com.openrappter.bar",
            "CFBundleVersion": version, "CFBundleShortVersionString": version,
            "OpenRappterSourceCommit": commit,
        }, file)
    for name in (runtime.METADATA, runtime.HELPER):
        shutil.copyfile(payload / name, contents / "Resources" / name)
