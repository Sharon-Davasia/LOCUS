import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocusEngine } from '../src/core/engine.js';
import { estimateTokens, truncateToTokens } from '../src/core/tokens.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('Phase 1 — Locus Core Memory Engine, Hybrid Search & Git Drift', () => {
  let tmpDir: string;
  let repoDir: string;
  let dbPath: string;
  let engine: LocusEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locus-phase1-'));
    repoDir = path.join(tmpDir, 'sample-repo');
    dbPath = path.join(tmpDir, 'locus.db');

    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'dev@locus.local']);
    git(repoDir, ['config', 'user.name', 'Locus Tester']);

    fs.writeFileSync(
      path.join(repoDir, 'src', 'transport.ts'),
      'export class TransportManager {\n  connect() { return true; }\n}\n',
    );
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'Initial transport module']);

    engine = new LocusEngine(dbPath);
  });

  afterEach(() => {
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers projects deterministically and shares identity across git worktrees', () => {
    const { project: p1 } = engine.ensureProject(repoDir);
    expect(p1.name).toBe('sample-repo');

    const worktreeDir = path.join(tmpDir, 'wt-feature');
    git(repoDir, ['worktree', 'add', '-b', 'feat/webrtc', worktreeDir]);

    const { project: p2, git: wtGit } = engine.ensureProject(worktreeDir);
    expect(p2.id).toBe(p1.id);
    expect(wtGit.branch).toBe('feat/webrtc');
  });

  it('maintains branch-scoped handoff capsules and logs cross-IDE switches', () => {
    const first = engine.saveCheckpoint({
      projectPath: repoDir,
      objective: 'Implement jittered exponential backoff in TransportManager',
      summary: 'Prototyped retry state machine in Cursor; ready for multi-file refactor.',
      activeHypothesis: 'Decorrelated jitter avoids reconnect storms.',
      tasks: [
        { text: 'Design retry state machine', status: 'done', files: ['src/transport.ts'] },
        { text: 'Wire cancellation AbortSignal', status: 'in_progress' },
      ],
      nextSteps: ['Add unit tests for maxRetries exhaustion'],
      sourceIde: 'cursor',
    });

    expect(first.switchedFromIde).toBeNull();
    expect(first.handoff.branch).toBe('main');
    expect(first.handoff.tasks).toHaveLength(2);

    // Switch to Claude Code on the same branch and merge task update
    const second = engine.saveCheckpoint({
      projectPath: repoDir,
      tasks: [{ text: 'Wire cancellation AbortSignal', status: 'done' }],
      mergeTasks: true,
      sourceIde: 'claude-code',
    });

    expect(second.switchedFromIde).toBe('cursor');
    expect(second.handoff.lastIde).toBe('claude-code');
    expect(
      second.handoff.tasks.find((t) => t.text.includes('AbortSignal'))?.status,
    ).toBe('done');

    const timeline = engine.listTimeline(second.project.id);
    expect(timeline.some((e) => e.eventType === 'ide_switch')).toBe(true);

    // Checkout a different branch — handoff capsule is isolated per branch
    git(repoDir, ['checkout', '-b', 'feat/metrics']);
    const { git: metricsGit } = engine.ensureProject(repoDir);
    const metricsHandoff = engine.getHandoff(second.project.id, metricsGit.branch, repoDir);
    expect(metricsHandoff.objective).toBe('');
  });

  it('records memories, handles superseding decisions, and ranks via hybrid search', () => {
    const { project } = engine.ensureProject(repoDir);

    const oldDecision = engine.recordMemory({
      projectPath: repoDir,
      kind: 'decision',
      title: 'Use native EventSource for streaming',
      body: 'Initially selected browser EventSource API for server-to-client updates.',
      tags: ['transport', 'streaming'],
      sourceIde: 'cursor',
    });

    const newDecision = engine.recordMemory({
      projectPath: repoDir,
      kind: 'decision',
      title: 'Switch streaming transport from EventSource to fetch ReadableStream',
      body: 'EventSource cannot send custom Authorization headers without query tokens; fetch + eventsource-parser solves auth cleanly.',
      tags: ['transport', 'auth', 'streaming'],
      relatedFiles: ['src/transport.ts'],
      supersedesId: oldDecision.id,
      sourceIde: 'claude-code',
    });

    engine.recordMemory({
      projectPath: repoDir,
      kind: 'dead_end',
      title: 'foo-rtc crashes on Node 22 native N-API binding',
      body: 'Attempted foo-rtc@2.4.1; segfaults on Node 22.22 V8 isolate teardown. Do not re-introduce.',
      tags: ['webrtc', 'node22'],
      relatedFiles: ['src/transport.ts'],
      sourceIde: 'cursor',
    });

    engine.recordMemory({
      projectPath: repoDir,
      kind: 'research',
      title: 'AWS Architecture Blog — Exponential Backoff And Jitter Benchmarks',
      body: 'Full jitter and decorrelated jitter cut competing client calls by 68% under contention compared to plain exponential backoff.',
      tags: ['backoff', 'benchmarks'],
      sourceUrls: ['https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/'],
      sourceIde: 'cursor',
    });

    // Old decision should now be marked superseded and excluded from active search
    const oldReloaded = engine.getMemory(oldDecision.id, repoDir);
    expect(oldReloaded?.status).toBe('superseded');
    expect(oldReloaded?.supersededBy).toBe(newDecision.id);

    // Search with file paths & punctuation (verifies FTS5 query sanitizer + file boost)
    const authHits = engine.searchMemories({
      projectId: project.id,
      query: 'Authorization headers in src/transport.ts ReadableStream',
      projectPath: repoDir,
    });
    expect(authHits.length).toBeGreaterThan(0);
    expect(authHits[0].id).toBe(newDecision.id);

    // Search for dead end
    const crashHits = engine.searchMemories({
      projectId: project.id,
      query: 'Node 22 native binding crash segfault',
      kinds: ['dead_end'],
      projectPath: repoDir,
    });
    expect(crashHits).toHaveLength(1);
    expect(crashHits[0].title).toContain('foo-rtc');
  });

  it('detects git drift when referenced files are modified or deleted after anchor commit', () => {
    const mem = engine.recordMemory({
      projectPath: repoDir,
      kind: 'research',
      title: 'TransportManager connection lifecycle invariants',
      body: 'connect() is synchronous right now and assumes pre-validated config.',
      relatedFiles: ['src/transport.ts'],
      sourceIde: 'cursor',
    });

    expect(mem.drift.drifted).toBe(false);

    // Modify src/transport.ts in working tree
    fs.writeFileSync(
      path.join(repoDir, 'src', 'transport.ts'),
      'export class TransportManager {\n  async connect() { return true; }\n}\n',
    );

    const dirtyLoaded = engine.getMemory(mem.id, repoDir)!;
    expect(dirtyLoaded.drift.drifted).toBe(true);
    expect(dirtyLoaded.drift.changedFiles).toContain('src/transport.ts');

    // Commit the change -> still drifted relative to mem.anchorCommit!
    git(repoDir, ['add', 'src/transport.ts']);
    git(repoDir, ['commit', '-m', 'Make connect async']);

    const committedLoaded = engine.getMemory(mem.id, repoDir)!;
    expect(committedLoaded.drift.drifted).toBe(true);
    expect(committedLoaded.drift.changedFiles).toContain('src/transport.ts');

    // Re-anchor memory after verifying it
    const reanchored = engine.updateMemory(mem.id, { reanchorCommit: true }, repoDir)!;
    expect(reanchored.drift.drifted).toBe(false);
  });

  it('estimates tokens and truncates cleanly within token budgets', () => {
    const longText = Array.from(
      { length: 40 },
      (_, i) => `- Step ${i + 1}: Refactor src/components/WorkspaceBridgeAdapter.ts`,
    ).join('\n');

    expect(estimateTokens(longText)).toBeGreaterThan(200);
    const truncated = truncateToTokens(longText, 75);
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(85);
    expect(truncated).toContain('…');
  });
});
