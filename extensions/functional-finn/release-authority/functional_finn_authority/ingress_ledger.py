"""Durable _finnsig authority for normalized ingress and reply destinations."""

from __future__ import annotations

import hashlib
import re
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path

from .canonical_frame import ReleaseFrame
from .protocol import IngressView
from .raw_framing import canonical_json_bytes

OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MAX_CONTENT_BYTES = 64 * 1024
MAX_DESTINATION_CHARS = 512


class IngressLedgerError(RuntimeError):
    pass


def _serialized(method):
    def wrapped(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return wrapped


@dataclass(frozen=True)
class IngressObservation:
    ingress_id: str
    account_id: str
    source_id: str
    source_kind: str
    conversation_id: str
    conversation_kind: str
    reply_destination: str
    sequence: int
    received_at: int
    content: str


@dataclass(frozen=True)
class BoundDelivery:
    ingress_id: str
    binding_id: str
    account_id: str
    destination_kind: str
    reply_destination: str
    turn_sequence: int


def _identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not OPAQUE_ID.fullmatch(value):
        raise IngressLedgerError(f"{label} is invalid")
    return value


def _binding_id(observation: IngressObservation) -> str:
    binding = canonical_json_bytes(
        {
            "accountId": observation.account_id,
            "conversationId": observation.conversation_id,
            "conversationKind": observation.conversation_kind,
            "replyDestination": observation.reply_destination,
            "sourceId": observation.source_id,
            "sourceKind": observation.source_kind,
        }
    )
    return "binding:" + hashlib.sha256(binding).hexdigest()


class IngressLedger:
    def __init__(self, path: Path, *, max_records: int = 100_000) -> None:
        if max_records < 1:
            raise ValueError("max_records must be positive")
        self._max_records = max_records
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS signal_ingress (
              ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
              ingress_id TEXT NOT NULL UNIQUE,
              binding_id TEXT NOT NULL,
              account_id TEXT NOT NULL,
              source_id TEXT NOT NULL,
              source_kind TEXT NOT NULL CHECK (source_kind IN ('phone','uuid')),
              conversation_id TEXT NOT NULL,
              conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('direct','group')),
              reply_destination TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              received_at INTEGER NOT NULL,
              content_digest TEXT NOT NULL,
              content TEXT NOT NULL,
              UNIQUE(account_id, source_id, conversation_id, sequence)
            )
            """
        )
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS signal_ingress_pull ON signal_ingress(ordinal, received_at)"
        )
        expected = {
            "ordinal", "ingress_id", "binding_id", "account_id", "source_id", "source_kind",
            "conversation_id", "conversation_kind", "reply_destination", "sequence", "received_at",
            "content_digest", "content",
        }
        actual = {row[1] for row in self._db.execute("PRAGMA table_info(signal_ingress)")}
        if actual != expected:
            self._db.close()
            raise IngressLedgerError("ingress schema is not the exact supported version")

    @_serialized
    def close(self) -> None:
        self._db.close()

    @staticmethod
    def _view(row: sqlite3.Row) -> IngressView:
        return IngressView(
            ingress_id=row["ingress_id"],
            binding_id=row["binding_id"],
            account_id=row["account_id"],
            source_id=row["source_id"],
            source_kind=row["source_kind"],
            conversation_id=row["conversation_id"],
            conversation_kind=row["conversation_kind"],
            ordinal=row["ordinal"],
            sequence=row["sequence"],
            received_at=row["received_at"],
            content_digest=row["content_digest"],
            content=row["content"],
        )

    @_serialized
    def ingest(self, observation: IngressObservation) -> IngressView:
        for value, label in (
            (observation.ingress_id, "ingress_id"),
            (observation.account_id, "account_id"),
            (observation.source_id, "source_id"),
            (observation.conversation_id, "conversation_id"),
        ):
            _identifier(value, label)
        if observation.source_kind not in ("phone", "uuid"):
            raise IngressLedgerError("source kind is invalid")
        if observation.conversation_kind not in ("direct", "group"):
            raise IngressLedgerError("conversation kind is invalid")
        if (
            not isinstance(observation.reply_destination, str)
            or not observation.reply_destination
            or len(observation.reply_destination) > MAX_DESTINATION_CHARS
        ):
            raise IngressLedgerError("reply destination is invalid")
        if observation.sequence < 1 or observation.received_at < 1:
            raise IngressLedgerError("ingress sequence or time is invalid")
        try:
            content_bytes = observation.content.encode("utf-8", errors="strict")
        except (AttributeError, UnicodeEncodeError) as error:
            raise IngressLedgerError("ingress content is invalid UTF-8") from error
        if not content_bytes or len(content_bytes) > MAX_CONTENT_BYTES:
            raise IngressLedgerError("ingress content is empty or oversized")
        binding_id = _binding_id(observation)
        content_digest = hashlib.sha256(content_bytes).hexdigest()
        self._db.execute("BEGIN IMMEDIATE")
        try:
            existing = self._db.execute(
                "SELECT * FROM signal_ingress WHERE ingress_id = ?",
                (observation.ingress_id,),
            ).fetchone()
            if existing:
                expected = (
                    binding_id,
                    observation.account_id,
                    observation.source_id,
                    observation.source_kind,
                    observation.conversation_id,
                    observation.conversation_kind,
                    observation.reply_destination,
                    observation.sequence,
                    observation.received_at,
                    content_digest,
                    observation.content,
                )
                actual = tuple(
                    existing[key]
                    for key in (
                        "binding_id",
                        "account_id",
                        "source_id",
                        "source_kind",
                        "conversation_id",
                        "conversation_kind",
                        "reply_destination",
                        "sequence",
                        "received_at",
                        "content_digest",
                        "content",
                    )
                )
                if actual != expected:
                    raise IngressLedgerError("ingress replay binding conflict")
                self._db.execute("COMMIT")
                return self._view(existing)
            count = self._db.execute("SELECT COUNT(*) FROM signal_ingress").fetchone()[0]
            if count >= self._max_records:
                raise IngressLedgerError("ingress ledger capacity exhausted")
            try:
                self._db.execute(
                    """
                    INSERT INTO signal_ingress (
                      ingress_id, binding_id, account_id, source_id, conversation_id,
                      source_kind, conversation_kind, reply_destination, sequence,
                      received_at, content_digest, content
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        observation.ingress_id,
                        binding_id,
                        observation.account_id,
                        observation.source_id,
                        observation.conversation_id,
                        observation.source_kind,
                        observation.conversation_kind,
                        observation.reply_destination,
                        observation.sequence,
                        observation.received_at,
                        content_digest,
                        observation.content,
                    ),
                )
            except sqlite3.IntegrityError as error:
                raise IngressLedgerError("ingress sequence replay conflict") from error
            row = self._db.execute(
                "SELECT * FROM signal_ingress WHERE ingress_id = ?", (observation.ingress_id,)
            ).fetchone()
            self._db.execute("COMMIT")
            if row is None:
                raise IngressLedgerError("ingress did not persist")
            return self._view(row)
        except Exception:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise

    @_serialized
    def lookup(self, ingress_id: str) -> IngressView | None:
        _identifier(ingress_id, "ingress_id")
        row = self._db.execute(
            "SELECT * FROM signal_ingress WHERE ingress_id = ?", (ingress_id,)
        ).fetchone()
        return None if row is None else self._view(row)

    @_serialized
    def pull(self, *, after_ordinal: int, limit: int) -> tuple[IngressView, ...]:
        if after_ordinal < 0 or not 1 <= limit <= 100:
            raise IngressLedgerError("ingress pull bounds are invalid")
        rows = self._db.execute(
            "SELECT * FROM signal_ingress WHERE ordinal > ? ORDER BY ordinal LIMIT ?",
            (after_ordinal, limit),
        ).fetchall()
        return tuple(self._view(row) for row in rows)

    @_serialized
    def bind_frame(self, frame: ReleaseFrame) -> BoundDelivery:
        row = self._db.execute(
            "SELECT * FROM signal_ingress WHERE ingress_id = ?", (frame.ingress_id,)
        ).fetchone()
        if row is None:
            raise IngressLedgerError("frame ingress is unknown")
        if (
            frame.destination_binding_id != row["binding_id"]
            or frame.account_id != row["account_id"]
            or frame.turn_sequence != row["sequence"]
        ):
            raise IngressLedgerError("frame destination binding does not match ingress authority")
        return BoundDelivery(
            ingress_id=row["ingress_id"],
            binding_id=row["binding_id"],
            account_id=row["account_id"],
            destination_kind=row["conversation_kind"],
            reply_destination=row["reply_destination"],
            turn_sequence=row["sequence"],
        )
