# IDE Integration & Session Harvesting Guide

Locus bridges **Cursor**, **Claude Code**, **Windsurf**, and **`AGENTS.md`-compatible tools (Codex CLI, OpenCode, Zed, Amp)** non-destructively while keeping `git status` clean.

---

## 1. One-Command Project Setup

Inside any repository:

```bash
locus init
```

Optional flags:
- `--targets cursor,claude-code,agents,windsurf` — Choose specific IDE bridge files to generate.
- `--max-tokens 850` — Customize the token cap of `.locus/HANDOFF.md`.
- `--shared` — Commit `.locus/HANDOFF.md`, `CLAUDE.md`, and `AGENTS.md` to Git for team-wide sharing (instead of local-only `.git/info/exclude`).
- `--no-mcp` — Skip editing `.cursor/mcp.json` and `.mcp.json`.
- `--no-hooks` — Skip adding Claude Code lifecycle hooks to `.claude/settings.local.json`.

---

## 2. How Each IDE Connects

### Cursor
1. **Auto-Injected Rule (`.cursor/rules/locus-handoff.mdc`):**
   - Generated with `alwaysApply: true` YAML frontmatter so Cursor Composer/Agent immediately knows the active objective, dirty file intent, dead ends, and Research Vault index without wasting a prompt.
2. **Project MCP Server (`.cursor/mcp.json`):**
   - Non-destructively merges `mcpServers.locus` alongside any existing MCP servers (such as Postgres, GitHub, or Linear).
3. **Abrupt-Exit Session Harvester (`src/bridge/harvesters/cursor-harvester.ts`):**
   - Locates Cursor's workspace folder under `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/` (macOS), `~/.config/Cursor/User/workspaceStorage/<hash>/` (Linux), or `%APPDATA%/Cursor/User/workspaceStorage/<hash>/` (Windows) by matching `workspace.json`'s `file://` URI against `repoRoot`.
   - Opens `state.vscdb` in **`readonly: true`** mode so a running Cursor instance is never locked or interrupted.
   - Extracts recent user prompts, AI responses, and selected file contexts from `composer.composerData`, `workbench.panel.aichat.view.aichat.chatdata`, and `aiService.prompts` / `aiService.generations`.

---

### Claude Code
1. **Context Import (`CLAUDE.local.md` or `CLAUDE.md`):**
   - Manages an isolated `<!-- LOCUS:START --> ... <!-- LOCUS:END -->` block referencing `@.locus/HANDOFF.md` (using Claude Code's native `@file` import directive). Hand-written instructions outside the block are never modified.
2. **Project MCP Config (`.mcp.json`):**
   - Merges `mcpServers.locus` so Claude Code exposes all `locus_*` tools plus `/mcp__locus__resume-work` and `/mcp__locus__prepare-handoff` slash prompts.
3. **Automatic Lifecycle Hooks (`.claude/settings.local.json`):**
   - Configures `Stop` and `PreCompact` hooks invoking `locus hook stop` and `locus hook pre-compact`.
   - `locus hook` is engineered to always exit `0` so it never blocks or interrupts a Claude Code session.
4. **JSONL Transcript Harvester (`src/bridge/harvesters/claude-harvester.ts`):**
   - Reads `~/.claude/projects/<encoded-repo-slug>/*.jsonl` (matching both slug conventions and `cwd` metadata).
   - Extracts the latest substantive user objective, assistant progress summary, edited file paths (`Edit` / `Write` / `MultiEdit` `tool_use` inputs), and recent `tool_result` errors (`is_error: true`).

---

### Codex CLI / Windsurf / Universal `AGENTS.md`
- **`AGENTS.md`:** Updates only the `<!-- LOCUS:START --> ... <!-- LOCUS:END -->` block, preserving all existing repository instructions.
- **Windsurf (`.windsurf/rules/locus-handoff.md`):** Writes the token-budgeted capsule when `windsurf` is included in `--targets`.
- **Any Web or Terminal LLM (`locus handoff --briefing`):** Outputs a self-contained resume prompt you can copy to clipboard from CLI or Mission Control UI.

---

## 3. Clean Git Hygiene Model

By default (`shared: false`), Locus writes a managed section inside `<git-common-dir>/info/exclude`:

```gitignore
### LOCUS-MANAGED START ###
.locus/
CLAUDE.local.md
.claude/settings.local.json
.cursor/rules/locus-handoff.mdc
.cursor/mcp.json
.mcp.json
.windsurf/rules/locus-handoff.md
AGENTS.md
### LOCUS-MANAGED END ###
```

Why `.git/info/exclude` instead of `.gitignore`?
- `.gitignore` itself shows up as a modified file in `git status` on shared repositories where teammates may not use Locus yet.
- `.git/info/exclude` is native to Git, local to your machine, works across `git worktree`s via `gitCommonDir`, and keeps `git status` 100% clean.

---

## 4. Recommended Switching Workflow (Cursor ↔ Claude Code)

### Scenario A: Graceful Switch (Best Quality)
1. Before leaving Cursor (or Claude Code), run the MCP prompt `/prepare-handoff` or tell the agent: *"Save a Locus checkpoint and log any dead ends."*
2. Open Claude Code (or Cursor). The compiled `.locus/HANDOFF.md` is already loaded—continue working immediately.

### Scenario B: Abrupt Switch (Rate Limit / Crash / Closed Window)
1. Run `locus sync` in your terminal (takes `<100ms`).
2. Locus harvests the latest uningested Cursor `state.vscdb` or Claude Code `.jsonl` session, merges live `git status` dirty files, updates the branch Handoff Capsule, and recompiles all IDE bridge files.
3. Open your next IDE and pick right up where you left off.
