import { writeIdeBridges, type BridgeWriteResult } from '../adapters.js';
import type { LocusEngine } from '../../core/engine.js';
import { deriveSummary } from '../../core/tokens.js';
import {
  harvestClaudeCodeSession,
  type HarvestedSessionSummary,
} from './claude-harvester.js';
import { harvestCursorSession } from './cursor-harvester.js';

export interface SyncOptions {
  projectPath?: string;
  claudeProjectsDir?: string;
  cursorUserDir?: string;
  writeBridges?: boolean;
}

export interface SyncResult {
  projectId: string;
  branch: string;
  harvested: HarvestedSessionSummary[];
  bridges: BridgeWriteResult | null;
}

export function syncProjectState(
  engine: LocusEngine,
  options: SyncOptions = {},
): SyncResult {
  const { project, git } = engine.ensureProject(options.projectPath ?? process.cwd());
  const existingHandoff = engine.getHandoff(project.id, git.branch, git.repoRoot);

  const claudeCursor = engine.getHarvesterCursor(project.id, 'claude-code');
  const cursorCursor = engine.getHarvesterCursor(project.id, 'cursor');

  const harvested: HarvestedSessionSummary[] = [];

  const claudeSession = harvestClaudeCodeSession({
    repoRoot: git.repoRoot,
    claudeProjectsDir: options.claudeProjectsDir,
    lastCursor: claudeCursor,
  });
  if (claudeSession) harvested.push(claudeSession);

  const cursorSession = harvestCursorSession({
    repoRoot: git.repoRoot,
    cursorUserDir: options.cursorUserDir,
    lastCursor: cursorCursor,
  });
  if (cursorSession) harvested.push(cursorSession);

  // Apply in chronological order so the most recent IDE wins `lastIde`
  harvested.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));

  for (const session of harvested) {
    const current = engine.getHandoff(project.id, git.branch, git.repoRoot);

    const nextObjective =
      current.objective || deriveSummary(session.latestUserPrompt, 160);
    const nextSummary = session.latestAssistantSummary
      ? deriveSummary(session.latestAssistantSummary, 220)
      : current.summary;

    const mergedFiles = Array.from(
      new Set([
        ...session.touchedFiles,
        ...git.dirtyFiles.map((d) => d.path),
        ...current.activeFiles,
      ]),
    ).slice(0, 20);

    const mergedBlockers =
      session.errors.length > 0
        ? Array.from(new Set([...current.blockers, ...session.errors])).slice(0, 5)
        : current.blockers;

    engine.saveCheckpoint({
      projectPath: git.repoRoot,
      branch: git.branch,
      objective: nextObjective,
      summary: nextSummary,
      activeFiles: mergedFiles,
      blockers: mergedBlockers,
      sourceIde: session.sourceIde,
    });

    engine.insertTimelineEvent({
      projectId: project.id,
      branch: git.branch,
      sourceIde: session.sourceIde,
      eventType: 'session_harvested',
      summary: `Harvested ${session.sourceIde} session (${session.touchedFiles.length} file(s) touched)`,
      metadata: {
        sessionId: session.sessionId,
        latestUserPrompt: deriveSummary(session.latestUserPrompt, 120),
        touchedFiles: session.touchedFiles,
      },
    });

    engine.setHarvesterCursor(project.id, session.sourceIde, session.cursorToken);
  }

  // If no IDE session was harvested, still ensure git dirty signature is reflected when changed
  if (
    harvested.length === 0 &&
    existingHandoff.dirtySignature !== git.dirtySignature &&
    (existingHandoff.objective || git.dirtyFiles.length > 0)
  ) {
    engine.db
      .prepare(
        `UPDATE handoffs
         SET head_sha = ?, dirty_signature = ?, updated_at = ?
         WHERE project_id = ? AND branch = ?`,
      )
      .run(
        git.headSha,
        git.dirtySignature,
        new Date().toISOString(),
        project.id,
        git.branch,
      );
  }

  const shouldWrite = options.writeBridges ?? true;
  const bridges = shouldWrite
    ? writeIdeBridges(engine, { projectPath: git.repoRoot })
    : null;

  return {
    projectId: project.id,
    branch: git.branch,
    harvested,
    bridges,
  };
}
