"""Approved runtime-chunk transport; URLs remain relative to one frozen candidate."""
import base64
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import shutil
import urllib.request
import uuid

CHUNK_BYTES = 32 * 1024 * 1024
MAX_PARTS = 64
MAX_RUNTIME_BYTES = 512 * 1024 * 1024
SCHEMA = "openrappter-runtime-chunks/v1"
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def closed(value, keys, label):
    require(isinstance(value, dict) and set(value) == set(keys), f"{label} is not closed")


def regular(file):
    require(file.is_file() and not file.is_symlink(), f"missing regular runtime part: {file.name}")
    return file


def descriptor_name(artifact):
    return artifact["file"] + ".parts.json"


def validate_descriptor(value, artifact, commit, version, architecture):
    closed(value, ("schema", "source_commit", "version", "architecture", "file", "sha256", "size", "parts"), "runtime chunk descriptor")
    require(isinstance(commit, str) and HEX40.fullmatch(commit)
            and isinstance(version, str) and VERSION.fullmatch(version)
            and architecture in ("arm64", "x86_64"), "invalid chunk source identity")
    require(value["schema"] == SCHEMA and value["source_commit"] == commit
            and value["version"] == version and value["architecture"] == architecture, "chunk source identity mismatch")
    expected_file = f"openrappter-runtime-{version}-darwin-{architecture}.tar.gz"
    require(value["file"] == artifact["file"] == expected_file
            and value["sha256"] == artifact["sha256"] and value["size"] == artifact["size"], "chunk descriptor differs from sealed runtime")
    require(isinstance(value["sha256"], str) and HEX64.fullmatch(value["sha256"])
            and type(value["size"]) is int and 0 < value["size"] <= MAX_RUNTIME_BYTES, "invalid whole-runtime chunk pin")
    parts = value["parts"]
    require(isinstance(parts, list) and 1 <= len(parts) <= MAX_PARTS, "runtime chunk count must be 1..64")
    total = 0
    for index, part in enumerate(parts):
        closed(part, ("file", "sha256", "size"), "runtime part")
        require(isinstance(part["sha256"], str) and HEX64.fullmatch(part["sha256"]), "invalid runtime part digest")
        require(part["file"] == f"runtime-{architecture}-{index:04d}-{part['sha256']}.part", "runtime part name/order mismatch")
        require(type(part["size"]) is int and 0 < part["size"] <= CHUNK_BYTES
                and (index == len(parts) - 1 or part["size"] == CHUNK_BYTES), "invalid runtime chunk boundary")
        total += part["size"]
    require(total == value["size"], "runtime chunk sizes do not sum to the sealed size")
    return value


def load_descriptor(file, artifact, commit, version, architecture):
    require(regular(file).stat().st_size <= 1024 * 1024, "runtime chunk descriptor exceeds its limit")
    return validate_descriptor(json.loads(file.read_text()), artifact, commit, version, architecture)


def verify_parts(descriptor, directory, output=None):
    validate_descriptor(descriptor, descriptor, descriptor["source_commit"], descriptor["version"], descriptor["architecture"])
    require(directory is not None and directory.is_dir() and not directory.is_symlink(), "runtime parts directory is required")
    whole, total, target = hashlib.sha256(), 0, None
    try:
        if output is not None:
            target = output.open("xb")
        for part in descriptor["parts"]:
            file = regular(directory / part["file"])
            require(file.stat().st_size == part["size"], f"runtime part size mismatch: {file.name}")
            sha, size = hashlib.sha256(), 0
            with file.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    require(size <= part["size"], "runtime part grew while reading")
                    sha.update(chunk)
                    whole.update(chunk)
                    if target is not None:
                        target.write(chunk)
            require(size == part["size"] and sha.hexdigest() == part["sha256"], f"runtime part checksum mismatch: {file.name}")
            total += size
        require(total == descriptor["size"] and whole.hexdigest() == descriptor["sha256"], "reassembled runtime checksum mismatch")
    except Exception:
        if target is not None:
            target.close()
            output.unlink()
            target = None
        raise
    finally:
        if target is not None:
            target.close()
    return descriptor["sha256"]


