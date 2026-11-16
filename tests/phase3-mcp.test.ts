import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeProjectBridges } from '../src/bridge/adapters.js';
import { LocusEngine } from '../src/core/engine.js';
import { createLocusMcpServer } from '../src/mcp/server.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('Phase 3 — Universal MCP Server End-to-End (Cursor <-> Claude Code)', () => {
  let tmpDir: string;
  let repoDir: string;
  let dbPath: string;
  let engine: LocusEngine;
  let client: Client;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locus-phase3-'));
    repoDir = path.join(tmpDir, 'hyperion-engine');
    dbPath = path.join(tmpDir, 'locus.db');

    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'dev@locus.local']);
    git(repoDir, ['config', 'user.name', 'Locus Tester']);
    fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const v = 1;\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'Initial commit']);

    repoDir = fs.realpathSync.native(repoDir);
    engine = new LocusEngine(dbPath);
    initializeProjectBridges(engine, { projectPath: repoDir });

    const { mcp } = createLocusMcpServer({
      engine,
      defaultProjectPath: repoDir,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-ide-client', version: '1.0.0' });

    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes full MCP toolset, resources, and prompts', async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'locus_get_handoff',
        'locus_checkpoint',
        'locus_record',
        'locus_search',
        'locus_get_entry',
        'locus_list_recent',
        'locus_update_task',
        'locus_sync',
      ]),
    );

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining([
        'locus://handoff/current',
        'locus://memories/dead-ends',
        'locus://memories/decisions',
      ]),
    );

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining(['resume-work', 'prepare-handoff']),
    );
  });

  it('executes a seamless Cursor -> Claude Code handoff roundtrip via MCP', async () => {
    // Step 1 (Cursor): Record a dead end and deep research note
    await client.callTool({
      name: 'locus_record',
      arguments: {
        kind: 'dead_end',
        title: 'Worker threads SharedArrayBuffer requires COOP/COEP headers in browser',
        body: 'Tried SharedArrayBuffer ring-buffer without crossOriginIsolated; Safari and Chrome throw ReferenceError unless COOP/COEP headers are set.',
        relatedFiles: ['src/index.ts'],
        tags: ['wasm', 'workers'],
        sourceIde: 'cursor',
      },
    });

    const researchCall = await client.callTool({
      name: 'locus_record',
      arguments: {
        kind: 'research',
        title: 'MessageChannel Transferable ArrayBuffer Throughput Notes',
        body: 'Zero-copy transferable ArrayBuffers achieve 4.2 GB/s between main thread and Worker without COOP/COEP requirements.',
        tags: ['workers', 'performance'],
        sourceIde: 'cursor',
      },
    });
    const researchPayload = JSON.parse(
      (researchCall.content as Array<{ text: string }>)[0].text,
    );
    const researchId: string = researchPayload.entry.id;

    // Step 2 (Cursor): Save checkpoint before switching to Claude Code
    await client.callTool({
      name: 'locus_checkpoint',
      arguments: {
        objective: 'Implement zero-copy transferable Worker bridge',
        summary: 'Pivoted away from SharedArrayBuffer; ready to wire MessageChannel pool.',
        tasks: [
          { text: 'Benchmark SharedArrayBuffer vs Transferables', status: 'done' },
          { text: 'Implement WorkerPool transferable dispatcher', status: 'in_progress' },
        ],
        nextSteps: ['Add backpressure queue when all workers are busy'],
        sourceIde: 'cursor',
      },
    });

    // Verify disk bridge updated automatically!
    const diskHandoff = fs.readFileSync(
      path.join(repoDir, '.locus', 'HANDOFF.md'),
      'utf8',
    );
    expect(diskHandoff).toContain('Implement zero-copy transferable Worker bridge');
    expect(diskHandoff).toContain('SharedArrayBuffer requires COOP/COEP');
    expect(diskHandoff).toContain(researchId);

    // Step 3 (Claude Code): Resume session via prompt + search + get_entry
    const resumePrompt = await client.getPrompt({ name: 'resume-work' });
    const resumeText = (resumePrompt.messages[0].content as { text: string }).text;
    expect(resumeText).toContain('Implement WorkerPool transferable dispatcher');

    const searchRes = await client.callTool({
      name: 'locus_search',
      arguments: { query: 'zero-copy Transferable throughput workers' },
    });
    const searchJson = JSON.parse(
      (searchRes.content as Array<{ text: string }>)[0].text,
    );
    expect(searchJson.count).toBeGreaterThan(0);
    expect(searchJson.results[0].id).toBe(researchId);

    const entryRes = await client.callTool({
      name: 'locus_get_entry',
      arguments: { id: researchId },
    });
    const entryJson = JSON.parse(
      (entryRes.content as Array<{ text: string }>)[0].text,
    );
    expect(entryJson.body).toContain('4.2 GB/s');

    // Step 4 (Claude Code): Mark task done and checkpoint from claude-code
    await client.callTool({
      name: 'locus_update_task',
      arguments: {
        taskIdOrQuery: 'WorkerPool transferable dispatcher',
        status: 'done',
        sourceIde: 'claude-code',
      },
    });

    const claudeCheckpoint = await client.callTool({
      name: 'locus_checkpoint',
      arguments: {
        summary: 'WorkerPool transferable dispatcher complete and verified.',
        sourceIde: 'claude-code',
      },
    });
    const cpJson = JSON.parse(
      (claudeCheckpoint.content as Array<{ text: string }>)[0].text,
    );
    expect(cpJson.handoff.lastIde).toBe('claude-code');

    const resourceRead = await client.readResource({ uri: 'locus://handoff/current' });
    expect((resourceRead.contents[0] as { text: string }).text).toContain(
      '[x] Implement WorkerPool transferable dispatcher',
    );
  });
});
