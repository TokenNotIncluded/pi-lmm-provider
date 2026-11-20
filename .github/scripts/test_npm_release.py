#!/usr/bin/env python3
"""Exercise the immutable npm release artifact verifier with isolated git fixtures."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("npm_release", Path(__file__).with_name("npm-release.py"))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
VERSION = "0.1.0-alpha.6"


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pi-release-verifier-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.directory = self.root / "release"
        self.source.mkdir()
        self.directory.mkdir()

    def fixture(self, *, legacy=False, tamper=False):
        runtime = "src/models-dev.json" if legacy else "src/models-dev-cache.ts"
        files = {
            "package.json": json.dumps({
                "name": release.PACKAGE, "version": VERSION,
                "repository": {"url": release.REPOSITORY_URL},
            }).encode(),
            "src/index.ts": b"export default function extension() {}\n",
            runtime: b"{}\n" if legacy else b"export const publicCatalog = {};\n",
            "src/models-dev.LICENSE": b"MIT models.dev attribution\n",
            "LICENSE": b"MIT\n",
        }
        for name, data in files.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        for args in [
            ["init", "-q"],
            ["add", "--", *files],
            ["-c", "user.name=Release Verifier", "-c", "user.email=release-verifier@example.invalid", "commit", "-qm", "fixture"],
            ["tag", f"v{VERSION}"],
        ]:
            subprocess.run(["git", "-C", str(self.source), *args], check=True, capture_output=True)
        archive = self.directory / f"tokennotincluded-pi-lmm-provider-{VERSION}.tgz"
        with tarfile.open(archive, "w:gz") as bundle:
            for name, original in files.items():
                data = b"export const unexpectedCode = true;\n" if tamper and name == runtime else original
                member = tarfile.TarInfo(f"package/{name}")
                member.mode = 0o644
                member.size = len(data)
                bundle.addfile(member, io.BytesIO(data))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.directory / "release.json").write_text(json.dumps({
            "tagName": f"v{VERSION}", "isDraft": False, "isPrerelease": True,
            "assets": [{"name": archive.name, "state": "uploaded", "id": 1,
                        "digest": f"sha256:{digest}", "size": archive.stat().st_size}],
        }))
        (self.directory / "pi-SHA256SUMS").write_text(f"{digest}  {archive.name}\n")
        (self.directory / "pack-list.json").write_text(json.dumps([{
            "name": release.PACKAGE, "version": VERSION,
            "files": [{"path": name} for name in files],
        }]))
        return {"RELEASE_VERSION": VERSION, "EXPECTED_SHA256": digest, "DIST_TAG": "alpha"}

    def verify(self, environment):
        with patch.dict(os.environ, environment), contextlib.redirect_stdout(io.StringIO()):
            release.artifact(self.source, self.directory)

    def test_cached_runtime_module_is_required_and_accepted(self):
        self.verify(self.fixture())

    def test_obsolete_static_snapshot_cannot_replace_runtime_module(self):
        with self.assertRaisesRegex(ValueError, "required runtime/metadata/license"):
            self.verify(self.fixture(legacy=True))

    def test_accepted_hash_does_not_override_tagged_source_bytes(self):
        with self.assertRaisesRegex(ValueError, "Packaged bytes differ from tagged source"):
            self.verify(self.fixture(tamper=True))


if __name__ == "__main__":
    unittest.main()
