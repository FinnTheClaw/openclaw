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

## Configure

Use the memory plugin docs for embedding provider setup, storage paths, indexing, and recall behavior:

- https://docs.openclaw.ai/plugins/memory-lancedb

## Package

- Plugin id: `memory-lancedb`
- Package: `@openclaw/memory-lancedb`
- Minimum OpenClaw host: `2026.4.10`
