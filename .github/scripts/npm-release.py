#!/usr/bin/env python3
"""Verify an accepted release artifact; publishing itself remains npm's job."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

PACKAGE = "@tokennotincluded/pi-lmm-provider"
REPOSITORY = "TokenNotIncluded/pi-lmm-provider"
REPOSITORY_URL = f"git+https://github.com/{REPOSITORY}.git"
REGISTRY = f"https://registry.npmjs.org/{quote(PACKAGE, safe='')}"
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_CONTENT = 64 * 1024 * 1024


def inputs():
    version = os.environ.get("RELEASE_VERSION", "")
    sha = os.environ.get("EXPECTED_SHA256", "")
    tag = os.environ.get("DIST_TAG", "")
    match = re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?", version)
    if not match or len(version) > 128:
        raise ValueError("Invalid release version; use major.minor.patch[-prerelease].")
    if match[4] and any(part.isdecimal() and len(part) > 1 and part.startswith("0") for part in match[4].split(".")):
        raise ValueError("Numeric prerelease identifiers cannot have leading zeroes.")
    if not re.fullmatch(r"[a-f0-9]{64}", sha):
        raise ValueError("Expected SHA-256 must be 64 lowercase hexadecimal characters.")
    if tag not in {"alpha", "beta", "next", "latest"} or (match[4] and tag == "latest"):
        raise ValueError("Invalid distribution tag; prereleases cannot use latest.")
    return version, sha, tag, f"tokennotincluded-pi-lmm-provider-{version}.tgz"


def archive_bytes(path, expected_sha):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_ARCHIVE:
        raise ValueError("Missing or oversized regular release archive.")
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != expected_sha:
        raise ValueError("Release archive differs from the independently accepted SHA-256.")
    return content


def package_identity(package, version):
    if package.get("name") != PACKAGE or package.get("version") != version:
        raise ValueError("Package name or version does not match this release.")
    if package.get("repository", {}).get("url") != REPOSITORY_URL:
        raise ValueError("Package repository URL does not match the trusted publisher.")


def artifact(source, directory):
    version, expected_sha, _, filename = inputs()
    source = source.resolve()
    archive = directory / filename
    archive_bytes(archive, expected_sha)
    release = json.loads((directory / "release.json").read_text())
    if release.get("tagName") != f"v{version}" or release.get("isDraft") is not False:
        raise ValueError("Expected an existing published release with the exact version tag.")
    if release.get("isPrerelease") != ("-" in version):
        raise ValueError("GitHub release prerelease status disagrees with the version.")
    assets = [asset for asset in release["assets"] if asset["name"] == filename]
    if len(assets) != 1 or assets[0].get("state") != "uploaded" or not assets[0].get("id"):
        raise ValueError("Expected one uploaded release archive with an asset identity.")
    asset = assets[0]
    if asset.get("digest") != f"sha256:{expected_sha}" or asset.get("size") != archive.stat().st_size:
        raise ValueError("GitHub asset digest or size disagrees with the accepted archive.")
    sums = (directory / "pi-SHA256SUMS").read_text().strip()
    if sums != f"{expected_sha}  {filename}":
        raise ValueError("Release checksum file does not contain exactly the accepted archive.")
    head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    tag_head = subprocess.check_output(["git", "-C", str(source), "rev-parse", f"refs/tags/v{version}^{{commit}}"], text=True).strip()
    if head != tag_head:
        raise ValueError("Source checkout is not the exact release tag.")
    package_identity(json.loads(subprocess.check_output(["git", "-C", str(source), "show", "HEAD:package.json"])), version)
    tree = subprocess.check_output(["git", "-C", str(source), "ls-tree", "-rlz", "HEAD"]).decode()
    source_files = {}
    for entry in tree.split("\0"):
        if not entry:
            continue
        metadata, path = entry.split("\t", 1)
        mode, kind, object_id, source_size = metadata.split()
        if mode in {"100644", "100755"} and kind == "blob":
            source_files[path] = (object_id, int(source_size))
    packed = json.loads((directory / "pack-list.json").read_text())
    # npm 12 keys pack JSON by package name; npm 11 used a one-element array.
    if isinstance(packed, dict) and set(packed) == {PACKAGE}:
        package_row = packed[PACKAGE]
    elif isinstance(packed, list) and len(packed) == 1:
        package_row = packed[0]
    else:
        raise ValueError("Tagged npm file listing must contain only the expected package.")
    if not isinstance(package_row, dict) or package_row.get("name") != PACKAGE or package_row.get("version") != version:
        raise ValueError("Tagged npm file listing has a different package identity.")
    expected = {item["path"] for item in package_row["files"]}
    required = {"package.json", "src/index.ts", "src/models-dev.json", "src/models-dev.LICENSE", "LICENSE"}
    if not required <= expected or len(expected) > 2048:
        raise ValueError("Tagged package listing lacks required runtime/metadata/license files.")
    seen = set()
    files = set()
    size = 0
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            relative = PurePosixPath(member.name)
            if not member.name.startswith("package/") or ".." in relative.parts or relative.is_absolute() or member.name in seen:
                raise ValueError("Archive has an unsafe or duplicate member path.")
            seen.add(member.name)
            if len(seen) > 2048 or member.name != relative.as_posix():
                raise ValueError("Archive member paths must be canonical and bounded.")
            if member.isdir():
                continue
            if not member.isfile() or member.size < 0 or member.size > MAX_ARCHIVE:
                raise ValueError("Archive may contain only bounded regular files and directories.")
            size += member.size
            path = relative.relative_to("package").as_posix()
            if size > MAX_CONTENT or path not in expected:
                raise ValueError("Archive contains an oversized or unexpected package file.")
            original = source_files.get(path)
            if original is None:
                raise ValueError("Packaged path does not identify a regular file in the released source.")
            if member.size != original[1] or bundle.extractfile(member).read() != subprocess.check_output(
                    ["git", "-C", str(source), "cat-file", "blob", original[0]]):
                raise ValueError(f"Packaged bytes differ from tagged source: {path}")
            files.add(path)
    if files != expected:
        raise ValueError("Archive is missing a file from the tagged npm package listing.")
    print(f"Verified {filename}: sha256={expected_sha}, source={head}, files={len(files)}, asset={asset['id']}")


def registry_json(url):
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "pi-lmm-release-verifier"})
    try:
        with urlopen(request, timeout=20) as response:
            content = response.read(8 * 1024 * 1024 + 1)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise
    if len(content) > 8 * 1024 * 1024:
        raise ValueError("Registry metadata exceeds the bounded response limit.")
    return json.loads(content)


def registry_snapshot(version):
    document = registry_json(REGISTRY)
    tags = {} if document is None else document.get("dist-tags")
    if not isinstance(tags, dict) or (document is not None and document.get("name") != PACKAGE):
        raise ValueError("Invalid registry package metadata.")
    published = registry_json(f"{REGISTRY}/{quote(version, safe='')}")
    if published is not None:
        package_identity(published, version)
    return published, tags


def registry(phase, archive, state):
    version, expected_sha, tag, _ = inputs()
    content = archive_bytes(archive, expected_sha)
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(content).digest()).decode()
    attempts = 6 if phase == "after" else 1
    before = json.loads(state.read_text()) if phase == "after" else None
    for attempt in range(attempts):
        published, tags = registry_snapshot(version)
        if published is not None and published.get("dist", {}).get("integrity") != integrity:
            raise ValueError("This registry version exists with different archive bytes; refusing to publish or retry.")
        if phase == "before":
            if published is not None and tags.get(tag) != version:
                raise ValueError("Matching version already exists, but the requested dist-tag differs; no tag is moved automatically.")
            if published is None and tags.get(tag) == version:
                raise ValueError("Registry tag exists but its version read returned 404; inspect state before retrying.")
            state.write_text(json.dumps({"latest": tags.get("latest"), "integrity": integrity, "version": version, "tag": tag}) + "\n")
            print(f"publish_required={'true' if published is None else 'false'}")
            return
        if before.get("integrity") != integrity or before.get("version") != version or before.get("tag") != tag:
            raise ValueError("Registry read-back state does not match the accepted publish inputs.")
        if tag != "latest" and tags.get("latest") != before.get("latest"):
            raise ValueError("Observed latest moved during publication; inspect registry state without an automatic rollback.")
        attestations = {} if published is None else published.get("dist", {}).get("attestations", {})
        if published is not None and tags.get(tag) == version and attestations.get("url"):
            print(json.dumps({"package": PACKAGE, "version": version, "integrity": integrity,
                              "dist_tags": tags, "attestations": attestations}, indent=2))
            return
        if attempt + 1 < attempts:
            time.sleep(2)
    raise ValueError("Registry read-back did not confirm the expected version, tag and provenance; inspect before retrying.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("inputs")
    verify = commands.add_parser("artifact")
    verify.add_argument("--source", required=True, type=Path)
    verify.add_argument("--directory", required=True, type=Path)
    remote = commands.add_parser("registry")
    remote.add_argument("--phase", required=True, choices=["before", "after"])
    remote.add_argument("--archive", required=True, type=Path)
    remote.add_argument("--state", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "inputs":
        version, _, _, filename = inputs()
        print(f"archive={filename}\nrelease_tag=v{version}")
    elif args.command == "artifact":
        artifact(args.source, args.directory)
    else:
        registry(args.phase, args.archive, args.state)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print(f"Release verification failed: {error}", file=sys.stderr)
        sys.exit(1)
