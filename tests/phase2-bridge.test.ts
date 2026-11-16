import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeProjectBridges } from '../src/bridge/adapters.js';
import { compileProjectContext } from '../src/bridge/compiler.js';
import { encodeClaudeProjectSlug } from '../src/bridge/harvesters/claude-harvester.js';
import { syncProjectState } from '../src/bridge/harvesters/sync.js';
import { LocusEngine } from '../src/core/engine.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('Phase 2 — Context Compiler, Non-Destructive IDE Bridges & Session Harvesters', () => {
  let tmpDir: string;
  let repoDir: string;
  let dbPath: string;
  let engine: LocusEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locus-phase2-'));
    repoDir = path.join(tmpDir, 'atlas-service');
    dbPath = path.join(tmpDir, 'locus.db');

    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'dev@locus.local']);
    git(repoDir, ['config', 'user.name', 'Locus Tester']);

    fs.writeFileSync(path.join(repoDir, 'src', 'auth.ts'), 'export const auth = true;\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'Initial commit']);

    // Use realpath so macOS/Linux symlinks match git rev-parse --show-toplevel
    repoDir = fs.realpathSync.native(repoDir);
    engine = new LocusEngine(dbPath);
  });

  afterEach(() => {
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compiles token-budgeted context with progressive disclosure for research', () => {
    engine.saveCheckpoint({
      projectPath: repoDir,
      objective: 'Migrate session tokens from HS256 to EdDSA (Ed25519)',
      summary: 'Key rotation verifier written; middleware wiring next.',
      tasks: [
        { text: 'Add JWKS key loader', status: 'done', files: ['src/auth.ts'] },
        { text: 'Verify dual-key grace window', status: 'in_progress' },
      ],
      nextSteps: ['Run integration tests against rotated JWKS endpoint'],
      sourceIde: 'cursor',
    });

    engine.recordMemory({
      projectPath: repoDir,
      kind: 'dead_end',
      title: 'jose v3 lacks Node 22 WebCrypto Ed25519 export',
      body: 'Upgrading to jose v5 resolved subtle crypto key import errors immediately.',
      relatedFiles: ['src/auth.ts'],
      sourceIde: 'cursor',
    });

    const deepResearchBody = Array.from(
      { length: 60 },
      (_, i) =>
        `Benchmark row ${i + 1}: Ed25519 verification latency p99 = 0.09ms vs RSA-2048 0.44ms.`,
    ).join('\n');

    const researchMem = engine.recordMemory({
      projectPath: repoDir,
      kind: 'research',
      title: 'Ed25519 vs RSA-2048 Verification Latency Benchmarks',
      body: deepResearchBody,
      tags: ['crypto', 'benchmarks'],
      sourceIde: 'cursor',
    });

    const compiled = compileProjectContext(engine, {
      projectPath: repoDir,
      maxTokens: 700,
    });

    expect(compiled.tokenReport.usedTokens).toBeLessThanOrEqual(730);
    expect(compiled.markdown).toContain('Migrate session tokens from HS256 to EdDSA');
    expect(compiled.markdown).toContain('jose v3 lacks Node 22 WebCrypto');
    // Research Vault Index includes ID & title for progressive disclosure, NOT the 60-line body!
    expect(compiled.markdown).toContain(researchMem.id);
    expect(compiled.markdown).not.toContain('Benchmark row 45');
    expect(compiled.cursorMdc).toContain('alwaysApply: true');
  });

  it('writes non-destructive Cursor, Claude Code & AGENTS bridges while keeping git status clean', () => {
    // Seed pre-existing user MCP config so we prove non-destructive merging
    fs.mkdirSync(path.join(repoDir, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.cursor', 'mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            postgres: { command: 'npx', args: ['-y', '@mcp/postgres'] },
          },
        },
        null,
        2,
      ),
    );

    const initRes = initializeProjectBridges(engine, {
      projectPath: repoDir,
      targets: ['cursor', 'claude-code', 'agents', 'windsurf'],
    });

    expect(initRes.writtenFiles).toContain('.locus/HANDOFF.md');
    expect(initRes.writtenFiles).toContain('.cursor/rules/locus-handoff.mdc');
    expect(initRes.writtenFiles).toContain('CLAUDE.local.md');
    expect(initRes.writtenFiles).toContain('.mcp.json');
    expect(initRes.writtenFiles).toContain('.claude/settings.local.json');
    expect(initRes.writtenFiles).toContain('AGENTS.md');

    // Verify existing postgres MCP server was preserved alongside locus!
    const cursorMcp = JSON.parse(
      fs.readFileSync(path.join(repoDir, '.cursor', 'mcp.json'), 'utf8'),
    );
    expect(cursorMcp.mcpServers.postgres).toBeDefined();
    expect(cursorMcp.mcpServers.locus).toBeDefined();

    // Verify git status is 100% clean thanks to .git/info/exclude!
    const gitStatus = git(repoDir, ['status', '--porcelain']);
    expect(gitStatus).toBe('');
  });

  it('harvests Cursor state.vscdb and Claude Code JSONL sessions when switching IDEs abruptly', () => {
    initializeProjectBridges(engine, { projectPath: repoDir });

    // 1. Simulate an abrupt exit from Cursor with session data in state.vscdb
    const cursorUserDir = path.join(tmpDir, 'CursorUser');
    const wsHashDir = path.join(cursorUserDir, 'workspaceStorage', 'ws_hash_123');
    fs.mkdirSync(wsHashDir, { recursive: true });
    fs.writeFileSync(
      path.join(wsHashDir, 'workspace.json'),
      JSON.stringify({ folder: pathToFileURL(repoDir).href }),
    );

    const vscdb = new Database(path.join(wsHashDir, 'state.vscdb'));
    vscdb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
    vscdb
      .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(
        'composer.composerData',
        JSON.stringify({
          allComposers: [
            {
              composerId: 'comp_01',
              lastUpdatedAt: Date.now() - 5000,
              conversation: [
                {
                  type: 'user',
                  text: 'Build rate-limiter middleware using token bucket in src/auth.ts',
                  context: {
                    fileSelections: [{ fsPath: path.join(repoDir, 'src', 'auth.ts') }],
                  },
                },
                {
                  type: 'ai',
                  text: 'Implemented TokenBucket skeleton in src/auth.ts; Redis Lua script still needed.',
                },
              ],
            },
          ],
        }),
      );
    vscdb.close();

    const firstSync = syncProjectState(engine, {
      projectPath: repoDir,
      cursorUserDir,
      claudeProjectsDir: path.join(tmpDir, 'empty-claude'),
    });

    expect(firstSync.harvested).toHaveLength(1);
    expect(firstSync.harvested[0].sourceIde).toBe('cursor');

    // Running sync again without changes is idempotent (0 newly harvested)
    const idempotentSync = syncProjectState(engine, {
      projectPath: repoDir,
      cursorUserDir,
      claudeProjectsDir: path.join(tmpDir, 'empty-claude'),
    });
    expect(idempotentSync.harvested).toHaveLength(0);

    // 2. Now simulate a Claude Code JSONL transcript in ~/.claude/projects/<slug>/sess.jsonl
    const claudeProjectsDir = path.join(tmpDir, 'claude-projects');
    const slugDir = path.join(claudeProjectsDir, encodeClaudeProjectSlug(repoDir));
    fs.mkdirSync(slugDir, { recursive: true });

    const jsonlLines = [
      JSON.stringify({
        type: 'user',
        cwd: repoDir,
        timestamp: new Date().toISOString(),
        message: {
          content: 'Finish the atomic Redis Lua token bucket script and test concurrency',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: repoDir,
        timestamp: new Date().toISOString(),
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: path.join(repoDir, 'src', 'limiter.ts') },
            },
            {
              type: 'text',
              text: 'Added atomic EVALSHA token bucket in src/limiter.ts; ready for benchmark run.',
            },
          ],
        },
      }),
    ];
    fs.writeFileSync(path.join(slugDir, 'session-abc.jsonl'), jsonlLines.join('\n') + '\n');

    const secondSync = syncProjectState(engine, {
      projectPath: repoDir,
      cursorUserDir,
      claudeProjectsDir,
    });

    expect(secondSync.harvested).toHaveLength(1);
    expect(secondSync.harvested[0].sourceIde).toBe('claude-code');

    const handoffFile = fs.readFileSync(
      path.join(repoDir, '.locus', 'HANDOFF.md'),
      'utf8',
    );
    expect(handoffFile).toContain('EVALSHA token bucket');
    expect(handoffFile).toContain('claude-code');
  });
});
