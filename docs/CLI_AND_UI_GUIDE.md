# Locus CLI & Mission Control Web UI Guide

Locus provides both a fast `<50ms` terminal CLI (`locus`) and an interactive local browser dashboard (`locus ui`).

---

## 1. CLI Reference

### `locus init`
Initializes Locus inside a repository.
```bash
locus init [--project <path>] [--targets cursor,claude-code,agents,windsurf] [--max-tokens 850] [--shared] [--no-mcp] [--no-hooks]
```

### `locus status`
Displays the active project ID, branch, dirty file count, last active IDE, current objective, structured memory counts, Git Drift warnings, and capsule token budget utilization.
```bash
locus status [--json]
```

### `locus handoff`
Outputs the compiled `.locus/HANDOFF.md` capsule to `stdout`. Pass `--briefing` for a self-contained resume prompt ready to pipe to `pbcopy` / `xclip`.
```bash
locus handoff
locus handoff --briefing | pbcopy
```

### `locus checkpoint`
Updates the active branch Handoff Capsule directly from the terminal.
```bash
locus checkpoint \
  --objective "Implement async iterator pagination" \
  --summary "Core cursor loop complete; retry tests next" \
  --hypothesis "64-item pages balance latency and memory" \
  --done "Define AsyncIterable types" \
  --doing "Wire page token loop" \
  --todo "Add rate-limit retry integration test" \
  --next "Run vitest suite against mock server" \
  --ide claude-code
```

### `locus record` & Shorthand Commands (`decide`, `dead-end`, `research`, `convention`)
```bash
# Record a dead end
locus dead-end "undici v5 interceptor removed in v6" \
  "Do not use compose(interceptors.retry()); use RetryAgent in v6." \
  --files src/client.ts --tags http,undici --ide cursor

# Record an architectural decision (optionally superseding an older decision)
locus decide "Use Ed25519 JWKS for session verification" \
  "0.09ms p99 verification latency and smaller headers than RSA-2048." \
  --tags auth,crypto --supersedes mem_a1b2c3d4ef

# Save research notes to the Vault
locus research "SQLite WAL Concurrency Notes" \
  "busy_timeout=5000 + WAL allows concurrent MCP readers and writers safely." \
  --tags sqlite,storage --url https://www.sqlite.org/wal.html

# Record a convention
locus convention "All browser API requests must use relative /api paths" \
  "Never hardcode localhost so reverse-proxied environments work seamlessly."
```

### `locus search` & `locus show`
```bash
locus search "Ed25519 latency verification"
locus search "undici" --kind dead_end
locus show mem_919ac8575b
```

### `locus sync`, `locus log`, & `locus doctor`
```bash
locus sync      # Harvest latest Cursor & Claude Code local sessions + recompile bridges
locus log       # Inspect chronological Cross-IDE Continuity Timeline
locus doctor    # Verify SQLite DB path, git worktree mapping, and bridge files
```

---

## 2. Mission Control Web UI (`locus ui`)

Start the local Mission Control server:

```bash
locus ui --port 4317
```

Mission Control organizes project continuity into five interactive views:

1. **Handoff Capsule:**
   - Live editor for Objective, Working State Summary, Active Hypothesis, Next Steps, and Blockers.
   - One-click **Step Checklist** status cycling (`todo` → `in_progress` → `done` → `blocked`).
   - Visual **Token Budget Allocation** bar showing exact token consumption across every compiled section.
   - **Live Git Working Tree** inspector listing uncommitted files.
2. **Decisions & Dead Ends:**
   - Side-by-side architectural guardrails separating *Dead Ends ("Do Not Retry")* from *Active Decisions*.
   - Highlights **Git Drift** (`Verify: file modified since recorded`) with a one-click **"Mark Verified at Current HEAD"** button (`reanchorCommit: true`).
3. **Research Vault & Hybrid Search:**
   - Real-time hybrid search bar combining FTS5 BM25, 256-dim local vector similarity, and active file boost.
   - Kind filter pills, expandable Markdown body viewer, pin toggle, and **+ Record Memory** modal.
4. **IDE Bridges & Preview:**
   - Live switcher inspecting `.locus/HANDOFF.md`, `.cursor/rules/locus-handoff.mdc`, and the pasteable Resume Briefing.
   - **Bridge & MCP File Health** checklist with one-click **Initialize / Repair** and **Sync Sessions** actions.
5. **Cross-IDE Timeline:**
   - Chronological stream of checkpoints, `ide_switch` transitions (`Cursor → Claude Code`), harvested sessions, and recorded memories.

---

## 3. Local HTTP REST API Endpoints

All UI actions communicate over clean JSON endpoints in `src/server/app.ts`:

| Method & Path | Description |
| :--- | :--- |
| `GET /api/health` | Service health & default project metadata |
| `GET /api/projects` | List all registered projects on the laptop |
| `POST /api/projects/ensure` | Register or resolve a repository path |
| `GET /api/projects/:id/overview` | Consolidated project, git, handoff, stats, compiled capsule, bridge health, & timeline |
| `PUT /api/projects/:id/handoff` | Save/update branch Handoff Capsule & recompile bridges |
| `PATCH /api/projects/:id/handoff/tasks` | Update individual checklist step status |
| `GET /api/projects/:id/memories` | List memories or execute hybrid search (`?q=...&kind=...&tag=...`) |
| `GET /api/memories/:memoryId` | Fetch single memory entry with live Git Drift status |
| `POST /api/projects/:id/memories` | Record a new structured memory & recompile bridges |
| `PATCH /api/memories/:memoryId` | Edit memory, toggle `pinned`, archive, or `reanchorCommit` |
| `DELETE /api/memories/:memoryId` | Delete a memory entry & recompile bridges |
| `POST /api/projects/:id/sync` | Run Cursor + Claude Code session harvesters & refresh bridges |
| `POST /api/projects/:id/init` | Initialize or repair IDE bridge & MCP config files |
