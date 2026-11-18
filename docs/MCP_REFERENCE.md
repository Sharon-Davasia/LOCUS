# Locus MCP Server Reference

`locus mcp` runs a standard Model Context Protocol (MCP) server over `stdio` (`src/mcp/server.ts`), compatible with Cursor, Claude Code, Windsurf, Codex CLI, Zed, and any MCP client.

```json
{
  "mcpServers": {
    "locus": {
      "command": "locus",
      "args": ["mcp", "--project", "/absolute/path/to/repo"]
    }
  }
}
```

---

## 1. MCP Tools (8 Tools)

### `locus_get_handoff`
Returns the compiled branch Handoff Capsule Markdown plus token budget telemetry.
- **Inputs:**
  - `projectPath?: string`
  - `branch?: string`
  - `maxTokens?: number` (`300..4000`, default `850`)

---

### `locus_checkpoint`
Saves or updates the active branch Handoff Capsule and immediately recompiles `.locus/HANDOFF.md` and configured IDE rule bridges.
- **Inputs:**
  - `projectPath?: string`
  - `objective?: string` — Overarching goal on the current branch.
  - `summary?: string` — Concise explanation of current state & uncommitted changes.
  - `activeHypothesis?: string` — Current design hypothesis being validated.
  - `tasks?: Array<{ text: string; status: 'done' | 'in_progress' | 'todo' | 'blocked'; files?: string[] }>`
  - `blockers?: string[]`
  - `nextSteps?: string[]`
  - `activeFiles?: string[]`
  - `mergeTasks?: boolean` — When `true`, merges incoming tasks by text instead of replacing existing steps.
  - `sourceIde?: 'cursor' | 'claude-code' | 'windsurf' | 'codex' | 'cli' | 'ui' | 'mcp' | 'git'`

---

### `locus_record`
Stores a structured project memory, anchors it to the current Git `HEAD` commit for Drift Detection, and refreshes IDE bridges.
- **Inputs:**
  - `kind: 'decision' | 'dead_end' | 'research' | 'convention' | 'note'`
  - `title: string`
  - `summary?: string` — 1–2 line summary (auto-derived from `body` if omitted).
  - `body: string` — Full Markdown content (rationale, root cause, benchmarks, snippets).
  - `tags?: string[]`
  - `relatedFiles?: string[]` — Relative paths monitored for Git Drift.
  - `sourceUrls?: string[]`
  - `supersedesId?: string` — Marks an older memory entry as `superseded`.
  - `pinned?: boolean`
  - `sourceIde?: SourceIde`

---

### `locus_search`
Runs hybrid search (SQLite FTS5 BM25 + 256-dim local semantic vector cosine + git dirty-file boost + recency) across active project memories.
- **Inputs:**
  - `query: string`
  - `kinds?: Array<'decision' | 'dead_end' | 'research' | 'convention' | 'note'>`
  - `tags?: string[]`
  - `limit?: number` (`1..30`, default `8`)
- **Returns:** Ranked results with `id`, `kind`, `title`, `summary`, `snippet`, `score`, `tags`, `relatedFiles`, `sourceIde`, and live `drift` status.

---

### `locus_get_entry`
Progressive disclosure tool: retrieves the complete Markdown `body`, `sourceUrls`, `anchorCommit`, and live `drift` report of a specific memory ID (for example, an entry listed in the Research Vault Index).
- **Inputs:**
  - `id: string` (e.g., `mem_919ac8575b`)
  - `projectPath?: string`

---

### `locus_list_recent`
Lists recent memories (optionally filtered by `kinds`) alongside the 10 most recent Cross-IDE Timeline events.
- **Inputs:**
  - `kinds?: MemoryKind[]`
  - `limit?: number` (`1..50`, default `12`)

---

### `locus_update_task`
Updates a single task step in the current branch's Handoff checklist by ID or substring match and recompiles IDE bridges.
- **Inputs:**
  - `taskIdOrQuery: string`
  - `status: 'done' | 'in_progress' | 'todo' | 'blocked'`
  - `sourceIde?: SourceIde`

---

### `locus_sync`
Triggers immediate session harvesting (Cursor `state.vscdb` + Claude Code JSONL + live `git` working tree) and recompiles IDE bridge files.
- **Inputs:**
  - `projectPath?: string`

---

## 2. MCP Resources (3 Resources)

| URI | MIME Type | Description |
| :--- | :--- | :--- |
| `locus://handoff/current` | `text/markdown` | Live compiled `.locus/HANDOFF.md` for the active branch |
| `locus://memories/dead-ends` | `application/json` | All active `dead_end` entries with drift metadata |
| `locus://memories/decisions` | `application/json` | All active `decision` entries with drift metadata |

---

## 3. MCP Slash Prompts (2 Prompts)

| Prompt Name | Arguments | Usage |
| :--- | :--- | :--- |
| `resume-work` | *(none)* | Injects the active Handoff Capsule and instructs the incoming IDE agent to verify drifted files and continue seamlessly. |
| `prepare-handoff` | `targetIde?: string` | Guides the current IDE agent to log new `decision`s / `dead_end`s via `locus_record` and save a clean `locus_checkpoint` before switching IDEs. |

---

## 4. Shared Types

| Type | Values |
| :--- | :--- |
| `MemoryKind` | `'decision' \| 'dead_end' \| 'research' \| 'convention' \| 'note'` |
| `SourceIde` | `'cursor' \| 'claude-code' \| 'windsurf' \| 'codex' \| 'cli' \| 'ui' \| 'mcp' \| 'git'` |

---

## 5. Tool Summary

| Tool | Changes stored state | Recompiles IDE bridges |
| :--- | :---: | :---: |
| `locus_get_handoff` | No | No |
| `locus_checkpoint` | Yes | Yes |
| `locus_record` | Yes | Yes |
| `locus_search` | No | No |
| `locus_get_entry` | No | No |
| `locus_list_recent` | No | No |
| `locus_update_task` | Yes | Yes |
| `locus_sync` | Yes | Yes |
