import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BranchHandoff,
  CheckpointInput,
  GitRepoState,
  MemoryEntry,
  MemoryKind,
  MemoryStatus,
  MemoryWithDrift,
  Project,
  RecordMemoryInput,
  SearchOptions,
  SearchResult,
  SourceIde,
  TaskStatus,
  TaskStep,
  TimelineEvent,
  TimelineEventType,
} from '../types.js';
import { openLocusDatabase } from './db.js';
import { GitDriftInspector, inspectGitRepo } from './git.js';
import {
  blobToEmbedding,
  buildFtsQuery,
  buildSearchSnippet,
  computeLocalEmbedding,
  computeRecencyScore,
  cosineSimilarity,
  embeddingToBlob,
} from './search.js';
import { deriveSummary } from './tokens.js';

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  git_common_dir: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
}

interface HandoffRow {
  id: string;
  project_id: string;
  branch: string;
  worktree_path: string;
  objective: string;
  summary: string;
  active_hypothesis: string;
  tasks_json: string;
  blockers_json: string;
  next_steps_json: string;
  active_files_json: string;
  head_sha: string | null;
  dirty_signature: string | null;
  last_ide: SourceIde;
  updated_at: string;
}

interface MemoryRow {
  id: string;
  project_id: string;
  branch: string | null;
  kind: MemoryKind;
  title: string;
  summary: string;
  body: string;
  tags_json: string;
  related_files_json: string;
  source_urls_json: string;
  anchor_commit: string | null;
  source_ide: SourceIde;
  status: MemoryStatus;
  superseded_by: string | null;
  pinned: number;
  embedding: Buffer | null;
  created_at: string;
  updated_at: string;
}

