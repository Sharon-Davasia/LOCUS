import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeProjectBridges,
  inspectBridgeHealth,
  loadProjectConfig,
  writeIdeBridges,
  type IdeBridgeTarget,
} from '../bridge/adapters.js';
import { compileProjectContext } from '../bridge/compiler.js';
import { syncProjectState } from '../bridge/harvesters/sync.js';
import { LocusEngine } from '../core/engine.js';
import { inspectGitRepo } from '../core/git.js';
import type { MemoryKind, MemoryStatus, SourceIde, TaskStatus } from '../types.js';

export interface LocusServerOptions {
  engine?: LocusEngine;
  dbPath?: string;
  defaultProjectPath?: string;
  staticDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function resolveDefaultStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../web'),
    path.resolve(here, '../../dist/web'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) {
      return c;
    }
  }
  return candidates[0];
}

export function createLocusHttpApp(options: LocusServerOptions = {}): {
  app: Hono;
  engine: LocusEngine;
} {
  const engine = options.engine ?? new LocusEngine(options.dbPath);
  const defaultProjectPath = options.defaultProjectPath ?? process.cwd();
  const staticDir = options.staticDir ?? resolveDefaultStaticDir();

  // Ensure default project is registered immediately
  engine.ensureProject(defaultProjectPath);

  const app = new Hono();
  app.use('*', cors());

  const refreshIfInitialized = (repoRoot: string) => {
    if (loadProjectConfig(repoRoot)) {
      writeIdeBridges(engine, { projectPath: repoRoot });
    }
  };

  app.get('/api/health', (c) => {
    const { project, git } = engine.ensureProject(defaultProjectPath);
    return c.json({
      ok: true,
      service: 'locus',
      version: '0.1.0',
      defaultProjectId: project.id,
      defaultBranch: git.branch,
    });
  });

  app.get('/api/projects', (c) => {
    const { project: activeDefault } = engine.ensureProject(defaultProjectPath);
    const projects = engine.listProjects();
    return c.json({
      defaultProjectId: activeDefault.id,
      projects,
    });
  });

  app.post('/api/projects/ensure', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    const target = body.path?.trim() || defaultProjectPath;
    if (!fs.existsSync(target)) {
      return c.json({ error: `Directory does not exist: ${target}` }, 400);
    }
    const { project, git } = engine.ensureProject(target);
    return c.json({ project, git });
  });

  app.get('/api/projects/:id/overview', (c) => {
    const projectId = c.req.param('id');
    const project = engine.getProject(projectId);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const git = inspectGitRepo(project.rootPath);
    const requestedBranch = c.req.query('branch') || git.branch;
    const maxTokensParam = Number(c.req.query('maxTokens') || 0);
    const cfg = loadProjectConfig(git.repoRoot);
    const maxTokens =
      maxTokensParam >= 300 ? maxTokensParam : (cfg?.maxTokens ?? 850);

    const handoff = engine.getHandoff(project.id, requestedBranch, git.repoRoot);
    const handoffs = engine.listHandoffs(project.id);
    const stats = engine.getProjectStats(project.id, git.repoRoot);
    const compiled = compileProjectContext(engine, {
      projectPath: git.repoRoot,
      branch: requestedBranch,
      maxTokens,
    });
    const bridgeHealth = inspectBridgeHealth(git.repoRoot);
    const timeline = engine.listTimeline(project.id, 35);

    return c.json({
      project,
      git,
      handoff,
      handoffs,
      stats,
      compiled,
      bridgeHealth,
      timeline,
    });
  });

  app.put('/api/projects/:id/handoff', async (c) => {
    const projectId = c.req.param('id');
    const project = engine.getProject(projectId);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const body = (await c.req.json()) as {
      branch?: string;
      objective?: string;
      summary?: string;
      activeHypothesis?: string;
      tasks?: Array<{ id?: string; text: string; status: TaskStatus; files?: string[] }>;
      blockers?: string[];
      nextSteps?: string[];
      activeFiles?: string[];
      sourceIde?: SourceIde;
    };

    const res = engine.saveCheckpoint({
      projectPath: project.rootPath,
      branch: body.branch,
      objective: body.objective,
      summary: body.summary,
      activeHypothesis: body.activeHypothesis,
      tasks: body.tasks,
      blockers: body.blockers,
      nextSteps: body.nextSteps,
      activeFiles: body.activeFiles,
      sourceIde: body.sourceIde ?? 'ui',
    });

    refreshIfInitialized(res.git.repoRoot);
    return c.json({ ok: true, handoff: res.handoff, switchedFromIde: res.switchedFromIde });
  });

  app.patch('/api/projects/:id/handoff/tasks', async (c) => {
    const projectId = c.req.param('id');
    const project = engine.getProject(projectId);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const body = (await c.req.json()) as {
      branch?: string;
      taskIdOrQuery: string;
      status: TaskStatus;
      sourceIde?: SourceIde;
    };

    const git = inspectGitRepo(project.rootPath);
    const branch = body.branch || git.branch;
    const updated = engine.updateTaskStatus(
      project.id,
      branch,
      body.taskIdOrQuery,
      body.status,
      body.sourceIde ?? 'ui',
    );

    if (!updated) {
      return c.json({ error: 'Task not found' }, 404);
    }

    refreshIfInitialized(git.repoRoot);
    return c.json({ ok: true, handoff: updated });
  });

  app.get('/api/projects/:id/memories', (c) => {
    const projectId = c.req.param('id');
    const project = engine.getProject(projectId);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const q = (c.req.query('q') ?? '').trim();
    const kindParam = c.req.query('kind');
    const tagParam = c.req.query('tag');
    const includeArchived = c.req.query('includeArchived') === 'true';
    const limit = Number(c.req.query('limit') || 50);

    const kinds = kindParam
      ? (kindParam.split(',').filter(Boolean) as MemoryKind[])
      : undefined;
    const tags = tagParam ? tagParam.split(',').filter(Boolean) : undefined;

    if (q) {
      const results = engine.searchMemories({
        projectId: project.id,
        projectPath: project.rootPath,
        query: q,
        kinds,
        tags,
        includeArchived,
        limit,
      });
      return c.json({ mode: 'search', count: results.length, memories: results });
    }

    const items = engine.listMemories({
      projectId: project.id,
      projectPath: project.rootPath,
      kinds,
      status: includeArchived ? 'all' : 'active',
      limit,
    });
    return c.json({ mode: 'list', count: items.length, memories: items });
  });

  app.get('/api/memories/:memoryId', (c) => {
    const memory = engine.getMemory(c.req.param('memoryId'));
    if (!memory) return c.json({ error: 'Memory not found' }, 404);
    return c.json({ memory });
  });

  app.post('/api/projects/:id/memories', async (c) => {
    const projectId = c.req.param('id');
    const project = engine.getProject(projectId);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const body = (await c.req.json()) as {
      kind: MemoryKind;
      title: string;
      summary?: string;
      body: string;
      tags?: string[];
      relatedFiles?: string[];
      sourceUrls?: string[];
      pinned?: boolean;
      supersedesId?: string;
      sourceIde?: SourceIde;
    };

    if (!body.title?.trim() || !body.body?.trim() || !body.kind) {
      return c.json({ error: 'kind, title, and body are required' }, 400);
    }

    const entry = engine.recordMemory({
      projectPath: project.rootPath,
      kind: body.kind,
      title: body.title,
      summary: body.summary,
      body: body.body,
      tags: body.tags,
      relatedFiles: body.relatedFiles,
      sourceUrls: body.sourceUrls,
      pinned: body.pinned,
      supersedesId: body.supersedesId,
      sourceIde: body.sourceIde ?? 'ui',
    });

    refreshIfInitialized(project.rootPath);
    return c.json({ ok: true, memory: entry }, 201);
  });

  app.patch('/api/memories/:memoryId', async (c) => {
    const memoryId = c.req.param('memoryId');
    const existing = engine.getMemory(memoryId);
    if (!existing) return c.json({ error: 'Memory not found' }, 404);

    const patch = (await c.req.json()) as Partial<{
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
    }>;

    const project = engine.getProject(existing.projectId);
    const updated = engine.updateMemory(memoryId, patch, project?.rootPath);
    if (project) refreshIfInitialized(project.rootPath);

    return c.json({ ok: true, memory: updated });
  });

  app.delete('/api/memories/:memoryId', (c) => {
    const memoryId = c.req.param('memoryId');
    const existing = engine.getMemory(memoryId);
    if (!existing) return c.json({ error: 'Memory not found' }, 404);
    const project = engine.getProject(existing.projectId);
    engine.deleteMemory(memoryId);
    if (project) refreshIfInitialized(project.rootPath);
    return c.json({ ok: true });
  });

  app.post('/api/projects/:id/sync', async (c) => {
    const projectId = c.req.param('id');
    const project = engine.getProject(projectId);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const res = syncProjectState(engine, { projectPath: project.rootPath });
    return c.json({
      ok: true,
      harvestedCount: res.harvested.length,
      harvested: res.harvested,
      writtenFiles: res.bridges?.writtenFiles ?? [],
      tokenReport: res.bridges?.compiled.tokenReport ?? null,
    });
  });

  app.post('/api/projects/:id/init', async (c) => {
    const projectId = c.req.param('id');
    const project = engine.getProject(projectId);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      targets?: IdeBridgeTarget[];
      maxTokens?: number;
      shared?: boolean;
    };

    const res = initializeProjectBridges(engine, {
      projectPath: project.rootPath,
      targets: body.targets,
      maxTokens: body.maxTokens,
      shared: body.shared,
    });

    return c.json({
      ok: true,
      writtenFiles: res.writtenFiles,
      excludedEntries: res.excludedEntries,
      tokenReport: res.compiled.tokenReport,
    });
  });

  // Serve built frontend static files when present
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Endpoint not found' }, 404);
    }
    if (!fs.existsSync(staticDir)) {
      return c.text(
        'Locus API is running. Build web UI (`npm run build:web`) or run Vite dev server.',
        200,
      );
    }

    const relReq = c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\/+/, '');
    const resolvedFile = path.resolve(staticDir, relReq);
    if (
      resolvedFile.startsWith(path.resolve(staticDir)) &&
      fs.existsSync(resolvedFile) &&
      fs.statSync(resolvedFile).isFile()
    ) {
      const ext = path.extname(resolvedFile).toLowerCase();
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      return new Response(fs.readFileSync(resolvedFile), {
        headers: { 'Content-Type': mime },
      });
    }

    const indexHtml = path.join(staticDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      return new Response(fs.readFileSync(indexHtml), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return c.notFound();
  });

  return { app, engine };
}

export function startLocusHttpServer(
  options: LocusServerOptions & { port?: number; hostname?: string } = {},
): Promise<{ server: ServerType; port: number; hostname: string; engine: LocusEngine }> {
  const port = options.port ?? 4317;
  const hostname = options.hostname ?? '127.0.0.1';
  const { app, engine } = createLocusHttpApp(options);

  return new Promise((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        port,
        hostname,
      },
      (info) => {
        resolve({
          server,
          port: info.port,
          hostname,
          engine,
        });
      },
    );
  });
}
