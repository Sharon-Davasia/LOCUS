# Locus

**Local-first project memory palace, context compiler, and seamless cross-IDE handoff engine.**

> *Named after the classical **Method of Loci** (memory palace) and the Latin word for "the exact place where things converge."*

When you switch mid-flow between **Cursor**, **Claude Code**, **Windsurf**, or **Codex**, your project's active working state normally evaporates: uncommitted file intent gets misread, architectural context vanishes, and the incoming agent wastes time and tokens repeating dead ends you already ruled out ten minutes ago.

**Locus (`locus`)** runs quietly on your laptop (100% local SQLite + WAL, zero external API keys required) and keeps every IDE continuously synchronized around a single structured memory space.

---

## Key Capabilities

- **4-Tier Structured Project Memory** — Separates branch-scoped **Active Handoff Capsules** from project-wide **Dead Ends ("Do Not Retry")**, **Architectural Decisions**, **Conventions**, and a deep **Research Vault**.
- **Dual-Channel IDE Bridge (Push + Pull)**
  - **Push (0-second cold start):** Compiles a token-budgeted `.locus/HANDOFF.md` (~850 tokens default) and non-destructively bridges it into Cursor (`.cursor/rules/locus-handoff.mdc`), Claude Code (`CLAUDE.local.md` via `@.locus/HANDOFF.md`), Windsurf, and `AGENTS.md`.
  - **Pull (Progressive Disclosure via MCP):** Exposes 8 MCP tools (`locus_search`, `locus_get_entry`, `locus_record`, `locus_checkpoint`, etc.) so agents fetch deep research notes or benchmark tables only when needed.
- **Abrupt-Exit Session Harvesters** — Forgot to checkpoint before closing Cursor or hitting a rate limit in Claude Code? `locus sync` (and automatic Claude Code lifecycle hooks) harvests local Cursor `state.vscdb` SQLite composer logs, `~/.claude/projects/*.jsonl` transcripts, and live `git diff` state automatically.
- **Git Worktree & Drift Awareness** — Shares project-wide knowledge across `git worktree`s while keeping Handoff Capsules branch-isolated. Anchors memories to `git` commits and flags `[Verify: file changed]` whenever referenced files drift.
- **100% Clean `git status`** — Manages generated local bridge files inside `.git/info/exclude` by default so teammates never see noise in pull requests (with `--shared` opt-in when you want to commit project memory).
- **Local Mission Control Dashboard (`locus ui`)** — Interactive browser UI to edit Handoff Capsules, inspect Token Budget allocation, search the Research Vault, review Decisions & Dead Ends, and watch the Cross-IDE Timeline.

---

## Architecture Overview

```text
  Cursor / Windsurf / Codex                 Claude Code (CLI / IDE)
     │                 ▲                       │                 ▲
     │ MCP + vscdb     │ Compiled              │ Hooks + MCP +   │ Compiled
     │ Harvester       │ .cursor/rules/*.mdc   │ JSONL Harvester │ @.locus/HANDOFF.md
     ▼                 │                       ▼                 │
┌───────────────────────────────────────────────────────────────────────────┐
│                         LOCUS CORE ENGINE (Local)                         │
│                                                                           │
│  ┌──────────────────┐  ┌───────────────────┐  ┌────────────────────────┐  │
│  │ 1. Hot Handoff   │  │ 2. Decisions &    │  │ 3. Research &          │  │
│  │    Capsule       │  │    Dead Ends      │  │    Knowledge Vault     │  │
│  │ (Branch-scoped)  │  │ (Project-scoped)  │  │ (Progressive via MCP)  │  │
│  └──────────────────┘  └───────────────────┘  └────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ SQLite (WAL) + FTS5 BM25 + 256-dim Local Vector + Git Drift Guard   │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
             ▲                                             ▲
             │                                             │
      `locus` Fast CLI                        Mission Control UI (`locus ui`)
```

---

## Quickstart

### 1. Build & Link `locus`

```bash
npm install
npm run build
npm link   # makes `locus` available globally on your laptop
```

### 2. Initialize Locus in Any Project

```bash
cd /path/to/your-project
locus init
```