interface TimelineRow {
  id: string;
  project_id: string;
  branch: string | null;
  source_ide: SourceIde;
  event_type: TimelineEventType;
  summary: string;
  metadata_json: string;
  created_at: string;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRelPath(repoRoot: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return '';
  if (path.isAbsolute(trimmed)) {
    const rel = path.relative(repoRoot, trimmed).replace(/\\/g, '/');
    return rel.startsWith('..') ? trimmed : rel;
  }
  return trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniqueCleanStrings(items: string[] | undefined): string[] {
  if (!items) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export class LocusEngine {
  public readonly db: Database.Database;

  constructor(dbOrPath?: Database.Database | string) {
    this.db =
      typeof dbOrPath === 'object' && dbOrPath !== null
        ? dbOrPath
        : openLocusDatabase(dbOrPath);
  }

  close(): void {
    this.db.close();
  }

  ensureProject(targetPath: string = process.cwd()): {
    project: Project;
    git: GitRepoState;
  } {
    const resolved = fs.existsSync(targetPath)
      ? fs.realpathSync.native(path.resolve(targetPath))
      : path.resolve(targetPath);

    const git = inspectGitRepo(resolved);
    const identityAnchor = git.gitCommonDir ?? git.repoRoot;
    const projectId =
      'proj_' + createHash('sha1').update(identityAnchor).digest('hex').slice(0, 12);

    const existing = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as ProjectRow | undefined;

    const now = new Date().toISOString();

    if (existing) {
      // Keep root_path updated to most recently active checkout if not a secondary worktree,
      // and update updated_at
      this.db
        .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
        .run(now, projectId);

      return {
        project: this.mapProject({ ...existing, updated_at: now }),
        git,
      };
    }

    const projectName = path.basename(git.repoRoot) || 'project';
    const defaultBranch = git.branch || 'main';

    this.db
      .prepare(
        `INSERT INTO projects (
          id, name, root_path, git_common_dir, default_branch, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        projectName,
        git.repoRoot,
        git.gitCommonDir,
        defaultBranch,
        now,
        now,
      );

    const created = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as ProjectRow;

    return {
      project: this.mapProject(created),
      git,
    };
  }

  getProject(projectId: string): Project | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as ProjectRow | undefined;
    return row ? this.mapProject(row) : null;
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as ProjectRow[];
    return rows.map((r) => this.mapProject(r));
  }

  getHandoff(projectId: string, branch: string, worktreePath = ''): BranchHandoff {
    const row = this.db
      .prepare('SELECT * FROM handoffs WHERE project_id = ? AND branch = ?')
      .get(projectId, branch) as HandoffRow | undefined;

    if (row) {
      return this.mapHandoff(row);
    }

    return {
      id: `hoff_${projectId.slice(5, 11)}_${branch.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 16)}`,
      projectId,
      branch,
      worktreePath,
      objective: '',
      summary: '',
      activeHypothesis: '',
      tasks: [],
      blockers: [],
      nextSteps: [],
      activeFiles: [],
      headSha: null,
      dirtySignature: null,
      lastIde: 'cli',
      updatedAt: new Date().toISOString(),
    };
  }

  listHandoffs(projectId: string): BranchHandoff[] {
    const rows = this.db
      .prepare('SELECT * FROM handoffs WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as HandoffRow[];
    return rows.map((r) => this.mapHandoff(r));
  }

  saveCheckpoint(input: CheckpointInput): {
    project: Project;
    git: GitRepoState;
    handoff: BranchHandoff;
    switchedFromIde: SourceIde | null;
  } {
    const { project, git } = this.ensureProject(input.projectPath ?? process.cwd());
    const branch = input.branch ?? git.branch;
    const sourceIde: SourceIde = input.sourceIde ?? 'cli';

    const existingRow = this.db
      .prepare('SELECT * FROM handoffs WHERE project_id = ? AND branch = ?')
      .get(project.id, branch) as HandoffRow | undefined;

    const existing = existingRow ? this.mapHandoff(existingRow) : null;
    const now = new Date().toISOString();

    let tasks: TaskStep[] = existing?.tasks ?? [];
    if (input.tasks !== undefined) {
      const normalizedIncoming: TaskStep[] = input.tasks.map((t, idx) => ({
        id: t.id || `task_${idx + 1}_${createHash('sha1').update(t.text).digest('hex').slice(0, 6)}`,
        text: t.text.trim(),
        status: t.status,
        files: t.files
          ? uniqueCleanStrings(t.files.map((f) => normalizeRelPath(git.repoRoot, f)))
          : undefined,
      }));

      if (input.mergeTasks && existing) {
        const byText = new Map<string, TaskStep>();
        for (const oldTask of existing.tasks) {
          byText.set(oldTask.text.toLowerCase(), oldTask);
        }
        for (const inc of normalizedIncoming) {
          const prev = byText.get(inc.text.toLowerCase());
          byText.set(inc.text.toLowerCase(), prev ? { ...prev, ...inc, id: prev.id } : inc);
        }
        tasks = Array.from(byText.values());
      } else {
        tasks = normalizedIncoming;
      }
    }

    const autoDirtyFiles = git.dirtyFiles.slice(0, 15).map((d) => d.path);
    const activeFiles =
      input.activeFiles !== undefined
        ? uniqueCleanStrings(
            input.activeFiles.map((f) => normalizeRelPath(git.repoRoot, f)),
          )
        : existing && existing.activeFiles.length > 0
          ? uniqueCleanStrings([...autoDirtyFiles, ...existing.activeFiles]).slice(0, 20)
          : autoDirtyFiles;

    const objective =
      input.objective !== undefined ? input.objective.trim() : (existing?.objective ?? '');
    const summary =
      input.summary !== undefined ? input.summary.trim() : (existing?.summary ?? '');
    const activeHypothesis =
      input.activeHypothesis !== undefined
        ? input.activeHypothesis.trim()
        : (existing?.activeHypothesis ?? '');
    const blockers =
      input.blockers !== undefined
        ? uniqueCleanStrings(input.blockers)
        : (existing?.blockers ?? []);
    const nextSteps =
      input.nextSteps !== undefined
        ? uniqueCleanStrings(input.nextSteps)
        : (existing?.nextSteps ?? []);

    const id = existing?.id ?? shortId('hoff');

    let switchedFromIde: SourceIde | null = null;
    const realIdes = new Set<SourceIde>(['cursor', 'claude-code', 'windsurf', 'codex']);
    if (
      existing &&
      existing.lastIde !== sourceIde &&
      realIdes.has(existing.lastIde) &&
      realIdes.has(sourceIde)
    ) {
      switchedFromIde = existing.lastIde;
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO handoffs (
            id, project_id, branch, worktree_path, objective, summary, active_hypothesis,
            tasks_json, blockers_json, next_steps_json, active_files_json,
            head_sha, dirty_signature, last_ide, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, branch) DO UPDATE SET
            worktree_path = excluded.worktree_path,
            objective = excluded.objective,
            summary = excluded.summary,
            active_hypothesis = excluded.active_hypothesis,
            tasks_json = excluded.tasks_json,
            blockers_json = excluded.blockers_json,
            next_steps_json = excluded.next_steps_json,
            active_files_json = excluded.active_files_json,
            head_sha = excluded.head_sha,
            dirty_signature = excluded.dirty_signature,
            last_ide = excluded.last_ide,
            updated_at = excluded.updated_at`,
        )
        .run(
          id,
          project.id,
          branch,
          git.repoRoot,
          objective,
          summary,
          activeHypothesis,
          JSON.stringify(tasks),
          JSON.stringify(blockers),
          JSON.stringify(nextSteps),
          JSON.stringify(activeFiles),
          git.headSha,
          git.dirtySignature,
          sourceIde,
          now,
        );

      if (switchedFromIde) {
        this.insertTimelineEvent({
          projectId: project.id,
          branch,
          sourceIde,
          eventType: 'ide_switch',
          summary: `Switched active environment from ${switchedFromIde} to ${sourceIde}`,
          metadata: { from: switchedFromIde, to: sourceIde, objective },
        });
      }

      this.insertTimelineEvent({
        projectId: project.id,
        branch,
        sourceIde,
        eventType: 'checkpoint',
        summary: objective
          ? `Checkpoint saved: ${objective}`
          : summary
            ? `Checkpoint saved: ${deriveSummary(summary, 90)}`
            : `Updated handoff capsule on ${branch}`,
        metadata: {
          tasksCount: tasks.length,
          blockersCount: blockers.length,
          nextStepsCount: nextSteps.length,
          headSha: git.shortSha,
        },
      });
    });

    tx();

    const saved = this.getHandoff(project.id, branch, git.repoRoot);
    return { project, git, handoff: saved, switchedFromIde };
  }

