# @openclaw/memory-lancedb

Official LanceDB-backed long-term memory plugin for OpenClaw.

This plugin adds persistent memory tools backed by LanceDB, vector search, auto-recall, and auto-capture.

## Install

```bash
openclaw plugins install @openclaw/memory-lancedb
```

Restart the Gateway after installing or updating the plugin.

## What it provides

- `memory_store`
- `memory_recall`
- `memory_forget`
- LanceDB vector storage and hybrid memory retrieval.

When durable memory is enabled, SQLite WAL is the append-only source of truth and
LanceDB is a rebuildable hybrid-search projection. Gateway startup also discovers
canonical `MEMORY.md` and recursively discovered Markdown under `memory/`, imports them as
bounded chunks, and records indexed per-source checkpoints. Unchanged files need
only metadata checks; changed or deleted files retract their old projections.
There is no memory-record or Markdown-file rollover limit.

## Recover durable dead letters

Repair and verify the failed dependency before retrying durable work. Preserve an
evidence snapshot, then requeue only the affected lane:

```bash
openclaw ltm stats
openclaw ltm snapshot ~/.openclaw/backups/memory-ledger-before-retry.sqlite3
openclaw ltm retry-dead --queue projection
openclaw ltm retry-dead --queue extraction
```

Use `--queue all` only when both embedding projection and fact extraction are
healthy. Recovery is atomic and idempotent: it does not delete source events or
their prior diagnostics, and an already-requeued lane reports zero changes. The
CLI changes ledger state only; it never performs provider requests. A running
Gateway discovers requeued and retryable work on its bounded 30-second retry
wake, using the Gateway's configured credentials and network trust.

Durable workers and the open ledger survive an in-process Gateway restart. A
final Gateway shutdown still flushes, checkpoints, and closes them normally.

## Configure

Use the memory plugin docs for embedding provider setup, storage paths, indexing, and recall behavior:

- https://docs.openclaw.ai/plugins/memory-lancedb

## Package

- Plugin id: `memory-lancedb`
- Package: `@openclaw/memory-lancedb`
- Minimum OpenClaw host: `2026.4.10`
