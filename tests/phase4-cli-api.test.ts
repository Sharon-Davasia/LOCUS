import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliProgram } from '../src/cli/index.js';
import { createLocusHttpApp } from '../src/server/app.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('Phase 4 — Locus CLI & Mission Control HTTP API End-to-End', () => {
  let tmpDir: string;
  let repoDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locus-phase4-'));
    repoDir = path.join(tmpDir, 'nebula-sdk');
    dbPath = path.join(tmpDir, 'locus.db');

    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'dev@locus.local']);
    git(repoDir, ['config', 'user.name', 'Locus Tester']);
    fs.writeFileSync(path.join(repoDir, 'src', 'client.ts'), 'export class Client {}\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'Initial SDK commit']);

    repoDir = fs.realpathSync.native(repoDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs CLI commands (init, dead-end, decide, research, checkpoint, hook, status)', async () => {
    const runCli = async (args: string[]) => {
      const cli = createCliProgram({ dbPath });
      await cli.parseAsync(['node', 'locus', ...args]);
    };

    await runCli(['init', '--project', repoDir]);
    expect(fs.existsSync(path.join(repoDir, '.locus', 'HANDOFF.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(repoDir, '.cursor', 'rules', 'locus-handoff.mdc')),
    ).toBe(true);

    await runCli([
      'dead-end',
      'undici v5 interceptor API removed in v6',
      'Do not use compose(interceptors.retry()) from v5; use Agent retry dispatcher in v6.',
      '--project',
      repoDir,
      '--files',
      'src/client.ts',
      '--ide',
      'cursor',
    ]);

    await runCli([
      'decide',
      'Expose async iterable pagination on list endpoints',
      'Matches ergonomic Node 22 Symbol.asyncIterator streaming pattern.',
      '--project',
      repoDir,
      '--tags',
      'api,ergonomics',
      '--ide',
      'cursor',
    ]);

    await runCli([
      'checkpoint',
      '--project',
      repoDir,
      '--objective',
      'Implement async iterator pagination in NebulaClient',
      '--doing',
      'Wire cursor page token loop',
      '--todo',
      'Write retry integration tests',
      '--ide',
      'claude-code',
    ]);

    // Claude Code stop hook must never throw and must keep bridges synced
    await runCli(['hook', 'stop', '--project', repoDir]);

    const handoffMd = fs.readFileSync(
      path.join(repoDir, '.locus', 'HANDOFF.md'),
      'utf8',
    );
    expect(handoffMd).toContain('Implement async iterator pagination in NebulaClient');
    expect(handoffMd).toContain('undici v5 interceptor API removed in v6');
    expect(handoffMd).toContain('Expose async iterable pagination');

    // Verify git status remains clean
    expect(git(repoDir, ['status', '--porcelain'])).toBe('');
  });

  it('serves Mission Control REST API endpoints cleanly', async () => {
    const staticDir = path.join(tmpDir, 'mock-web');
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<html>Locus UI</html>');

    const { app, engine } = createLocusHttpApp({
      dbPath,
      defaultProjectPath: repoDir,
      staticDir,
    });

    try {
      // 1. Health & Projects
      const healthRes = await app.request('/api/health');
      expect(healthRes.status).toBe(200);
      const health = await healthRes.json();
      expect(health.ok).toBe(true);
      const projectId: string = health.defaultProjectId;

      // 2. Initialize project bridges via API
      const initRes = await app.request(`/api/projects/${projectId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(initRes.status).toBe(200);

      // 3. Save Handoff Capsule via API
      const putHandoff = await app.request(`/api/projects/${projectId}/handoff`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objective: 'Ship streaming batch uploader',
          summary: 'Chunking complete; backpressure test pending.',
          activeHypothesis: '64KB chunks maximize throughput.',
          tasks: [{ text: 'Implement 64KB stream chunker', status: 'in_progress' }],
          blockers: [],
          nextSteps: ['Run memory leak soak test'],
          sourceIde: 'cursor',
        }),
      });
      expect(putHandoff.status).toBe(200);

      // 4. Toggle task status via PATCH
      const patchTask = await app.request(`/api/projects/${projectId}/handoff/tasks`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskIdOrQuery: '64KB stream chunker',
          status: 'done',
        }),
      });
      expect(patchTask.status).toBe(200);

      // 5. Record memory & query via hybrid search
      const postMem = await app.request(`/api/projects/${projectId}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'research',
          title: 'Node 22 WebStreams vs Node Readable Backpressure',
          body: 'Node pipeline() handles premature close cleanup more reliably than manual pipeTo.',
          tags: ['streams', 'node22'],
          relatedFiles: ['src/client.ts'],
          pinned: true,
          sourceIde: 'claude-code',
        }),
      });
      expect(postMem.status).toBe(201);
      const createdMem = (await postMem.json()).memory;

      const searchRes = await app.request(
        `/api/projects/${projectId}/memories?q=${encodeURIComponent('Readable pipeline backpressure')}`,
      );
      const searchData = await searchRes.json();
      expect(searchData.mode).toBe('search');
      expect(searchData.count).toBe(1);
      expect(searchData.memories[0].id).toBe(createdMem.id);

      // 6. Trigger Git Drift and re-anchor via API
      fs.writeFileSync(
        path.join(repoDir, 'src', 'client.ts'),
        'export class Client { upload() {} }\n',
      );
      const driftedGet = await app.request(`/api/memories/${createdMem.id}`);
      expect((await driftedGet.json()).memory.drift.drifted).toBe(true);

      git(repoDir, ['add', 'src/client.ts']);
      git(repoDir, ['commit', '-m', 'Add upload method']);

      const reanchorRes = await app.request(`/api/memories/${createdMem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reanchorCommit: true }),
      });
      expect((await reanchorRes.json()).memory.drift.drifted).toBe(false);

      // 7. Overview & Static UI root
      const overviewRes = await app.request(`/api/projects/${projectId}/overview`);
      const overview = await overviewRes.json();
      expect(overview.handoff.tasks[0].status).toBe('done');
      expect(overview.bridgeHealth.initialized).toBe(true);

      const uiRootRes = await app.request('/');
      expect(uiRootRes.status).toBe(200);
      expect(await uiRootRes.text()).toContain('Locus UI');
    } finally {
      engine.close();
    }
  });
});