  updateTaskStatus(
    projectId: string,
    branch: string,
    taskIdOrQuery: string,
    status: TaskStatus,
    sourceIde: SourceIde = 'cli',
  ): BranchHandoff | null {
    const row = this.db
      .prepare('SELECT * FROM handoffs WHERE project_id = ? AND branch = ?')
      .get(projectId, branch) as HandoffRow | undefined;
    if (!row) return null;

    const handoff = this.mapHandoff(row);
    const needle = taskIdOrQuery.trim().toLowerCase();
    let matched = false;

    const updatedTasks = handoff.tasks.map((t) => {
      if (
        !matched &&
        (t.id.toLowerCase() === needle || t.text.toLowerCase().includes(needle))
      ) {
        matched = true;
        return { ...t, status };
      }
      return t;
    });

    if (!matched) return null;

    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE handoffs SET tasks_json = ?, last_ide = ?, updated_at = ? WHERE id = ?',
      )
      .run(JSON.stringify(updatedTasks), sourceIde, now, handoff.id);

    return this.getHandoff(projectId, branch, handoff.worktreePath);
  }

  recordMemory(input: RecordMemoryInput): MemoryWithDrift {
    const { project, git } = this.ensureProject(input.projectPath ?? process.cwd());
    const now = new Date().toISOString();
    const sourceIde: SourceIde = input.sourceIde ?? 'cli';
    const title = input.title.trim();
    const body = input.body.trim();
    const summary = (input.summary?.trim() || deriveSummary(body, 180)).trim();

    const tags = uniqueCleanStrings(input.tags?.map((t) => t.toLowerCase()));
    const relatedFiles = uniqueCleanStrings(
      input.relatedFiles?.map((f) => normalizeRelPath(git.repoRoot, f)),
    );
    const sourceUrls = uniqueCleanStrings(input.sourceUrls);
    const branch = input.branch === undefined ? git.branch : input.branch;
    const pinned = Boolean(input.pinned);

    const embedding = embeddingToBlob(
      computeLocalEmbedding(title, summary, body, tags, relatedFiles),
    );

    // Check if an active memory with exact same (project_id, kind, lower(title)) already exists
    const duplicate = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE project_id = ? AND kind = ? AND status = 'active' AND lower(title) = lower(?)
         LIMIT 1`,
      )
      .get(project.id, input.kind, title) as MemoryRow | undefined;

    let memoryId = duplicate ? duplicate.id : shortId('mem');

    const tx = this.db.transaction(() => {
      if (duplicate) {
        const mergedTags = uniqueCleanStrings([
          ...parseJsonArray<string>(duplicate.tags_json),
          ...tags,
        ]);
        const mergedFiles = uniqueCleanStrings([
          ...parseJsonArray<string>(duplicate.related_files_json),
          ...relatedFiles,
        ]);
        const mergedUrls = uniqueCleanStrings([
          ...parseJsonArray<string>(duplicate.source_urls_json),
          ...sourceUrls,
        ]);
        const updatedEmbedding = embeddingToBlob(
          computeLocalEmbedding(title, summary, body, mergedTags, mergedFiles),
        );

        this.db
          .prepare(
            `UPDATE memories SET
              branch = ?,
              summary = ?,
              body = ?,
              tags_json = ?,
              related_files_json = ?,
              source_urls_json = ?,
              anchor_commit = ?,
              source_ide = ?,
              pinned = ?,
              embedding = ?,
              updated_at = ?
             WHERE id = ?`,
          )
          .run(
            branch,
            summary,
            body,
            JSON.stringify(mergedTags),
            JSON.stringify(mergedFiles),
            JSON.stringify(mergedUrls),
            git.headSha,
            sourceIde,
            pinned ? 1 : duplicate.pinned,
            updatedEmbedding,
            now,
            duplicate.id,
          );

        this.insertTimelineEvent({
          projectId: project.id,
          branch,
          sourceIde,
          eventType: 'memory_updated',
          summary: `Updated ${input.kind}: ${title}`,
          metadata: { memoryId: duplicate.id, kind: input.kind },
        });
      } else {
        this.db
          .prepare(
            `INSERT INTO memories (
              id, project_id, branch, kind, title, summary, body,
              tags_json, related_files_json, source_urls_json,
              anchor_commit, source_ide, status, superseded_by, pinned,
              embedding, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?)`,
          )
          .run(
            memoryId,
            project.id,
            branch,
            input.kind,
            title,
            summary,
            body,
            JSON.stringify(tags),
            JSON.stringify(relatedFiles),
            JSON.stringify(sourceUrls),
            git.headSha,
            sourceIde,
            pinned ? 1 : 0,
            embedding,
            now,
            now,
          );

        if (input.supersedesId) {
          this.db
            .prepare(
              `UPDATE memories
               SET status = 'superseded', superseded_by = ?, updated_at = ?
               WHERE id = ? AND project_id = ?`,
            )
            .run(memoryId, now, input.supersedesId, project.id);
        }

        this.insertTimelineEvent({
          projectId: project.id,
          branch,
          sourceIde,
          eventType: 'memory_recorded',
          summary: `Recorded ${input.kind}: ${title}`,
          metadata: {
            memoryId,
            kind: input.kind,
            tags,
            relatedFiles,
            supersedesId: input.supersedesId ?? null,
          },
        });
      }
    });

    tx();

    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(memoryId) as MemoryRow;
    const inspector = new GitDriftInspector(git);
    return this.attachDrift(this.mapMemory(row), inspector);
  }

  getMemory(memoryId: string, projectPath?: string): MemoryWithDrift | null {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(memoryId) as MemoryRow | undefined;
    if (!row) return null;

    const project = this.getProject(row.project_id);
    const git = inspectGitRepo(projectPath ?? project?.rootPath ?? process.cwd());
    const inspector = new GitDriftInspector(git);
    return this.attachDrift(this.mapMemory(row), inspector);
  }

  updateMemory(
    memoryId: string,
    patch: Partial<{
      title: string;
      summary: string;
      body: string;
      kind: MemoryKind;
      tags: string[];
      relatedFiles: string[];
      sourceUrls: string[];
      pinned: boolean;
      status: MemoryStatus;
      reanchorCommit: boolean;
    }>,
    projectPath?: string,
  ): MemoryWithDrift | null {
    const existingRow = this.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(memoryId) as MemoryRow | undefined;
    if (!existingRow) return null;

    const project = this.getProject(existingRow.project_id);
    const git = inspectGitRepo(projectPath ?? project?.rootPath ?? process.cwd());
    const existing = this.mapMemory(existingRow);

    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    const body = patch.body !== undefined ? patch.body.trim() : existing.body;
    const summary =
      patch.summary !== undefined
        ? patch.summary.trim()
        : patch.body !== undefined
          ? deriveSummary(body, 180)
          : existing.summary;
    const kind = patch.kind ?? existing.kind;
    const tags =
      patch.tags !== undefined
        ? uniqueCleanStrings(patch.tags.map((t) => t.toLowerCase()))
        : existing.tags;
    const relatedFiles =
      patch.relatedFiles !== undefined
        ? uniqueCleanStrings(
            patch.relatedFiles.map((f) => normalizeRelPath(git.repoRoot, f)),
          )
        : existing.relatedFiles;
    const sourceUrls =
      patch.sourceUrls !== undefined
        ? uniqueCleanStrings(patch.sourceUrls)
        : existing.sourceUrls;
    const pinned = patch.pinned !== undefined ? patch.pinned : existing.pinned;
    const status = patch.status ?? existing.status;
    const anchorCommit = patch.reanchorCommit ? git.headSha : existing.anchorCommit;

    const embedding = embeddingToBlob(
      computeLocalEmbedding(title, summary, body, tags, relatedFiles),
    );
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE memories SET
          kind = ?, title = ?, summary = ?, body = ?,
          tags_json = ?, related_files_json = ?, source_urls_json = ?,
          anchor_commit = ?, status = ?, pinned = ?, embedding = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        kind,
        title,
        summary,
        body,
        JSON.stringify(tags),
        JSON.stringify(relatedFiles),
        JSON.stringify(sourceUrls),
        anchorCommit,
        status,
        pinned ? 1 : 0,
        embedding,
        now,
        memoryId,
      );

    return this.getMemory(memoryId, git.repoRoot);
  }

  deleteMemory(memoryId: string): boolean {
    const res = this.db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
    return res.changes > 0;
  }

  listMemories(options: {
    projectId: string;
    kinds?: MemoryKind[];
    status?: MemoryStatus | 'all';
    branch?: string;
    pinnedOnly?: boolean;
    limit?: number;
    projectPath?: string;
  }): MemoryWithDrift[] {
    const clauses: string[] = ['project_id = ?'];
    const params: unknown[] = [options.projectId];

    const status = options.status ?? 'active';
    if (status !== 'all') {
      clauses.push('status = ?');
      params.push(status);
    }

    if (options.kinds && options.kinds.length > 0) {
      clauses.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
      params.push(...options.kinds);
    }

    if (options.branch) {
      clauses.push('(branch IS NULL OR branch = ?)');
      params.push(options.branch);
    }

    if (options.pinnedOnly) {
      clauses.push('pinned = 1');
    }

    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    params.push(limit);

    const sql = `
      SELECT * FROM memories
      WHERE ${clauses.join(' AND ')}
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    const project = this.getProject(options.projectId);
    const git = inspectGitRepo(options.projectPath ?? project?.rootPath ?? process.cwd());
    const inspector = new GitDriftInspector(git);

    return rows.map((r) => this.attachDrift(this.mapMemory(r), inspector));
  }

  searchMemories(options: SearchOptions & { projectPath?: string }): SearchResult[] {
    const limit = Math.max(1, Math.min(50, options.limit ?? 10));
    const project = this.getProject(options.projectId);
    const git = inspectGitRepo(options.projectPath ?? project?.rootPath ?? process.cwd());
    const inspector = new GitDriftInspector(git);

    const trimmedQuery = options.query.trim();
    if (!trimmedQuery) {
      return this.listMemories({
        projectId: options.projectId,
        kinds: options.kinds,
        status: options.includeArchived ? 'all' : 'active',
        limit,
        projectPath: git.repoRoot,
      }).map((m) => ({
        ...m,
        score: 1,
        bm25Score: 0,
        semanticScore: 0,
        recencyScore: computeRecencyScore(m.updatedAt),
        contextBoost: 0,
        snippet: buildSearchSnippet(m.body, m.summary, '', 200),
      }));
    }

    // 1. FTS5 BM25 lexical candidates
    const ftsQuery = buildFtsQuery(trimmedQuery);
    const bm25ById = new Map<string, number>();

    if (ftsQuery) {
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT
              memory_id,
              bm25(memories_fts, 0.0, 0.0, 3.5, 2.0, 1.0, 2.5, 2.0) AS raw_bm25
             FROM memories_fts
             WHERE memories_fts MATCH ? AND project_id = ?
             ORDER BY raw_bm25 ASC
             LIMIT 100`,
          )
          .all(ftsQuery, options.projectId) as Array<{
          memory_id: string;
          raw_bm25: number;
        }>;

        for (const r of ftsRows) {
          // SQLite bm25() returns negative numbers where more negative = better match
          const positive = Math.abs(r.raw_bm25);
          const normalized = positive / (1 + positive);
          bm25ById.set(r.memory_id, normalized);
        }
      } catch {
        // Fallback smoothly to local vector + substring scoring if FTS query had unusual tokens
      }
    }

    // 2. Load candidate memories in project for hybrid semantic + contextual reranking
    const filterClauses: string[] = ['project_id = ?'];
    const filterParams: unknown[] = [options.projectId];

    if (!options.includeArchived) {
      filterClauses.push("status = 'active'");
    }
    if (options.kinds && options.kinds.length > 0) {
      filterClauses.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
      filterParams.push(...options.kinds);
    }

    const candidates = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${filterClauses.join(' AND ')} ORDER BY updated_at DESC LIMIT 500`,
      )
      .all(...filterParams) as MemoryRow[];

    const queryVec = computeLocalEmbedding(trimmedQuery, '', '', [], []);
    const activeFileSet = new Set(
      (options.activeFiles ?? git.dirtyFiles.map((d) => d.path)).map((f) =>
        normalizeRelPath(git.repoRoot, f),
      ),
    );
    const requiredTags = new Set(
      (options.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    );
    const lowerQuery = trimmedQuery.toLowerCase();

    const scored: SearchResult[] = [];

    for (const row of candidates) {
      const entry = this.mapMemory(row);
      if (requiredTags.size > 0) {
        const entryTagSet = new Set(entry.tags.map((t) => t.toLowerCase()));
        let hasAll = true;
        for (const reqTag of requiredTags) {
          if (!entryTagSet.has(reqTag)) {
            hasAll = false;
            break;
          }
        }
        if (!hasAll) continue;
      }

      const bm25Score = bm25ById.get(entry.id) ?? 0;
      const docVec = blobToEmbedding(row.embedding);
      const semanticScore = cosineSimilarity(queryVec, docVec);
      const exactSubstr =
        entry.title.toLowerCase().includes(lowerQuery) ||
        entry.relatedFiles.some((f) => f.toLowerCase().includes(lowerQuery))
          ? 0.25
          : 0;

      // Require meaningful lexical or semantic signal
      if (bm25Score === 0 && semanticScore < 0.14 && exactSubstr === 0) {
        continue;
      }

      const recencyScore = computeRecencyScore(entry.updatedAt);

      let contextBoost = exactSubstr;
      if (entry.pinned) contextBoost += 0.08;
      if (options.branch && entry.branch === options.branch) contextBoost += 0.05;
      if (
        activeFileSet.size > 0 &&
        entry.relatedFiles.some((f) => activeFileSet.has(f))
      ) {
        contextBoost += 0.12;
      }
      if (entry.kind === 'dead_end') {
        contextBoost += 0.04;
      }

      const finalScore =
        bm25Score * 0.52 +
        semanticScore * 0.33 +
        recencyScore * 0.08 +
        contextBoost;

      const withDrift = this.attachDrift(entry, inspector);
      scored.push({
        ...withDrift,
        score: Number(finalScore.toFixed(4)),
        bm25Score: Number(bm25Score.toFixed(4)),
        semanticScore: Number(semanticScore.toFixed(4)),
        recencyScore: Number(recencyScore.toFixed(4)),
        contextBoost: Number(contextBoost.toFixed(4)),
        snippet: buildSearchSnippet(entry.body, entry.summary, trimmedQuery, 220),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  insertTimelineEvent(input: {
    projectId: string;
    branch: string | null;
    sourceIde: SourceIde;
    eventType: TimelineEventType;
    summary: string;
    metadata?: Record<string, unknown>;
  }): TimelineEvent {
    const id = shortId('evt');
    const now = new Date().toISOString();
    const metadata = input.metadata ?? {};

    this.db
      .prepare(
        `INSERT INTO timeline_events (
          id, project_id, branch, source_ide, event_type, summary, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.branch,
        input.sourceIde,
        input.eventType,
        input.summary,
        JSON.stringify(metadata),
        now,
      );

    return {
      id,
      projectId: input.projectId,
      branch: input.branch,
      sourceIde: input.sourceIde,
      eventType: input.eventType,
      summary: input.summary,
      metadata,
      createdAt: now,
    };
  }

  listTimeline(projectId: string, limit = 40): TimelineEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM timeline_events
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectId, Math.max(1, Math.min(200, limit))) as TimelineRow[];

    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      branch: r.branch,
      sourceIde: r.source_ide,
      eventType: r.event_type,
      summary: r.summary,
      metadata: (() => {
        try {
          return JSON.parse(r.metadata_json) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
      createdAt: r.created_at,
    }));
  }

  getHarvesterCursor(projectId: string, source: string): string | null {
    const row = this.db
      .prepare(
        'SELECT cursor_value FROM harvester_cursors WHERE project_id = ? AND source = ?',
      )
      .get(projectId, source) as { cursor_value: string } | undefined;
    return row?.cursor_value ?? null;
  }

  setHarvesterCursor(projectId: string, source: string, cursorValue: string): void {
    const id = shortId('cur');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO harvester_cursors (id, project_id, source, cursor_value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, source) DO UPDATE SET
           cursor_value = excluded.cursor_value,
           updated_at = excluded.updated_at`,
      )
      .run(id, projectId, source, cursorValue, now);
  }

  getProjectStats(projectId: string, projectPath?: string): {
    totalMemories: number;
    byKind: Record<MemoryKind, number>;
    driftedCount: number;
    branchesCount: number;
    eventsCount: number;
    byIde: Record<string, number>;
  } {
    const activeMemories = this.listMemories({
      projectId,
      status: 'active',
      limit: 200,
      projectPath,
    });

    const byKind: Record<MemoryKind, number> = {
      decision: 0,
      dead_end: 0,
      research: 0,
      convention: 0,
      note: 0,
    };
    const byIde: Record<string, number> = {};
    let driftedCount = 0;

    for (const m of activeMemories) {
      byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
      byIde[m.sourceIde] = (byIde[m.sourceIde] ?? 0) + 1;
      if (m.drift.drifted) driftedCount++;
    }

    const branchesCount =
      (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM handoffs WHERE project_id = ?')
          .get(projectId) as { c: number }
      )?.c ?? 0;

    const eventsCount =
      (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM timeline_events WHERE project_id = ?')
          .get(projectId) as { c: number }
      )?.c ?? 0;

    return {
      totalMemories: activeMemories.length,
      byKind,
      driftedCount,
      branchesCount,
      eventsCount,
      byIde,
    };
  }

  private attachDrift(entry: MemoryEntry, inspector: GitDriftInspector): MemoryWithDrift {
    return {
      ...entry,
      drift: inspector.checkDrift(entry.anchorCommit, entry.relatedFiles),
    };
  }

  private mapProject(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      gitCommonDir: row.git_common_dir,
      defaultBranch: row.default_branch,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapHandoff(row: HandoffRow): BranchHandoff {
    return {
      id: row.id,
      projectId: row.project_id,
      branch: row.branch,
      worktreePath: row.worktree_path,
      objective: row.objective,
      summary: row.summary,
      activeHypothesis: row.active_hypothesis,
      tasks: parseJsonArray<TaskStep>(row.tasks_json),
      blockers: parseJsonArray<string>(row.blockers_json),
      nextSteps: parseJsonArray<string>(row.next_steps_json),
      activeFiles: parseJsonArray<string>(row.active_files_json),
      headSha: row.head_sha,
      dirtySignature: row.dirty_signature,
      lastIde: row.last_ide,
      updatedAt: row.updated_at,
    };
  }

  private mapMemory(row: MemoryRow): MemoryEntry {
    return {
      id: row.id,
      projectId: row.project_id,
      branch: row.branch,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      body: row.body,
      tags: parseJsonArray<string>(row.tags_json),
      relatedFiles: parseJsonArray<string>(row.related_files_json),
      sourceUrls: parseJsonArray<string>(row.source_urls_json),
      anchorCommit: row.anchor_commit,
      sourceIde: row.source_ide,
      status: row.status,
      supersededBy: row.superseded_by,
      pinned: Boolean(row.pinned),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
