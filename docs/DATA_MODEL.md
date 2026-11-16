# Locus Data Model & Storage Specification

Locus stores all structured state locally in a single SQLite database running in **Write-Ahead Logging (`WAL`)** mode (`~/.locus/locus.db` by default, configurable via `LOCUS_DB_PATH` or `LOCUS_HOME`).

---

## 1. Concurrency & Connection Settings (`src/core/db.ts`)

Because Cursor's MCP server, Claude Code's MCP server, Claude lifecycle hooks, CLI invocations, and the Mission Control UI may all access the database simultaneously on the same laptop, every connection configures:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

---

## 2. Relational Schema

### `projects`
Represents a canonical codebase across any number of `git worktree` checkouts.
- `id TEXT PRIMARY KEY` — Deterministic `proj_<12-char-sha1>` derived from `gitCommonDir` (or `repoRoot` for non-git folders).
- `name TEXT NOT NULL`
- `root_path TEXT NOT NULL`
- `git_common_dir TEXT`
- `default_branch TEXT NOT NULL`
- `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`

### `handoffs`
Branch-scoped working state (`UNIQUE(project_id, branch)`).
- `id TEXT PRIMARY KEY`
- `project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
- `branch TEXT NOT NULL`
- `worktree_path TEXT NOT NULL`
- `objective TEXT NOT NULL`
- `summary TEXT NOT NULL`
- `active_hypothesis TEXT NOT NULL`
- `tasks_json TEXT NOT NULL` — JSON array of `{ id, text, status, files? }`
- `blockers_json TEXT NOT NULL` — JSON string array
- `next_steps_json TEXT NOT NULL` — JSON string array
- `active_files_json TEXT NOT NULL` — JSON string array
- `head_sha TEXT`
- `dirty_signature TEXT` — SHA-1 fingerprint of `(head_sha + git porcelain dirty paths)`
- `last_ide TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### `memories`
Project-scoped knowledge items across all four long-lived tiers.
- `id TEXT PRIMARY KEY` (`mem_<10-char-hex>`)
- `project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
- `branch TEXT`
- `kind TEXT NOT NULL` — `'decision' | 'dead_end' | 'research' | 'convention' | 'note'`
- `title TEXT NOT NULL`
- `summary TEXT NOT NULL`
- `body TEXT NOT NULL`
- `tags_json TEXT NOT NULL`
- `related_files_json TEXT NOT NULL`
- `source_urls_json TEXT NOT NULL`
- `anchor_commit TEXT` — Git commit SHA at creation/verification time for Git Drift detection
- `source_ide TEXT NOT NULL`
- `status TEXT NOT NULL` — `'active' | 'superseded' | 'archived'`
- `superseded_by TEXT`
- `pinned INTEGER NOT NULL DEFAULT 0`
- `embedding BLOB` — 1,024-byte (`256 × float32`) L2-normalized local feature-hashed vector
- `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`

### `memories_fts` (SQLite FTS5 Virtual Table)
Synchronized automatically via `trg_memories_ai`, `trg_memories_au`, and `trg_memories_ad` triggers:
```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  memory_id UNINDEXED,
  project_id UNINDEXED,
  title,
  summary,
  body,
  tags,
  related_files,
  tokenize = 'porter unicode61'
);
```

### `timeline_events`
Cross-IDE audit and continuity log.
- `id TEXT PRIMARY KEY`
- `project_id TEXT NOT NULL`
- `branch TEXT`
- `source_ide TEXT NOT NULL`
- `event_type TEXT NOT NULL` — `'init' | 'checkpoint' | 'memory_recorded' | 'memory_updated' | 'session_harvested' | 'ide_switch' | 'bridge_compiled'`
- `summary TEXT NOT NULL`
- `metadata_json TEXT NOT NULL`
- `created_at TEXT NOT NULL`

### `harvester_cursors`
Idempotency watermarks (`UNIQUE(project_id, source)`) ensuring `locus sync` never re-ingests unchanged Cursor `state.vscdb` snapshots or Claude Code `.jsonl` files.

---

## 3. Privacy & Local-First Guarantees

- **Zero Telemetry / Zero Cloud Sync:** All project memories, embeddings, and harvested session summaries remain strictly on your laptop disk (`~/.locus/locus.db` and `.locus/`).
- **Read-Only IDE Inspection:** Session harvesters open Cursor's `state.vscdb` with `{ readonly: true }` and read Claude Code's `.jsonl` transcripts non-destructively.
- **Zero Git Pollution:** Local bridge artifacts are excluded via `.git/info/exclude` unless `--shared` is explicitly passed.