`locus init` non-destructively sets up:
- `.locus/config.json` & `.locus/HANDOFF.md`
- `.cursor/rules/locus-handoff.mdc` & `.cursor/mcp.json`
- `CLAUDE.local.md` (`@.locus/HANDOFF.md`), `.mcp.json`, & `.claude/settings.local.json` (`Stop` & `PreCompact` hooks)
- `AGENTS.md` managed block
- `.git/info/exclude` entries so `git status` stays completely clean

### 3. Work & Switch IDEs Seamlessly

```bash
# Record a dead end so no incoming IDE repeats a failed approach
locus dead-end "foo-rtc crashes on Node 22 N-API" \
  "Segfaults during V8 isolate teardown on Node 22.22; use native WebTransport instead." \
  --files src/transport.ts --ide cursor

# Save research notes to the Vault
locus research "Exponential Backoff Jitter Benchmarks" \
  "Decorrelated jitter cuts reconnect contention by 68% under burst load." \
  --tags transport,benchmarks

# Save a quick handoff checkpoint (or let your IDE call `locus_checkpoint` via MCP)
locus checkpoint \
  --objective "Finish TransportManager retry state machine" \
  --doing "Wire AbortSignal cancellation" \
  --next "Add maxRetries integration test"

# Closed Cursor or Claude Code abruptly? Harvest local session trails + refresh bridges:
locus sync

# Launch the Mission Control Web UI
locus ui
```

---

## CLI Command Summary

| Command | Purpose |
| :--- | :--- |
| `locus init` | Configure project bridges, MCP servers, Claude hooks, and `.git/info/exclude` |
| `locus status` | Display active branch, last IDE, objective, memory counts, drift warnings, and token usage |
| `locus handoff [--briefing]` | Print compiled `.locus/HANDOFF.md` or a pasteable resume prompt |
| `locus checkpoint` | Update branch objective, summary, hypothesis, checklist tasks, blockers, and next steps |
| `locus decide <title> [body]` | Record an architectural decision (`kind = decision`) |
| `locus dead-end <title> [body]` | Record a failed approach (`kind = dead_end`) so agents never retry it |
| `locus research <title> [body]` | Store deep research notes, benchmarks, or docs in the Vault (`kind = research`) |
| `locus convention <title> [body]` | Store a project-wide engineering convention (`kind = convention`) |
| `locus search <query>` | Hybrid FTS5 BM25 + semantic vector + git-context search across all memories |
| `locus show <id>` | View full Markdown entry and live Git Drift status |
| `locus log` | View the chronological Cross-IDE Continuity Timeline |
| `locus sync` | Harvest latest Cursor (`state.vscdb`) & Claude Code (`*.jsonl`) sessions and recompile bridges |
| `locus mcp` | Run the stdio Model Context Protocol server |
| `locus ui` | Launch the local Mission Control web dashboard (`http://127.0.0.1:4317`) |
| `locus doctor` | Verify database health, git worktree mapping, and bridge files |

---

## Documentation Index

- **[System Architecture (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md)** — 4-tier memory design, token-budgeted compiler, hybrid search math, and Git Drift detection.
- **[IDE Integration Guide (`docs/IDE_INTEGRATION.md`)](docs/IDE_INTEGRATION.md)** — How Locus bridges Cursor, Claude Code, Windsurf, and Codex, plus session harvesters and git hygiene.
- **[MCP Server Reference (`docs/MCP_REFERENCE.md`)](docs/MCP_REFERENCE.md)** — Complete specification of all 8 MCP tools, 3 resources, and 2 slash prompts.
- **[CLI & Mission Control UI Guide (`docs/CLI_AND_UI_GUIDE.md`)](docs/CLI_AND_UI_GUIDE.md)** — Detailed CLI flags, workflows, Mission Control UI tour, and HTTP API endpoints.
- **[Data Model & Storage (`docs/DATA_MODEL.md`)](docs/DATA_MODEL.md)** — SQLite WAL schema, FTS5 virtual tables, local embeddings, and privacy architecture.

---

## Development & Verification

```bash
npm run typecheck   # Strict TypeScript check across Core, CLI, MCP, API & React UI
npm test            # Run Vitest unit & end-to-end integration test suites (Phases 1–4)
npm run build       # Compile dist/ core + dist/web/ Mission Control bundle
```
