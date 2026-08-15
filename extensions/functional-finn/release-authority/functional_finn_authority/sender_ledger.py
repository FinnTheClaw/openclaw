"""_finnsig sender ledger and injectable at-most-once attempt coordinator."""

from __future__ import annotations

import hashlib
import sqlite3
import threading
from functools import wraps
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Protocol

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .canonical_frame import ReleaseFrame, decode_release_frame
from .signing import SignedFrame, verify_signed_frame


class SenderState(str, Enum):
    RECEIVED = "RECEIVED"
    ATTEMPT_STARTED = "ATTEMPT_STARTED"
    DELIVERED = "DELIVERED"
    UNKNOWN = "UNKNOWN"


class SenderLedgerError(RuntimeError):
    pass


def _serialized(method: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(method)
    def locked(self: "SenderLedger", *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            self._require_open()
            return method(self, *args, **kwargs)

    return locked


@dataclass(frozen=True)
class SenderRecord:
    frame_id: str
    frame_digest: str
    state: SenderState
    payload: bytes
    signature: str
    message_id: str | None


@dataclass(frozen=True)
class SendResult:
    message_id: str


class PhysicalSender(Protocol):
    def send(self, frame: ReleaseFrame) -> SendResult: ...


class SenderLedger:
    def __init__(self, path: Path, *, max_records: int = 10_000) -> None:
        self._max_records = max_records
        self._lock = threading.RLock()
        self._closed = False
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS sender_deliveries (
              frame_id TEXT PRIMARY KEY,
              frame_digest TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('RECEIVED','ATTEMPT_STARTED','DELIVERED','UNKNOWN')),
              payload BLOB NOT NULL,
              signature TEXT NOT NULL,
              message_id TEXT,
              received_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            try:
                self._db.close()
            finally:
                self._closed = True

    def _require_open(self) -> None:
        if self._closed:
            raise SenderLedgerError("sender ledger is closed")

    @staticmethod
    def _record(row: sqlite3.Row) -> SenderRecord:
        return SenderRecord(
            frame_id=row["frame_id"],
            frame_digest=row["frame_digest"],
            state=SenderState(row["state"]),
            payload=row["payload"],
            signature=row["signature"],
            message_id=row["message_id"],
        )

    @_serialized
    def lookup(self, frame_id: str) -> SenderRecord | None:
        row = self._db.execute(
            "SELECT * FROM sender_deliveries WHERE frame_id = ?", (frame_id,)
        ).fetchone()
        return None if row is None else self._record(row)

    @_serialized
    def receive(
        self,
        signed: SignedFrame,
        *,
        public_key: Ed25519PublicKey,
        now: int,
    ) -> SenderRecord:
        if not verify_signed_frame(signed, public_key):
            raise SenderLedgerError("signed release frame is invalid")
        frame = decode_release_frame(signed.payload)
        digest = hashlib.sha256(signed.payload).hexdigest()
        self._db.execute("BEGIN IMMEDIATE")
        try:
            row = self._db.execute(
                "SELECT * FROM sender_deliveries WHERE frame_id = ?", (frame.frame_id,)
            ).fetchone()
            if row:
                if (
                    row["frame_digest"] != digest
                    or row["payload"] != signed.payload
                    or row["signature"] != signed.signature
                ):
                    raise SenderLedgerError("frame identity replay conflict")
                self._db.execute("COMMIT")
                return self._record(row)
            count = self._db.execute("SELECT COUNT(*) FROM sender_deliveries").fetchone()[0]
            if count >= self._max_records:
                raise SenderLedgerError("sender ledger capacity exhausted")
            self._db.execute(
                """
                INSERT INTO sender_deliveries (
                  frame_id, frame_digest, state, payload, signature, received_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    frame.frame_id,
                    digest,
                    SenderState.RECEIVED.value,
                    signed.payload,
                    signed.signature,
                    now,
                    now,
                ),
            )
            row = self._db.execute(
                "SELECT * FROM sender_deliveries WHERE frame_id = ?", (frame.frame_id,)
            ).fetchone()
            self._db.execute("COMMIT")
            if row is None:
                raise SenderLedgerError("sender receipt did not persist")
            return self._record(row)
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise

    @_serialized
    def begin_attempt(self, frame_id: str, *, now: int) -> SenderRecord | None:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            changed = self._db.execute(
                """
                UPDATE sender_deliveries SET state = ?, updated_at = ?
                WHERE frame_id = ? AND state = ?
                """,
                (
                    SenderState.ATTEMPT_STARTED.value,
                    now,
                    frame_id,
                    SenderState.RECEIVED.value,
                ),
            ).rowcount
            row = self._db.execute(
                "SELECT * FROM sender_deliveries WHERE frame_id = ?", (frame_id,)
            ).fetchone()
            self._db.execute("COMMIT")
            if changed == 0:
                return None
            if changed != 1 or row is None:
                raise SenderLedgerError("sender attempt CAS did not persist")
            return self._record(row)
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise

    @_serialized
    def mark_delivered(self, frame_id: str, *, message_id: str, now: int) -> SenderRecord:
        if not message_id:
            raise SenderLedgerError("delivered sender result requires a message identity")
        return self._settle(frame_id, SenderState.DELIVERED, message_id, now)

    @_serialized
    def mark_unknown(self, frame_id: str, *, now: int) -> SenderRecord:
        return self._settle(frame_id, SenderState.UNKNOWN, None, now)

    @_serialized
    def recover_after_restart(self, *, now: int) -> int:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            changed = self._db.execute(
                """
                UPDATE sender_deliveries SET state = ?, updated_at = ?
                WHERE state = ?
                """,
                (SenderState.UNKNOWN.value, now, SenderState.ATTEMPT_STARTED.value),
            ).rowcount
            self._db.execute("COMMIT")
            return changed
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise

    def _settle(
        self,
        frame_id: str,
        state: SenderState,
        message_id: str | None,
        now: int,
    ) -> SenderRecord:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            row = self._db.execute(
                "SELECT * FROM sender_deliveries WHERE frame_id = ?", (frame_id,)
            ).fetchone()
            if row and row["state"] == state.value:
                if row["message_id"] != message_id:
                    raise SenderLedgerError("sender settlement replay conflict")
                self._db.execute("COMMIT")
                return self._record(row)
            changed = self._db.execute(
                """
                UPDATE sender_deliveries SET state = ?, message_id = ?, updated_at = ?
                WHERE frame_id = ? AND state = ?
                """,
                (state.value, message_id, now, frame_id, SenderState.ATTEMPT_STARTED.value),
            ).rowcount
            if changed != 1:
                raise SenderLedgerError("sender settlement CAS lost")
            row = self._db.execute(
                "SELECT * FROM sender_deliveries WHERE frame_id = ?", (frame_id,)
            ).fetchone()
            self._db.execute("COMMIT")
            if row is None:
                raise SenderLedgerError("sender settlement did not persist")
            return self._record(row)
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise


class SenderCoordinator:
    def __init__(self, ledger: SenderLedger, sender: PhysicalSender) -> None:
        self._ledger = ledger
        self._sender = sender

    def attempt_once(self, frame_id: str, *, now: int) -> SenderRecord:
        claimed = self._ledger.begin_attempt(frame_id, now=now)
        if claimed is None:
            existing = self._ledger.lookup(frame_id)
            if existing is None:
                raise SenderLedgerError("sender frame is unavailable")
            return existing
        try:
            result = self._sender.send(decode_release_frame(claimed.payload))
            return self._ledger.mark_delivered(frame_id, message_id=result.message_id, now=now)
        except Exception:
            self._ledger.mark_unknown(frame_id, now=now)
            raise
