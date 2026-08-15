from __future__ import annotations

import os
import socket
import struct
import tempfile
import threading
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from functional_finn_authority.finnrel_service import FinnrelApplication
from functional_finn_authority.finnsig_service import FinnsigApplication
from functional_finn_authority.ingress_ledger import BoundDelivery, IngressLedger
from functional_finn_authority.ipc_client import AttestedProtocolClient, FinnsigIngressClient
from functional_finn_authority.peer_credentials import PeerCredentialError
from functional_finn_authority.protocol import IngressPull, SendResultMessage, request_document
from functional_finn_authority.raw_framing import MAX_PACKET_BYTES, FrameTooLarge, encode_packet, read_packet
from functional_finn_authority.release_ledger import ReleaseLedger
from functional_finn_authority.sender_ledger import SendResult, SenderLedger
from functional_finn_authority.signing import FrameSigner

from .test_ingress_ledger import observation


class NoSend:
    def send_text(self, _target: BoundDelivery, _message: str) -> SendResult:
        raise AssertionError("socket protocol test must not send")


class NoFrameSubmit:
    def send(self, _request_id: str, _signed: object) -> SendResultMessage:
        raise AssertionError("peer rejection must occur before frame submission")


@unittest.skipIf(os.name == "nt", "Unix peer credential service seam")
class ServiceSocketTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.ingress_path = self.root / "ingress.sqlite"
        self.sender_path = self.root / "sender.sqlite"
        self.ingress = IngressLedger(self.ingress_path)
        self.sender = SenderLedger(self.sender_path)
        self.release = ReleaseLedger(self.root / "release.sqlite")
        self.ingress.ingest(observation())
        signer = FrameSigner(Ed25519PrivateKey.generate())
        self.release_public_key = signer.public_key()
        self.app = FinnsigApplication(
            ingress=self.ingress,
            sender_ledger=self.sender,
            physical_sender=NoSend(),
            release_public_key=self.release_public_key,
            release_key_id="release-key-2026-08",
            now=lambda: 1_723_700_100,
        )
        self.finnrel = FinnrelApplication(
            ledger=self.release,
            signer=signer,
            key_id="release-key-2026-08",
            ingress_client=self.ingress,  # lookup is the required narrow protocol
            sender_client=NoFrameSubmit(),
            now=lambda: 1_723_700_100,
        )

    def tearDown(self) -> None:
        self.ingress.close()
        self.sender.close()
        self.release.close()
        self.temporary.cleanup()

    def serve_thread_owned(
        self,
        server: socket.socket,
        *,
        release_peer: bool,
        errors: list[BaseException],
    ) -> None:
        ingress = IngressLedger(self.ingress_path)
        sender = SenderLedger(self.sender_path)
        app = FinnsigApplication(
            ingress=ingress,
            sender_ledger=sender,
            physical_sender=NoSend(),
            release_public_key=self.release_public_key,
            release_key_id="release-key-2026-08",
            now=lambda: 1_723_700_100,
        )
        try:
            if release_peer:
                app.serve_release_once(server, expected_uid=os.getuid())
            else:
                app.serve_openclaw_once(server, expected_uid=os.getuid())
        except BaseException as error:
            errors.append(error)
        finally:
            ingress.close()
            sender.close()

    def test_wrong_peer_is_denied_before_any_frame_read(self) -> None:
        server, client = socket.socketpair()
        try:
            with self.assertRaises(PeerCredentialError):
                self.app.serve_openclaw_once(server, expected_uid=os.getuid() + 1)
        finally:
            server.close()
            client.close()

    def test_finnrel_also_attests_openclaw_before_frame_read(self) -> None:
        server, client = socket.socketpair()
        try:
            with self.assertRaises(PeerCredentialError):
                self.finnrel.serve_openclaw_once(server, expected_uid=os.getuid() + 1)
        finally:
            server.close()
            client.close()

    def test_oversize_length_is_rejected_before_body_allocation(self) -> None:
        server, client = socket.socketpair()
        errors: list[BaseException] = []

        def run() -> None:
            self.serve_thread_owned(server, release_peer=False, errors=errors)

        worker = threading.Thread(target=run)
        worker.start()
        client.sendall(struct.pack(">I", MAX_PACKET_BYTES + 1))
        worker.join(timeout=2)
        server.close()
        client.close()
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], FrameTooLarge)

    def test_valid_peer_receives_canonical_normalized_ingress(self) -> None:
        server, client = socket.socketpair()
        errors: list[BaseException] = []

        def run() -> None:
            self.serve_thread_owned(server, release_peer=False, errors=errors)

        worker = threading.Thread(target=run)
        worker.start()
        client.sendall(encode_packet(request_document(IngressPull("pull-1", 0, 10))))
        with client.makefile("rb", buffering=0) as reader:
            response = read_packet(reader)
        worker.join(timeout=2)
        server.close()
        client.close()
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(response["records"][0]["ingressId"], "ingress-001")
        self.assertNotIn("destination", str(response).lower())

    def test_finnrel_client_attests_finnsig_before_evidence_lookup(self) -> None:
        threads: list[threading.Thread] = []
        errors: list[BaseException] = []

        def connect() -> socket.socket:
            server, client = socket.socketpair()

            def run() -> None:
                try:
                    self.serve_thread_owned(server, release_peer=True, errors=errors)
                finally:
                    server.close()

            worker = threading.Thread(target=run)
            worker.start()
            threads.append(worker)
            return client

        client = FinnsigIngressClient(
            AttestedProtocolClient(connect, expected_peer_uid=os.getuid())
        )
        try:
            record = client.lookup("ingress-001")
        except BaseException as client_error:
            for worker in threads:
                worker.join(timeout=2)
            if errors:
                raise AssertionError("finnsig server thread failed before response") from errors[0]
            raise client_error
        for worker in threads:
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(record.ingress_id, "ingress-001")  # type: ignore[union-attr]

    def test_client_rejects_wrong_server_peer_before_writing_request(self) -> None:
        server, client_socket = socket.socketpair()
        client = AttestedProtocolClient(
            lambda: client_socket,
            expected_peer_uid=os.getuid() + 1,
        )
        with self.assertRaises(PeerCredentialError):
            FinnsigIngressClient(client).lookup("ingress-001")
        server.settimeout(1)
        self.assertEqual(server.recv(1), b"")
        server.close()


if __name__ == "__main__":
    unittest.main()
