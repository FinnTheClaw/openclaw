from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from functional_finn_authority.hhem_process_client import HhemProcessClient
from functional_finn_authority.semantic_support import SemanticSupportError


@unittest.skipIf(sys.platform == "win32", "requires POSIX worker paths")
class SemanticSupportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.model = self.root / "model"
        self.foundation = self.root / "foundation"
        self.model.mkdir()
        self.foundation.mkdir()
        self.worker = self.root / "worker.py"
        shutil.copyfile(Path(__file__).parent / "fixtures" / "fake_hhem_worker.py", self.worker)
        self.clients: list[HhemProcessClient] = []

    def tearDown(self) -> None:
        for client in self.clients:
            client.close()
        self.temporary.cleanup()

    def client(self, *, timeout: float = 1.0) -> HhemProcessClient:
        value = HhemProcessClient(
            python_path=Path(sys.executable), worker_path=self.worker,
            model_bundle=self.model, foundation_bundle=self.foundation,
            timeout_seconds=timeout,
        )
        self.clients.append(value)
        return value

    def test_isolated_worker_supports_and_rejects(self) -> None:
        client = self.client()
        self.assertTrue(client.supports("observed support", "supported claim"))
        (self.model / "mode").write_text("unsupported", encoding="utf-8")
        self.assertFalse(client.supports("observed support", "unsupported claim"))

    def test_timeout_failure_and_malformed_output_poison_worker(self) -> None:
        for mode in ("timeout", "crash", "malformed"):
            with self.subTest(mode=mode):
                (self.model / "mode").write_text(mode, encoding="utf-8")
                client = self.client(timeout=0.05)
                with self.assertRaises(SemanticSupportError):
                    client.supports("support", "claim")
                with self.assertRaisesRegex(SemanticSupportError, "unavailable"):
                    client.supports("support", "claim")
                client.close()

    def test_close_is_idempotent_and_fails_closed(self) -> None:
        client = self.client()
        self.assertTrue(client.supports("support", "claim"))
        client.close()
        client.close()
        with self.assertRaisesRegex(SemanticSupportError, "unavailable"):
            client.supports("support", "claim")


if __name__ == "__main__":
    unittest.main()