def split_archive(archive, artifact, commit, version, architecture, directory, descriptor_file):
    require(not descriptor_file.exists(), "runtime chunk descriptor already exists")
    require(regular(archive).stat().st_size == artifact["size"], "runtime archive size changed before chunking")
    directory.mkdir(parents=True, exist_ok=True)
    require(not directory.is_symlink(), "runtime parts directory cannot be a link")
    parts, whole = [], hashlib.sha256()
    with archive.open("rb") as source:
        while data := source.read(CHUNK_BYTES):
            require(len(parts) < MAX_PARTS, "runtime chunk count exceeds 64")
            sha = hashlib.sha256(data).hexdigest()
            name = f"runtime-{architecture}-{len(parts):04d}-{sha}.part"
            file = directory / name
            with file.open("xb") as target:
                target.write(data)
            parts.append({"file": name, "sha256": sha, "size": len(data)})
            whole.update(data)
    require(whole.hexdigest() == artifact["sha256"], "runtime archive changed before chunking")
    value = {"schema": SCHEMA, "source_commit": commit, "version": version, "architecture": architecture,
             "file": artifact["file"], "sha256": artifact["sha256"], "size": artifact["size"], "parts": parts}
    validate_descriptor(value, artifact, commit, version, architecture)
    verify_parts(value, directory)
    with descriptor_file.open("x") as target:
        target.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
    return value


def part_url(candidate_url, descriptor, part):
    validate_descriptor(descriptor, descriptor, descriptor["source_commit"], descriptor["version"], descriptor["architecture"])
    candidate_id = "tag-" + base64.urlsafe_b64encode(f"v{descriptor['version']}".encode()).decode().rstrip("=")
    pattern = (rf"https://raw\.githubusercontent\.com/kody-w/openrappter/[0-9a-f]{{40}}/"
               rf"candidates/{descriptor['source_commit']}/release/{candidate_id}/[0-9a-f]{{64}}\.tar\.gz")
    require(isinstance(candidate_url, str) and re.fullmatch(pattern, candidate_url), "chunk candidate URL is not frozen or source-bound")
    require(part in descriptor["parts"], "unlisted runtime part")
    return candidate_url.rsplit("/", 1)[0] + "/" + part["file"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_parts(descriptor, candidate_url, directory, opener=None):
    validate_descriptor(descriptor, descriptor, descriptor["source_commit"], descriptor["version"], descriptor["architecture"])
    directory.mkdir(parents=True, exist_ok=True)
    require(not directory.is_symlink(), "runtime parts directory cannot be a link")
    opener = opener or urllib.request.build_opener(NoRedirect()).open
    for part in descriptor["parts"]:
        url = part_url(candidate_url, descriptor, part)
        file = directory / part["file"]
        if file.exists():
            regular(file)
            continue
        created = False
        try:
            with opener(urllib.request.Request(url, headers={"Accept-Encoding": "identity"}), timeout=120) as source, file.open("xb") as target:
                created = True
                size, sha = 0, hashlib.sha256()
                while data := source.read(1024 * 1024):
                    size += len(data)
                    require(size <= part["size"], "runtime part download exceeds its pin")
                    sha.update(data)
                    target.write(data)
                require(size == part["size"] and sha.hexdigest() == part["sha256"], "runtime part download checksum/size mismatch")
        except Exception:
            if created:
                file.unlink(missing_ok=True)
            raise
    verify_parts(descriptor, directory)


@contextmanager
def assembled_archive(descriptor, directory):
    work = ROOT / ".test-scratch" / f"runtime-chunks-{uuid.uuid4().hex}"
    work.mkdir(parents=True, mode=0o700)
    try:
        file = work / descriptor["file"]
        verify_parts(descriptor, directory, file)
        yield file
    finally:
        shutil.rmtree(work)
