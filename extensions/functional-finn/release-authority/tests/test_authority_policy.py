from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from functional_finn_authority.authority_policy import (
    AuthorityPolicyError,
    assert_finnrel_files,
    assert_finnsig_files,
    load_authority_policy,
)


@unittest.skipIf(os.name == "nt", "POSIX ownership and modes are validated on Moira")
class AuthorityPolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.uid = os.getuid()
        for name in ("rel", "sig", "signal-store", "hhem", "flan"):
            path = self.root / name
            path.mkdir(mode=0o700 if name in ("rel", "sig", "signal-store") else 0o755)
        for bundle in ("hhem", "flan"):
            (self.root / bundle / "config.json").write_text("{}", encoding="utf-8")
            (self.root / bundle / "config.json").chmod(0o444)
        for name, mode in (("key.pem", 0o400), ("public.pem", 0o444), ("python", 0o555), ("worker.py", 0o444), ("signal-cli", 0o555)):
            (self.root / name).write_text(name, encoding="utf-8")
            (self.root / name).chmod(mode)
        self.policy_path = self.root / "policy.json"
        self.policy_path.write_text(json.dumps(self.document()), encoding="utf-8")
        self.policy_path.chmod(0o444)

    def tearDown(self) -> None:
        for path in self.root.rglob("*"):
            if path.is_file():
                path.chmod(0o600)
        self.temporary.cleanup()

    def document(self) -> dict[str, object]:
        socket = lambda name, gid: {"path": f"/tmp/{name}.sock", "groupGid": gid}
        return {
            "schema": "functional-finn.authority-policy.v2",
            "finnrel": {
                "uid": self.uid, "openclawUid": self.uid, "keyPath": str(self.root / "key.pem"),
                "keyId": "key-1", "ledgerPath": str(self.root / "rel" / "release.sqlite"),
                "candidateSocket": socket("candidate", 570), "finnsigSocket": socket("release", 571),
                "finnsigUid": self.uid, "hhemPython": str(self.root / "python"),
                "hhemWorker": str(self.root / "worker.py"), "hhemBundle": str(self.root / "hhem"),
                "flanBundle": str(self.root / "flan"), "hhemTimeoutMs": 500,
            },
            "finnsig": {
                "uid": self.uid, "openclawUid": self.uid, "finnrelUid": self.uid,
                "releasePublicKeyPath": str(self.root / "public.pem"), "releaseKeyId": "key-1",
                "senderLedgerPath": str(self.root / "sig" / "sender.sqlite"),
                "ingressLedgerPath": str(self.root / "sig" / "ingress.sqlite"),
                "releaseSocket": socket("release", 571), "ingressSocket": socket("ingress", 572),
                "signalCliPath": str(self.root / "signal-cli"), "signalStorePath": str(self.root / "signal-store"),
                "signalAccount": "+15550001111", "accountId": "finn-signal",
            },
        }

    def test_exact_policy_and_files_are_accepted(self) -> None:
        policy = load_authority_policy(self.policy_path, root_uid=self.uid)
        assert_finnrel_files(policy.finnrel, root_uid=self.uid)
        assert_finnsig_files(policy.finnsig, root_uid=self.uid)

    def test_unknown_field_and_symlink_fail_closed(self) -> None:
        document = self.document()
        document["unexpected"] = True
        self.policy_path.chmod(0o600)
        self.policy_path.write_text(json.dumps(document), encoding="utf-8")
        self.policy_path.chmod(0o444)
        with self.assertRaises(AuthorityPolicyError):
            load_authority_policy(self.policy_path, root_uid=self.uid)
        self.policy_path.unlink()
        self.policy_path.symlink_to(self.root / "key.pem")
        with self.assertRaises(AuthorityPolicyError):
            load_authority_policy(self.policy_path, root_uid=self.uid)


if __name__ == "__main__":
    unittest.main()
