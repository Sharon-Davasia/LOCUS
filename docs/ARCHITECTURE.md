# Locus System Architecture

Locus is engineered around a core constraint: **switching IDEs must require zero manual copy-pasting, zero external cloud/API keys, and near-zero context window bloat.**

This document explains the internal design of Locus across its four implementation layers.

---

## 1. The 4-Tier Structured Memory Model

Raw chat transcripts make terrible handoff artifacts. A 40-turn debugging conversation in Cursor may contain 15,000 tokens of dead ends, stack traces, and half-reverted experiments—dumping that into Claude Code degrades reasoning accuracy and wastes context budget.

Locus decomposes project continuity into **four explicit memory tiers** with distinct lifecycles and delivery mechanisms:

| Tier | Scope | Injection Strategy | Purpose |
| :--- | :--- | :--- | :--- |
| **1. Branch Handoff Capsule** | `(project_id, branch)` | **Always pushed** (~300 tokens) | Answers *"Where was I right now?"* — active objective, state summary, hypothesis, checklist (`todo` / `in_progress` / `done` / `blocked`), blockers, next steps, and live uncommitted files. |
| **2. Dead Ends & Decisions** | `project_id` | **Summaries pushed** + full detail via MCP | **Dead Ends (`dead_end`):** failed libraries, ABI incompatibilities, or disproven hypotheses (*"Do not retry"*). **Decisions (`decision`):** architectural choices, rationales, and superseding chains (`supersedes_id`). |
| **3. Research Vault** | `project_id` | **Index pushed** + body pulled via MCP | Deep research notes, paper/RFC syntheses, API quirks, benchmark tables, and reference URLs. Only compact pointers (`id + title + tags`) appear in `.locus/HANDOFF.md`; agents pull full Markdown via `locus_get_entry` (**progressive disclosure**). |
| **4. Conventions** | `project_id` | **Summaries pushed** | Shared build/test invariants and architectural patterns enforced identically across every IDE. |

---

## 2. Git Worktree Identity & Git Drift Guard

### Shared Project Identity Across Worktrees
Engineers using Claude Code and Cursor side-by-side frequently check out parallel `git worktree` directories. If project identity were keyed on `process.cwd()`, each worktree would become a disconnected island.

Instead, `inspectGitRepo()` (`src/core/git.ts`) resolves:
- `repoRoot` (`git rev-parse --show-toplevel`) — worktree-specific root where local IDE bridge files are written.
- `gitCommonDir` (`git rev-parse --git-common-dir`) — canonical shared `.git` directory hashed to derive `project_id` (`proj_<sha1>`).

As a result:
- **Decisions, Dead Ends, Conventions, and Research** are immediately shared across all worktrees of the same repository.
- **Active Handoff Capsules** remain cleanly isolated per `(project_id, branch)`.

### Commit-Anchored Git Drift Detection
Code evolves faster than documentation. Whenever a memory is recorded with `relatedFiles`, Locus records `anchor_commit = HEAD`.

When memories are later compiled or searched, `GitDriftInspector` (`src/core/git.ts`) checks:
1. Whether any `relatedFiles` have been deleted or renamed (`missingFiles`).
2. Whether any `relatedFiles` are currently modified in the working tree (`dirtySet`).
3. Whether `git diff --name-only <anchor_commit>..HEAD` touched any `relatedFiles` (cached per commit pair so 50 memories require at most one `git diff` subprocess).

Drifted items are never silently trusted—they receive an explicit badge:
> `_(verify: src/transport.ts changed)_`

Once an engineer or agent verifies the note still holds, re-anchoring (`reanchorCommit: true`) updates `anchor_commit` to current `HEAD`.

---

## 3. Local Hybrid Search Engine (`src/core/search.ts`)

Keyword search alone misses conceptual paraphrases (e.g., querying `"Authorization headers ReadableStream"` when a note says `"streaming auth token fetch"`), while cloud embedding APIs break offline/zero-key operation.

Locus implements a millisecond **3-signal local hybrid ranker**:

1. **Lexical BM25 (`SQLite FTS5`):**
   - `memories_fts` indexes `title`, `summary`, `body`, `tags`, and `related_files` using `porter unicode61` tokenization, kept strictly in sync via SQLite `AFTER INSERT / UPDATE / DELETE` triggers.
   - Column weights prioritize titles (`3.5x`), tags (`2.5x`), summaries (`2.0x`), and file paths (`2.0x`) over raw body prose (`1.0x`).
   - `buildFtsQuery()` safely sanitizes arbitrary stack traces, slashes, hyphens, and camelCase identifiers so FTS5 never throws syntax errors.
2. **Deterministic Local Feature-Hashed Embeddings (256-dim `Float32Array`):**
   - Splits `camelCase` / `PascalCase` / `snake_case`, applies light suffix stemming, extracts token bigrams and 4-character subword n-grams, and projects them via signed FNV-1a hashing into an L2-normalized 256-dimensional `Float32Array` (stored as a 1 KB `BLOB` per memory).
   - Computes exact cosine similarity in `<0.2ms` across hundreds of project notes with zero network calls or external model downloads.
3. **Contextual Reranking:**
   - **Recency score:** Smooth 14-day half-life decay (`1 / (1 + ageHours / 336)`).
   - **Active File Boost (`+0.12`):** Memories referencing files currently uncommitted in `git status` rank higher automatically.
   - **Branch & Pin Boost:** Pinned items (`+0.08`) and current-branch entries (`+0.05`) surface first.

Final score formula:

$$\text{Score} = 0.52 \cdot \text{BM25}_{\text{norm}} + 0.33 \cdot \cos(\vec{q}, \vec{d}) + 0.08 \cdot \text{Recency} + \text{ContextBoost}$$

---

## 4. Dual-Channel Push + Pull Context Compiler (`src/bridge/compiler.ts`)

Locus avoids both **cold starts** (where an agent forgets to call an MCP tool on turn 1) and **context overload** (dumping everything into system rules):

1. **Push Channel (Compiled Capsule, Default Budget: 850 Tokens):**
   - Allocates dynamic token budgets across *Active Handoff (36%)*, *Live Git State (16%)*, and remaining capacity across *Dead Ends*, *Decisions*, *Conventions*, *Research Vault Index*, and the *MCP Continuity Protocol*.
   - Unused budget from empty tiers rolls forward automatically to populated tiers.
   - Emits `TokenBudgetReport` so you can inspect exact per-section token consumption in `locus status` or Mission Control.
2. **Pull Channel (`src/mcp/server.ts`):**
   - When the agent sees a relevant Research Vault pointer (`mem_a1b2c3d4 — Ed25519 Latency Benchmarks [crypto, benchmarks]`) or wants deeper history, it calls `locus_get_entry` or `locus_search` on demand.
   - Any mutation via MCP (`locus_checkpoint`, `locus_record`, `locus_update_task`) immediately triggers `writeIdeBridges()` so disk rules stay synchronized in real time.
