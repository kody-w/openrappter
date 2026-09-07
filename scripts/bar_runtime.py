#!/usr/bin/env python3
"""Produce dependency-complete, exact-ABI Bar runtimes before app signing."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import unicodedata
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ARCHITECTURES = ("arm64", "x86_64")
METADATA = "runtime-bootstrap.json"
HELPER = "verified-runtime-bootstrap.mjs"
BUILD_RECORD = "runtime-build.json"
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
MAX_EXPANDED = 1024 * 1024 * 1024
GIT_BLOB_LIMIT = 100 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def closed(value, keys, label):
    require(isinstance(value, dict) and set(value) == set(keys), f"{label} is not closed")


def file_sha(file):
    with Path(file).open("rb") as source:
        value = hashlib.sha256()
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def regular(file):
    file = Path(file)
    require(file.is_file() and not file.is_symlink(), f"missing regular runtime resource: {file.name}")
    return file


def write_json(file, value):
    Path(file).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def source_version():
    value = json.loads((ROOT / "typescript/package.json").read_text())["version"]
    require(isinstance(value, str) and VERSION.fullmatch(value), "source Bar version must be X.Y.Z")
    lock = json.loads((ROOT / "typescript/package-lock.json").read_text())
    require(lock.get("version") == value and lock.get("packages", {}).get("", {}).get("version") == value,
            "source package/lock versions disagree")
    return value


def identity(commit, version):
    require(isinstance(commit, str) and HEX40.fullmatch(commit), "source commit must be exact")
    require(isinstance(version, str) and VERSION.fullmatch(version), "Bar version must be X.Y.Z")


def pins_path():
    return ROOT / "macos/runtime-node-pins.json"


def load_pins():
    value = json.loads(regular(pins_path()).read_text())
    closed(value, ("schema", "node_abi", "variants"), "Node pins")
    require(value["schema"] == "openrappter-bar-node-pins/v1", "unknown Node pin schema")
    require(type(value["node_abi"]) is int and value["node_abi"] > 0, "invalid pinned Node ABI")
    closed(value["variants"], ARCHITECTURES, "Node architectures")
    versions = set()
    for architecture, pin in value["variants"].items():
        closed(pin, ("version", "url", "sha256", "size", "binary_path", "binary_sha256", "binary_size"), "Node pin")
        version = pin["version"]
        require(isinstance(version, str) and VERSION.fullmatch(version) and int(version.split(".")[0]) >= 24, "Node 24+ must be exactly pinned")
        versions.add(version)
        node_arch = "x64" if architecture == "x86_64" else architecture
        root = f"node-v{version}-darwin-{node_arch}"
        require(pin["url"] == f"https://nodejs.org/dist/v{version}/{root}.tar.gz"
                and pin["binary_path"] == f"{root}/bin/node", "Node URL/architecture is not exact")
        for sha, size in (("sha256", "size"), ("binary_sha256", "binary_size")):
            require(isinstance(pin[sha], str) and HEX64.fullmatch(pin[sha]), "invalid Node digest pin")
            require(type(pin[size]) is int and 0 < pin[size] <= MAX_EXPANDED // 4, "invalid Node size pin")
    require(len(versions) == 1, "both architectures must use the same pinned Node version/ABI")
    return value


def verify_node(node, architecture):
    pins = load_pins()
    require(architecture in ARCHITECTURES, "unsupported architecture")
    pin = pins["variants"][architecture]
    require(regular(node).stat().st_size == pin["binary_size"]
            and file_sha(node) == pin["binary_sha256"], "Node binary differs from the reviewed pin")
    probe = subprocess.run(
        [str(node), "-p", "JSON.stringify({version:process.versions.node,abi:Number(process.versions.modules),arch:process.arch,platform:process.platform})"],
        check=True, capture_output=True, text=True,
        env={**os.environ, "NODE_OPTIONS": "", "NODE_PATH": ""},
    )
    actual = json.loads(probe.stdout)
    expected = {"version": pin["version"], "abi": pins["node_abi"],
                "arch": "x64" if architecture == "x86_64" else architecture, "platform": "darwin"}
    require(actual == expected, "Node architecture/version/ABI does not match the reviewed pin")
    return actual


def relative_name(name):
    require(isinstance(name, str) and name and len(name) <= 4096
            and not re.search(r"[\x00-\x1f\x7f\\]", name) and not name.startswith("/"), "unsafe runtime archive path")
    stripped = name.removesuffix("/")
    require(all(part and part not in (".", "..") for part in stripped.split("/")), "runtime archive traversal")
    return stripped


def link_target(name, link, root):
    require(link and not link.startswith("/") and not re.search(r"[\x00-\x1f\x7f\\]", link), "unsafe runtime link")
    parts = list(PurePosixPath(name).parent.parts)
    for part in link.split("/"):
        if part == "..":
            require(len(parts) > 1, "runtime link escapes its root")
            parts.pop()
        elif part not in ("", "."):
            parts.append(part)
    target = "/".join(parts)
    require(target.startswith(root + "/"), "runtime link escapes its root")
    return target


def archive_entries(archive, root):
    """Validate the same path/type subset accepted by the sealed JS consumer."""
    names, folded, links = {}, set(), {}
    total = 0
    for member in archive:
        name = relative_name(member.name)
        fold = unicodedata.normalize("NFC", name).lower()
        require(fold not in folded, "duplicate or case-colliding runtime path")
        folded.add(fold)
        require(name == root or name.startswith(root + "/"), f"archive requires one {root}/ root")
        require(member.isdir() or member.isfile() or member.issym(), "special/hardlink runtime member rejected")
        require(not member.sparse and not any(key.startswith("GNU.sparse") or key == "SCHILY.filetype" for key in member.pax_headers), "sparse runtime member rejected")
        require(member.isfile() or member.size == 0, "non-file archive payload rejected")
        require(0 <= member.size <= MAX_EXPANDED // 2, "runtime member exceeds its byte limit")
        total += member.size + 512
        require(total <= MAX_EXPANDED and len(names) < 100_000, "expanded runtime archive exceeds its limit")
        names[name] = member
        if member.issym():
            links[name] = link_target(name, member.linkname, root)
        yield name, member
    for name, target in links.items():
        seen = {name}
        while target in links:
            require(target not in seen and len(seen) < 32, "runtime link cycle")
            seen.add(target)
            target = links[target]
        require(target in names and (names[target].isfile() or names[target].isdir()), "runtime link target is missing")
    for name in names:
        require(not any(str(parent) in links for parent in PurePosixPath(name).parents), "runtime path traverses a link")


def extract_toolchain(archive_path, destination, architecture):
    pin = load_pins()["variants"][architecture]
    require(regular(archive_path).stat().st_size == pin["size"]
            and file_sha(archive_path) == pin["sha256"], "Node archive differs from the reviewed pin")
    root = pin["binary_path"].split("/")[0]
    require(not destination.exists(), "Node toolchain destination already exists")
    with tarfile.open(archive_path, "r:gz") as archive:
        members = list(archive_entries(archive, root))
        destination.mkdir(parents=True)
        for name, member in members:
            if name == root:
                continue
            file = destination / name.removeprefix(root + "/")
            file.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                file.mkdir(exist_ok=True)
            elif member.isfile():
                with archive.extractfile(member) as source, file.open("xb") as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
                file.chmod(0o755 if member.mode & 0o111 else 0o644)
        for name, member in members:
            if member.issym():
                (destination / name.removeprefix(root + "/")).symlink_to(member.linkname)
    verify_node(destination / "bin/node", architecture)


def native_architectures(header):
    cpu_names = {0x0100000C: "arm64", 0x01000007: "x86_64"}
    if header[:4] in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe"):
        return {cpu_names.get(struct.unpack("<I", header[4:8])[0], "unsupported")}
    if header[:4] in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        count = struct.unpack(">I", header[4:8])[0]
        stride = 32 if header[:4] == b"\xca\xfe\xba\xbf" else 20
        require(0 < count <= 16 and len(header) >= 8 + count * stride, "invalid universal native binary")
        return {cpu_names.get(struct.unpack(">I", header[8 + i * stride:12 + i * stride])[0], "unsupported") for i in range(count)}
    return set()


def native_paths(architecture):
    arch = "x64" if architecture == "x86_64" else architecture
    lock = json.loads((ROOT / "typescript/package-lock.json").read_text())
    sharp_version = lock["packages"][f"node_modules/@img/sharp-darwin-{arch}"]["version"]
    return (
        "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        f"node_modules/@img/sharp-darwin-{arch}/lib/sharp-darwin-{arch}-{sharp_version}.node",
        f"node_modules/@github/copilot-darwin-{arch}/copilot",
        f"node_modules/@github/copilot-darwin-{arch}/ripgrep/bin/darwin-{arch}/rg",
        f"node_modules/@github/copilot-darwin-{arch}/tgrep/bin/darwin-{arch}/tgrep",
    )


def platform_extra_pairs(architecture):
    arch = "x64" if architecture == "x86_64" else architecture
    base = f"node_modules/@github/copilot-darwin-{arch}"
    prefix = f"{base}/clipboard/node_modules/@teddyzhu/clipboard"
    tags = ("darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-x64-gnu",
            "win32-arm64-msvc", "win32-x64-msvc")
    pairs = {f"{prefix}/clipboard.{tag}.node": f"{prefix}/clipboard.darwin-{arch}.node"
             for tag in tags if tag != f"darwin-{arch}"}
    other = "arm64" if arch == "x64" else "x64"
    for tool, binary in (("ripgrep", "rg"), ("tgrep", "tgrep")):
        pairs[f"{base}/{tool}/bin/darwin-{other}/{binary}"] = f"{base}/{tool}/bin/darwin-{arch}/{binary}"
    return pairs


def platform_extras(architecture):
    return set(platform_extra_pairs(architecture))


def prune_platform_extras(stage, architecture):
    # Copilot's clipboard/search loaders select process.platform/process.arch.
    # Prune only explicit alternatives, preserving each matching binary and all licenses.
    removed = []
    pairs = platform_extra_pairs(architecture)
    for name in sorted(pairs):
        file = stage / name
        if file.exists():
            regular(file)
            regular(stage / pairs[name])
            file.unlink()
            removed.append(name)
    return removed


def build_record(stage, commit, version, architecture, omitted_platform_files=()):
    return {
        **build_record_keys(commit, version, architecture),
        "native_files": {name: file_sha(regular(stage / name)) for name in native_paths(architecture)},
        "omitted_platform_files": list(omitted_platform_files),
    }


def pack_runtime(stage, destination, epoch):
    require(not destination.exists(), "runtime archive already exists; never replace candidate bytes")
    with destination.open("xb") as target, gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for file in [stage, *sorted(stage.rglob("*"))]:
                name = "runtime" if file == stage else "runtime/" + file.relative_to(stage).as_posix()
                info = archive.gettarinfo(str(file), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = epoch
                info.pax_headers = {}
                info.mode = 0o755 if info.isdir() or info.mode & 0o111 else 0o644
                if info.isfile():
                    with file.open("rb") as source:
                        archive.addfile(info, source)
                else:
                    archive.addfile(info)


def runtime_filename(version, architecture):
    return f"openrappter-runtime-{version}-darwin-{architecture}.tar.gz"


def verify_runtime_archive(file, commit, version, architecture):
    identity(commit, version)
    require(architecture in ARCHITECTURES, "unsupported runtime architecture")
    require(regular(file).stat().st_size <= MAX_EXPANDED // 2, "runtime archive exceeds its limit")
    documents, hashes, natives, names = {}, {}, {}, set()
    with tarfile.open(file, "r:gz") as archive:
        for name, member in archive_entries(archive, "runtime"):
            names.add(name)
            if not member.isfile():
                continue
            relative = name.removeprefix("runtime/")
            capture = relative in (BUILD_RECORD, "package.json", "npm-shrinkwrap.json")
            require(not capture or member.size < 4 * 1024 * 1024, "runtime metadata exceeds its limit")
            sha, chunks, header = hashlib.sha256(), [], b""
            with archive.extractfile(member) as source:
                while chunk := source.read(1024 * 1024):
                    sha.update(chunk)
                    if not header:
                        header = chunk[:4096]
                    if capture:
                        chunks.append(chunk)
            hashes[relative] = sha.hexdigest()
            if capture:
                documents[relative] = json.loads(b"".join(chunks))
            architectures = native_architectures(header)
            if architectures or relative.endswith((".node", ".dylib")):
                require(architecture in architectures, f"native dependency architecture mismatch: {relative}")
                natives[relative] = sha.hexdigest()
    for required in ("package.json", "npm-shrinkwrap.json", BUILD_RECORD, "LICENSE",
                     "dist/index.js", "bin/openrappter.mjs", "ui/dist/index.html",
                     "ui/dist/release-ring-selector.js", "ui/dist/release-ring-selector.d.ts",
                     "node_modules/better-sqlite3/package.json", "node_modules/sharp/package.json",
                     "node_modules/@github/copilot/package.json", *native_paths(architecture)):
        require(required in hashes, f"runtime dependency/resource is missing: {required}")
    require(any(name.startswith("runtime/ui/dist/assets/") and name.endswith(".js") for name in names), "packaged dashboard assets are missing")
    record = documents[BUILD_RECORD]
    expected = build_record_keys(commit, version, architecture)
    closed(record, (*expected, "native_files", "omitted_platform_files"), "runtime build record")
    require(all(record[key] == value for key, value in expected.items()), "runtime source/lock/Node ABI pin is stale")
    omitted = record["omitted_platform_files"]
    require(isinstance(omitted, list) and all(isinstance(name, str) for name in omitted)
            and len(set(omitted)) == len(omitted) and set(omitted) <= platform_extras(architecture)
            and not set(omitted).intersection(hashes), "unexpected runtime dependency omission")
    require(record["native_files"] == {name: natives.get(name) for name in native_paths(architecture)}
            and all(record["native_files"].values()), "native dependency digest mismatch")
    package = documents["package.json"]
    require(package.get("name") == "openrappter" and package.get("version") == version, "runtime package identity mismatch")
    require(hashes["package.json"] == expected["package_json_sha256"]
            and hashes["npm-shrinkwrap.json"] == expected["package_lock_sha256"], "runtime package/lock bytes changed")
    return record


def build_record_keys(commit, version, architecture):
    pins = load_pins()
    pin = pins["variants"][architecture]
    return {
        "schema": "openrappter-bar-runtime/v1", "source_commit": commit, "version": version,
        "architecture": architecture, "node_version": pin["version"], "node_abi": pins["node_abi"],
        "node_binary_sha256": pin["binary_sha256"], "node_pins_sha256": file_sha(pins_path()),
        "package_json_sha256": file_sha(ROOT / "typescript/package.json"),
        "package_lock_sha256": file_sha(ROOT / "typescript/package-lock.json"),
        "ui_lock_sha256": file_sha(ROOT / "typescript/ui/package-lock.json"),
    }


def create_metadata(root, commit, version):
    identity(commit, version)
    require(not (root / METADATA).exists() and not (root / HELPER).exists(), "bootstrap resources already exist")
    pins, variants = load_pins(), {}
    for architecture in ARCHITECTURES:
        file = root / runtime_filename(version, architecture)
        verify_runtime_archive(file, commit, version, architecture)
        variants[architecture] = {"node": pins["variants"][architecture], "runtime": {
            "file": file.name, "sha256": file_sha(file), "size": file.stat().st_size,
        }}
    helper = regular(ROOT / "macos/Resources" / HELPER)
    value = {
        "schema": "openrappter-bar-bootstrap/v1", "source_commit": commit, "version": version,
        "approval_url": f"https://github.com/kody-w/openrappter/releases/download/v{version}-bar/runtime-bootstrap-proof.json",
        "helper_sha256": file_sha(helper), "variants": variants,
    }
    shutil.copyfile(helper, root / HELPER)
    write_json(root / METADATA, value)
    return value


def verify_bootstrap(root, commit, version, inspect_archives=True):
    identity(commit, version)
    value = json.loads(regular(root / METADATA).read_text())
    closed(value, ("schema", "source_commit", "version", "approval_url", "helper_sha256", "variants"), "bootstrap metadata")
    require(value["schema"] == "openrappter-bar-bootstrap/v1" and value["source_commit"] == commit
            and value["version"] == version, "bootstrap source/version identity mismatch")
    require(value["approval_url"] == f"https://github.com/kody-w/openrappter/releases/download/v{version}-bar/runtime-bootstrap-proof.json", "bootstrap proof URL is not exact")
    require(file_sha(regular(root / HELPER)) == value["helper_sha256"]
            == file_sha(regular(ROOT / "macos/Resources" / HELPER)), "sealed helper digest/source mismatch")
    closed(value["variants"], ARCHITECTURES, "bootstrap architectures")
    pins = load_pins()
    for architecture, variant in value["variants"].items():
        closed(variant, ("node", "runtime"), "bootstrap variant")
        require(variant["node"] == pins["variants"][architecture], "bootstrap Node pin is stale")
        artifact = variant["runtime"]
        closed(artifact, ("file", "sha256", "size"), "runtime archive pin")
        require(artifact["file"] == runtime_filename(version, architecture), "runtime archive name/version mismatch")
        file = regular(root / artifact["file"])
        require(type(artifact["size"]) is int and 0 < artifact["size"] <= MAX_EXPANDED // 2
                and file.stat().st_size == artifact["size"] and file_sha(file) == artifact["sha256"], "runtime archive digest/size mismatch")
        if inspect_archives:
            verify_runtime_archive(file, commit, version, architecture)
    return value


def verify_app(app, root, commit, version):
    value = verify_bootstrap(root, commit, version, inspect_archives=False)
    contents = app / "Contents"
    with regular(contents / "Info.plist").open("rb") as source:
        info = plistlib.load(source)
    require(info.get("OpenRappterSourceCommit") == commit, "app source commit mismatch")
    require(info.get("CFBundleShortVersionString") == version and info.get("CFBundleVersion") == version
            and info.get("CFBundleIdentifier") == "com.openrappter.bar", "app bundle identity mismatch")
    for name in (METADATA, HELPER):
        require(file_sha(regular(contents / "Resources" / name)) == file_sha(regular(root / name)), "app sealed bootstrap resource differs from candidate")
    return value


def check_transport(bundle):
    size = regular(bundle).stat().st_size
    require(size <= GIT_BLOB_LIMIT,
            f"canonical candidate is {size} bytes; raw candidate git transport is limited to {GIT_BLOB_LIMIT} bytes. "
            "Do not omit dependencies or split bytes without an approved authority/consumer transport contract.")
    return size


def build(architecture, commit, output, work, node_archive=None):
    identity(commit, source_version())
    require(architecture in ARCHITECTURES and sys.platform == "darwin", "runtime producer requires its macOS architecture")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    require(head == commit, "runtime build is not checked out at the exact source commit")
    version = source_version()
    epoch = int(subprocess.check_output(["git", "show", "-s", "--format=%ct", commit], cwd=ROOT, text=True).strip())
    before = build_record_keys(commit, version, architecture)
    work.mkdir(parents=True, exist_ok=False)
    output.mkdir(parents=True, exist_ok=True)
    pin = load_pins()["variants"][architecture]
    if node_archive is None:
        node_archive = work / "node.tar.gz"
        with urllib.request.urlopen(pin["url"], timeout=120) as source, node_archive.open("xb") as target:
            total = 0
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                require(total <= pin["size"], "Node download exceeds its pin")
                target.write(chunk)
    extract_toolchain(node_archive, work / "node", architecture)
    node = work / "node/bin/node"
    npm = [str(node), str(work / "node/lib/node_modules/npm/bin/npm-cli.js")]
    home, scratch = work / "home", work / "scratch"
    home.mkdir()
    scratch.mkdir()
    env = {**os.environ, "HOME": str(home), "CFFIXED_USER_HOME": str(home), "TMPDIR": str(scratch),
           "PATH": str(node.parent) + os.pathsep + os.environ.get("PATH", ""),
           "NODE_PATH": "", "NODE_OPTIONS": "", "MACOSX_DEPLOYMENT_TARGET": "14.0",
           "npm_config_cache": os.environ.get("npm_config_cache", str(work / "npm-cache")),
           "npm_config_userconfig": str(home / ".npmrc")}

    def run(args, cwd, capture=False):
        return subprocess.run(args, cwd=cwd, env=env, check=True, text=True,
                              stdout=subprocess.PIPE if capture else None)

    package = ROOT / "typescript"
    run([*npm, "ci", "--no-audit", "--no-fund"], package)
    run([*npm, "run", "build"], package)
    packed = json.loads(run([*npm, "pack", "--dry-run", "--ignore-scripts", "--json"], package, True).stdout)[0]
    stage = work / "runtime"
    stage.mkdir()
    for row in packed["files"]:
        name = relative_name(row["path"])
        source = regular(package / name)
        destination = stage / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    shutil.copyfile(ROOT / "LICENSE", stage / "LICENSE")
    shutil.copyfile(package / "package-lock.json", stage / "npm-shrinkwrap.json")
    run([*npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], stage)
    run([*npm, "ls", "--omit=dev", "--all"], stage, True)
    omitted = prune_platform_extras(stage, architecture)
    verify_node(node, architecture)
    require(before == build_record_keys(commit, version, architecture), "source locks/pins changed while building")
    write_json(stage / BUILD_RECORD, build_record(stage, commit, version, architecture, omitted))
    destination = work / runtime_filename(version, architecture)
    pack_runtime(stage, destination, epoch)
    verify_runtime_archive(destination, commit, version, architecture)
    run([str(node), str(ROOT / "scripts/bar-runtime-smoke.mjs"),
         "--archive", str(destination), "--work", str(work / "smoke"),
         "--architecture", architecture, "--version", version], ROOT)
    result = {"file": destination.name, "sha256": file_sha(destination), "size": destination.stat().st_size,
              "source_commit": commit, "version": version, "architecture": architecture,
              "node_version": pin["version"], "node_abi": load_pins()["node_abi"],
              "omitted_platform_files": omitted}
    # A failed build/smoke never becomes an input to the signing job.
    os.link(destination, output / destination.name)
    write_json(work / "build-result.json", result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("build", "manifest", "verify", "verify-app", "check-transport"))
    parser.add_argument("--commit")
    parser.add_argument("--version")
    parser.add_argument("--architecture", choices=ARCHITECTURES)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--work", type=Path)
    parser.add_argument("--node-archive", type=Path)
    parser.add_argument("--app", type=Path)
    parser.add_argument("--bundle", type=Path)
    args = parser.parse_args()
    root = args.root.resolve() if args.root else None
    if args.command == "build":
        require(root is not None and args.work is not None, "build requires --root and --work")
        result = build(args.architecture, args.commit, root, args.work.resolve(),
                       args.node_archive.resolve() if args.node_archive else None)
    elif args.command == "manifest":
        result = create_metadata(root, args.commit, args.version or source_version())
    elif args.command == "verify":
        result = verify_bootstrap(root, args.commit, args.version)
    elif args.command == "verify-app":
        result = verify_app(args.app.resolve(), root, args.commit, args.version)
    else:
        result = {"bundle_bytes": check_transport(args.bundle)}
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Bar runtime producer refused: {error}", file=sys.stderr)
        raise SystemExit(1)
