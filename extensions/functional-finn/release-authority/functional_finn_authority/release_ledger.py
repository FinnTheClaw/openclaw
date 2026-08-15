"""Canonical _finnrel candidate, revision, and signed-frame ledger."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from functools import wraps
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from .canonical_frame import decode_release_frame
from .signing import SignedFrame


class ReleaseState(str, Enum):
    RECEIVED = "RECEIVED"
    VALIDATED = "VALIDATED"
    REVISION_REQUIRED = "REVISION_REQUIRED"
    FRAME_SIGNED = "FRAME_SIGNED"
    DELIVERED = "DELIVERED"
    UNKNOWN = "UNKNOWN"
    ABSTAINED = "ABSTAINED"
    DENIED = "DENIED"


class ReleaseLedgerError(RuntimeError):
    pass


def _serialized(method: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(method)
    def locked(self: "ReleaseLedger", *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            self._require_open()
            return method(self, *args, **kwargs)

    return locked


@dataclass(frozen=True)
class CandidateBinding:
    candidate_id: str
    turn_ticket: str
    revision: int
    ingress_id: str
    candidate_digest: str
    candidate_payload: bytes
    accepted_at: int


@dataclass(frozen=True)
class ReleaseRecord:
    candidate_id: str
    turn_ticket: str
    revision: int
    ingress_id: str
    candidate_digest: str
    candidate_payload: bytes | None
    evidence_set_digest: str | None
    state: ReleaseState
    frame_id: str | None
    frame_digest: str | None
    frame_payload: bytes | None
    frame_signature: str | None
    message_id: str | None


class ReleaseLedger:
    def __init__(self, path: Path, *, max_records: int = 10_000) -> None:
        if max_records < 1:
            raise ValueError("max_records must be positive")
        self._max_records = max_records
        self._lock = threading.RLock()
        self._closed = False
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS release_attempts (
              candidate_id TEXT PRIMARY KEY,
              turn_ticket TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision IN (0, 1)),
              ingress_id TEXT NOT NULL,
              candidate_digest TEXT NOT NULL,
              candidate_payload BLOB,
              evidence_set_digest TEXT,
              state TEXT NOT NULL,
              frame_id TEXT,
              frame_digest TEXT,
              frame_payload BLOB,
              frame_signature TEXT,
              message_id TEXT,
              accepted_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              UNIQUE(turn_ticket, revision)
            )
            """
        )
        columns = {
            row["name"] for row in self._db.execute("PRAGMA table_info(release_attempts)")
        }
        if "candidate_payload" not in columns:
            self._db.execute("ALTER TABLE release_attempts ADD COLUMN candidate_payload BLOB")
        if "evidence_set_digest" not in columns:
            self._db.execute("ALTER TABLE release_attempts ADD COLUMN evidence_set_digest TEXT")
        self._db.execute(
            "UPDATE release_attempts SET state = ? WHERE state = ? AND candidate_payload IS NULL",
            (ReleaseState.DENIED.value, ReleaseState.RECEIVED.value),
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
            raise ReleaseLedgerError("release ledger is closed")

    def _row(self, candidate_id: str) -> sqlite3.Row | None:
        return self._db.execute(
            "SELECT * FROM release_attempts WHERE candidate_id = ?", (candidate_id,)
        ).fetchone()

    @staticmethod
    def _record(row: sqlite3.Row) -> ReleaseRecord:
        return ReleaseRecord(
            candidate_id=row["candidate_id"],
            turn_ticket=row["turn_ticket"],
            revision=row["revision"],
            ingress_id=row["ingress_id"],
            candidate_digest=row["candidate_digest"],
            candidate_payload=row["candidate_payload"],
            evidence_set_digest=row["evidence_set_digest"],
            state=ReleaseState(row["state"]),
            frame_id=row["frame_id"],
            frame_digest=row["frame_digest"],
            frame_payload=row["frame_payload"],
            frame_signature=row["frame_signature"],
            message_id=row["message_id"],
        )

    @_serialized
    def lookup(self, candidate_id: str) -> ReleaseRecord | None:
        row = self._row(candidate_id)
        return None if row is None else self._record(row)

    @_serialized
    def lookup_turn_revision(self, turn_ticket: str, revision: int) -> ReleaseRecord | None:
        row = self._db.execute(
            "SELECT * FROM release_attempts WHERE turn_ticket = ? AND revision = ?",
            (turn_ticket, revision),
        ).fetchone()
        return None if row is None else self._record(row)

    @_serialized
    def accept(self, binding: CandidateBinding) -> ReleaseRecord:
        if binding.revision not in (0, 1):
            raise ReleaseLedgerError("candidate revision must be zero or one")
        if hashlib.sha256(binding.candidate_payload).hexdigest() != binding.candidate_digest:
            raise ReleaseLedgerError("candidate payload digest is invalid")
        self._db.execute("BEGIN IMMEDIATE")
        try:
            existing = self._db.execute(
                """
                SELECT * FROM release_attempts
                WHERE candidate_id = ? OR (turn_ticket = ? AND revision = ?)
                """,
                (binding.candidate_id, binding.turn_ticket, binding.revision),
            ).fetchall()
            if existing:
                if len(existing) != 1:
                    raise ReleaseLedgerError("candidate identity resolves to conflicting rows")
                row = existing[0]
                if (
                    row["candidate_id"] != binding.candidate_id
                    or row["turn_ticket"] != binding.turn_ticket
                    or row["revision"] != binding.revision
                    or row["ingress_id"] != binding.ingress_id
                    or row["candidate_digest"] != binding.candidate_digest
                    or row["candidate_payload"] != binding.candidate_payload
                ):
                    raise ReleaseLedgerError("candidate replay binding conflict")
                self._db.execute("COMMIT")
                return self._record(row)
            count = self._db.execute("SELECT COUNT(*) FROM release_attempts").fetchone()[0]
            if count >= self._max_records:
                raise ReleaseLedgerError("release ledger capacity exhausted")
            self._db.execute(
                """
                INSERT INTO release_attempts (
                  candidate_id, turn_ticket, revision, ingress_id, candidate_digest,
                  candidate_payload, state,
                  accepted_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    binding.candidate_id,
                    binding.turn_ticket,
                    binding.revision,
                    binding.ingress_id,
                    binding.candidate_digest,
                    binding.candidate_payload,
                    ReleaseState.RECEIVED.value,
                    binding.accepted_at,
                    binding.accepted_at,
                ),
            )
            row = self._row(binding.candidate_id)
            self._db.execute("COMMIT")
            if row is None:
                raise ReleaseLedgerError("candidate acceptance did not persist")
            return self._record(row)
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise

    @_serialized
    def require_revision(self, candidate_id: str, *, now: int) -> ReleaseRecord:
        return self._transition(candidate_id, ReleaseState.RECEIVED, ReleaseState.REVISION_REQUIRED, now)

    @_serialized
    def record_abstained(self, candidate_id: str, *, now: int) -> ReleaseRecord:
        return self._transition(candidate_id, ReleaseState.RECEIVED, ReleaseState.ABSTAINED, now)

    @_serialized
    def record_denied(self, candidate_id: str, *, now: int) -> ReleaseRecord:
        return self._transition(candidate_id, ReleaseState.RECEIVED, ReleaseState.DENIED, now)

    @_serialized
    def record_validated(
        self,
        candidate_id: str,
        *,
        evidence_set_digest: str,
        now: int,
    ) -> ReleaseRecord:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            row = self._row(candidate_id)
            if row and row["state"] == ReleaseState.VALIDATED.value:
                if row["evidence_set_digest"] != evidence_set_digest:
                    raise ReleaseLedgerError("validated candidate evidence replay conflict")
                self._db.execute("COMMIT")
                return self._record(row)
            changed = self._db.execute(
                """
                UPDATE release_attempts
                SET state = ?, evidence_set_digest = ?, updated_at = ?
                WHERE candidate_id = ? AND state = ?
                """,
                (
                    ReleaseState.VALIDATED.value,
                    evidence_set_digest,
                    now,
                    candidate_id,
                    ReleaseState.RECEIVED.value,
                ),
            ).rowcount
            if changed != 1:
                raise ReleaseLedgerError("candidate validation CAS lost")
            row = self._row(candidate_id)
            self._db.execute("COMMIT")
            if row is None:
                raise ReleaseLedgerError("validated candidate did not persist")
            return self._record(row)
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise

    @_serialized
    def commit_signed_frame(
        self,
        candidate_id: str,
        signed: SignedFrame,
        *,
        expected_candidate_digest: str,
        expected_message: str,
        now: int,
    ) -> ReleaseRecord:
        frame = decode_release_frame(signed.payload)
        digest = hashlib.sha256(signed.payload).hexdigest()
        self._db.execute("BEGIN IMMEDIATE")
        try:
            row = self._row(candidate_id)
            if row is None:
                raise ReleaseLedgerError("candidate is unavailable")
            if row["state"] == ReleaseState.FRAME_SIGNED.value:
                if (
                    row["frame_id"] == frame.frame_id
                    and row["frame_digest"] == digest
                    and row["frame_payload"] == signed.payload
                    and row["frame_signature"] == signed.signature
                ):
                    self._db.execute("COMMIT")
                    return self._record(row)
                raise ReleaseLedgerError("signed frame replay conflict")
            if (
                row["candidate_digest"] != expected_candidate_digest
                or row["candidate_payload"] is None
            ):
                raise ReleaseLedgerError("candidate release binding conflict")
            try:
                payload = json.loads(bytes(row["candidate_payload"]).decode("utf-8"))
            except (UnicodeDecodeError, ValueError, TypeError) as error:
                raise ReleaseLedgerError("validated candidate payload is unavailable") from error
            if not isinstance(payload, dict) or payload.get("message") != expected_message:
                raise ReleaseLedgerError("candidate release message conflict")
            if row["state"] != ReleaseState.VALIDATED.value:
                raise ReleaseLedgerError("candidate is not eligible for frame signing")
            changed = self._db.execute(
                """
                UPDATE release_attempts
                SET state = ?, frame_id = ?, frame_digest = ?, frame_payload = ?,
                    frame_signature = ?, updated_at = ?
                WHERE candidate_id = ? AND state = ?
                """,
                (
                    ReleaseState.FRAME_SIGNED.value,
                    frame.frame_id,
                    digest,
                    signed.payload,
                    signed.signature,
                    now,
                    candidate_id,
                    ReleaseState.VALIDATED.value,
                ),
            ).rowcount
            if changed != 1:
                raise ReleaseLedgerError("signed-frame CAS lost")
            row = self._row(candidate_id)
            self._db.execute("COMMIT")
            if row is None:
                raise ReleaseLedgerError("signed frame did not persist")
            return self._record(row)
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise

    @_serialized
    def record_sender_outcome(
        self,
        candidate_id: str,
        *,
        delivered: bool,
        message_id: str | None,
        now: int,
    ) -> ReleaseRecord:
        target = ReleaseState.DELIVERED if delivered else ReleaseState.UNKNOWN
        row = self._row(candidate_id)
        if row and row["state"] == target.value:
            if row["message_id"] != message_id:
                raise ReleaseLedgerError("sender outcome replay conflict")
            return self._record(row)
        if delivered and not message_id:
            raise ReleaseLedgerError("delivered outcome requires a message identity")
        self._db.execute("BEGIN IMMEDIATE")
        try:
            changed = self._db.execute(
                """
                UPDATE release_attempts SET state = ?, message_id = ?, updated_at = ?
                WHERE candidate_id = ? AND state = ?
                """,
                (target.value, message_id, now, candidate_id, ReleaseState.FRAME_SIGNED.value),
            ).rowcount
            if changed != 1:
                raise ReleaseLedgerError("sender outcome CAS lost")
            row = self._row(candidate_id)
            self._db.execute("COMMIT")
            if row is None:
                raise ReleaseLedgerError("sender outcome did not persist")
            return self._record(row)
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise

    def _transition(
        self,
        candidate_id: str,
        source: ReleaseState,
        target: ReleaseState,
        now: int,
    ) -> ReleaseRecord:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            row = self._row(candidate_id)
            if row and row["state"] == target.value:
                self._db.execute("COMMIT")
                return self._record(row)
            changed = self._db.execute(
                "UPDATE release_attempts SET state = ?, updated_at = ? WHERE candidate_id = ? AND state = ?",
                (target.value, now, candidate_id, source.value),
            ).rowcount
            if changed != 1:
                raise ReleaseLedgerError("release state transition CAS lost")
            row = self._row(candidate_id)
            self._db.execute("COMMIT")
            if row is None:
                raise ReleaseLedgerError("release state transition did not persist")
            return self._record(row)
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise
