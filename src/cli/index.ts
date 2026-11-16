#!/usr/bin/env node
import { Command } from 'commander';
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
import { resolveDefaultDbPath } from '../core/db.js';
import { LocusEngine } from '../core/engine.js';
import { runStdioMcpServer } from '../mcp/server.js';
import { startLocusHttpServer } from '../server/app.js';
import type { MemoryKind, SourceIde, TaskStep } from '../types.js';

function splitCsv(val?: string): string[] | undefined {
  if (!val) return undefined;
  const items = val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function refreshIfConfigured(engine: LocusEngine, repoRoot: string): void {
  if (loadProjectConfig(repoRoot)) {
    writeIdeBridges(engine, { projectPath: repoRoot });
  }
}

export function createCliProgram(options: { dbPath?: string } = {}): Command {
  const program = new Command();
  const resolveEngine = () => new LocusEngine(options.dbPath);

  program
    .name('locus')
    .description(
      'Locus — Local-first project memory space, context compiler & cross-IDE handoff engine',
    )
    .version('0.1.0');

  // locus init
  program
    .command('init')
    .description(
      'Initialize Locus bridges, MCP configs, Claude hooks, and git-clean excludes for a project',
    )
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option(
      '-t, --targets <list>',
      'Comma-separated IDE targets (cursor,claude-code,agents,windsurf)',
      'cursor,claude-code,agents',
    )
    .option('--max-tokens <n>', 'Token budget for compiled handoff capsule', '850')
    .option('--shared', 'Track bridge files in git instead of local .git/info/exclude', false)
    .option('--no-mcp', 'Skip writing .cursor/mcp.json and .mcp.json')
    .option('--no-hooks', 'Skip wiring Claude Code lifecycle hooks')
    .action((opts) => {
      const engine = resolveEngine();
      try {
        const targets = (splitCsv(opts.targets) ?? [
          'cursor',
          'claude-code',
          'agents',
        ]) as IdeBridgeTarget[];
        const cliEntryPath = fileURLToPath(import.meta.url);
        const res = initializeProjectBridges(engine, {
          projectPath: opts.project,
          targets,
          maxTokens: Number(opts.maxTokens) || 850,
          shared: Boolean(opts.shared),
          configureMcp: Boolean(opts.mcp),
          configureHooks: Boolean(opts.hooks),
          cliEntryPath,
        });

        console.log(`Locus initialized for ${res.repoRoot} (${res.projectId})`);
        console.log(`Bridges written: ${res.writtenFiles.join(', ')}`);
        if (res.excludedEntries.length > 0) {
          console.log(
            `Git hygiene: ${res.excludedEntries.length} local paths managed in .git/info/exclude`,
          );
        }
        console.log(
          `Token budget: ${res.compiled.tokenReport.usedTokens}/${res.compiled.tokenReport.totalBudget} tokens (${res.compiled.tokenReport.utilizationPct}%)`,
        );
      } finally {
        engine.close();
      }
    });

  // locus status
  program
    .command('status')
    .description('Show live project memory summary, active handoff state, and drift status')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('--json', 'Output JSON', false)
    .action((opts) => {
      const engine = resolveEngine();
      try {
        const { project, git } = engine.ensureProject(opts.project);
        const handoff = engine.getHandoff(project.id, git.branch, git.repoRoot);
        const stats = engine.getProjectStats(project.id, git.repoRoot);
        const compiled = compileProjectContext(engine, {
          projectPath: git.repoRoot,
          branch: git.branch,
        });

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                project,
                git,
                handoff,
                stats,
                tokenReport: compiled.tokenReport,
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log(`Project:     ${project.name} (${project.id})`);
        console.log(
          `Branch:      ${git.branch}${git.shortSha ? ` @ ${git.shortSha}` : ''} | Dirty files: ${git.dirtyFiles.length}`,
        );
        console.log(`Last IDE:    ${handoff.lastIde}`);
        console.log(
          `Objective:   ${handoff.objective || '(none set — run `locus checkpoint` or `locus sync`)'}`,
        );
        if (handoff.summary) {
          console.log(`Summary:     ${handoff.summary}`);
        }
        console.log(
          `Memories:    ${stats.totalMemories} active (decisions: ${stats.byKind.decision}, dead_ends: ${stats.byKind.dead_end}, research: ${stats.byKind.research}, conventions: ${stats.byKind.convention})`,
        );
        if (stats.driftedCount > 0) {
          console.log(
            `Git Drift:   ${stats.driftedCount} memory item(s) reference modified files`,
          );
        }
        console.log(
          `Capsule:     ${compiled.tokenReport.usedTokens}/${compiled.tokenReport.totalBudget} tokens (${compiled.tokenReport.utilizationPct}%)`,
        );
      } finally {
        engine.close();
      }
    });

  // locus handoff
  program
    .command('handoff')
    .description('Print the compiled Handoff Capsule or a ready-to-paste resume briefing')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('-b, --briefing', 'Format as a self-contained resume prompt for pasting', false)
    .option('--max-tokens <n>', 'Token budget override')
    .action((opts) => {
      const engine = resolveEngine();
      try {
        const compiled = compileProjectContext(engine, {
          projectPath: opts.project,
          maxTokens: opts.maxTokens ? Number(opts.maxTokens) : undefined,
        });
        process.stdout.write(
          opts.briefing ? compiled.clipboardBriefing + '\n' : compiled.markdown,
        );
      } finally {
        engine.close();
      }
    });

  // locus checkpoint
  program
    .command('checkpoint')
    .description('Save or update the active branch Handoff Capsule')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('-o, --objective <text>', 'Current overarching objective')
    .option('-s, --summary <text>', 'Current state summary')
    .option('--hypothesis <text>', 'Active engineering hypothesis')
    .option('--todo <items>', 'Comma-separated todo tasks')
    .option('--doing <items>', 'Comma-separated in-progress tasks')
    .option('--done <items>', 'Comma-separated completed tasks')
    .option('--blocker <items>', 'Comma-separated blockers')
    .option('--next <items>', 'Comma-separated next steps')
    .option('--ide <ide>', 'Source IDE label (cursor, claude-code, windsurf, codex, cli)', 'cli')
    .option('--replace-tasks', 'Replace task list instead of merging', false)
    .action((opts) => {
      const engine = resolveEngine();
      try {
        const tasks: Array<{ text: string; status: TaskStep['status'] }> = [];
        for (const t of splitCsv(opts.done) ?? []) tasks.push({ text: t, status: 'done' });
        for (const t of splitCsv(opts.doing) ?? [])
          tasks.push({ text: t, status: 'in_progress' });
        for (const t of splitCsv(opts.todo) ?? []) tasks.push({ text: t, status: 'todo' });

        const res = engine.saveCheckpoint({
          projectPath: opts.project,
          objective: opts.objective,
          summary: opts.summary,
          activeHypothesis: opts.hypothesis,
          tasks: tasks.length > 0 ? tasks : undefined,
          blockers: splitCsv(opts.blocker),
          nextSteps: splitCsv(opts.next),
          mergeTasks: !opts.replaceTasks,
          sourceIde: opts.ide as SourceIde,
        });

        refreshIfConfigured(engine, res.git.repoRoot);
        console.log(
          `Saved checkpoint on branch '${res.handoff.branch}' (${res.handoff.tasks.length} tasks).`,
        );
      } finally {
        engine.close();
      }
    });

  // Helper to register `record` and shorthand commands
  const handleRecord = (
    kind: MemoryKind,
    title: string,
    bodyParts: string[],
    opts: {
      project: string;
      summary?: string;
      tags?: string;
      files?: string;
      url?: string;
      pin?: boolean;
      supersedes?: string;
      ide?: string;
    },
  ) => {
    const engine = resolveEngine();
    try {
      const body = bodyParts.join(' ').trim() || title;
      const { git } = engine.ensureProject(opts.project);
      const mem = engine.recordMemory({
        projectPath: git.repoRoot,
        kind,
        title,
        summary: opts.summary,
        body,
        tags: splitCsv(opts.tags),
        relatedFiles: splitCsv(opts.files),
        sourceUrls: splitCsv(opts.url),
        pinned: Boolean(opts.pin),
        supersedesId: opts.supersedes,
        sourceIde: (opts.ide as SourceIde | undefined) ?? 'cli',
      });

      refreshIfConfigured(engine, git.repoRoot);
      console.log(`Recorded ${mem.kind} [${mem.id}]: ${mem.title}`);
    } finally {
      engine.close();
    }
  };

  program
    .command('record <kind> <title> [body...]')
    .description('Record a memory (decision | dead_end | research | convention | note)')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('-s, --summary <text>', 'Compact 1-line summary')
    .option('-t, --tags <list>', 'Comma-separated tags')
    .option('-f, --files <list>', 'Comma-separated related file paths')
    .option('-u, --url <list>', 'Comma-separated reference URLs')
    .option('--pin', 'Pin memory to top of priority list', false)
    .option('--supersedes <id>', 'ID of older memory superseded by this entry')
    .option('--ide <ide>', 'Source IDE', 'cli')
    .action((kind: string, title: string, body: string[], opts) => {
      const validKinds = new Set([
        'decision',
        'dead_end',
        'research',
        'convention',
        'note',
      ]);
      if (!validKinds.has(kind)) {
        console.error(
          `Invalid kind '${kind}'. Expected one of: decision, dead_end, research, convention, note.`,
        );
        process.exitCode = 1;
        return;
      }
      handleRecord(kind as MemoryKind, title, body, opts);
    });

  for (const [subcmd, kind, desc] of [
    ['decide', 'decision', 'Record an architectural decision and rationale'],
    ['dead-end', 'dead_end', 'Record a failed approach / dead end so no IDE repeats it'],
    ['research', 'research', 'Save research findings, benchmarks, or API notes to the Vault'],
    ['convention', 'convention', 'Record a project-wide coding or tooling convention'],
  ] as const) {
    program
      .command(`${subcmd} <title> [body...]`)
      .description(desc)
      .option('-p, --project <path>', 'Project directory', process.cwd())
      .option('-s, --summary <text>', 'Compact 1-line summary')
      .option('-t, --tags <list>', 'Comma-separated tags')
      .option('-f, --files <list>', 'Comma-separated related file paths')
      .option('-u, --url <list>', 'Comma-separated reference URLs')
      .option('--pin', 'Pin memory', false)
      .option('--supersedes <id>', 'Supersede an older memory ID')
      .option('--ide <ide>', 'Source IDE', 'cli')
      .action((title: string, body: string[], opts) => {
        handleRecord(kind, title, body, opts);
      });
  }

  // locus search
  program
    .command('search <query...>')
    .description('Hybrid lexical + semantic search across project memory')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('-k, --kind <kinds>', 'Comma-separated kinds filter')
    .option('-t, --tag <tags>', 'Comma-separated tags filter')
    .option('-n, --limit <n>', 'Max results', '10')
    .option('--json', 'Output JSON', false)
    .action((queryParts: string[], opts) => {
      const engine = resolveEngine();
      try {
        const query = queryParts.join(' ');
        const { project, git } = engine.ensureProject(opts.project);
        const hits = engine.searchMemories({
          projectId: project.id,
          projectPath: git.repoRoot,
          query,
          kinds: splitCsv(opts.kind) as MemoryKind[] | undefined,
          tags: splitCsv(opts.tag),
          branch: git.branch,
          limit: Number(opts.limit) || 10,
        });

        if (opts.json) {
          console.log(JSON.stringify(hits, null, 2));
          return;
        }

        if (hits.length === 0) {
          console.log(`No memories matched "${query}".`);
          return;
        }

        for (const h of hits) {
          const driftFlag = h.drift.drifted ? ' [DRIFTED]' : '';
          console.log(
            `[${h.id}] (${h.kind} | score ${h.score.toFixed(2)} | ${h.sourceIde})${driftFlag} ${h.title}`,
          );
          console.log(`  ${h.snippet}`);
          if (h.relatedFiles.length > 0) {
            console.log(`  files: ${h.relatedFiles.join(', ')}`);
          }
        }
      } finally {
        engine.close();
      }
    });

  // locus show <id>
  program
    .command('show <id>')
    .description('Display the full Markdown entry and Git Drift status for a memory ID')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .action((id: string, opts) => {
      const engine = resolveEngine();
      try {
        const mem = engine.getMemory(id, opts.project);
        if (!mem) {
          console.error(`Memory not found: ${id}`);
          process.exitCode = 1;
          return;
        }
        console.log(`# ${mem.title}`);
        console.log(
          `ID: ${mem.id} | Kind: ${mem.kind} | Source: ${mem.sourceIde} | Updated: ${mem.updatedAt}`,
        );
        if (mem.tags.length > 0) console.log(`Tags: ${mem.tags.join(', ')}`);
        if (mem.relatedFiles.length > 0)
          console.log(`Files: ${mem.relatedFiles.join(', ')}`);
        if (mem.sourceUrls.length > 0) console.log(`URLs: ${mem.sourceUrls.join(', ')}`);
        if (mem.drift.drifted) {
          console.log(`WARNING — Git Drift: ${mem.drift.reason}`);
        }
        console.log('\n' + mem.body);
      } finally {
        engine.close();
      }
    });

  // locus log
  program
    .command('log')
    .description('Show cross-IDE activity timeline for the current project')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .option('-n, --limit <n>', 'Max events', '20')
    .action((opts) => {
      const engine = resolveEngine();
      try {
        const { project } = engine.ensureProject(opts.project);
        const events = engine.listTimeline(project.id, Number(opts.limit) || 20);
        if (events.length === 0) {
          console.log('No timeline events recorded yet.');
          return;
        }
        for (const ev of events) {
          console.log(
            `${ev.createdAt.slice(0, 19).replace('T', ' ')}  [${ev.sourceIde}] (${ev.eventType}) ${ev.summary}`,
          );
        }
      } finally {
        engine.close();
      }
    });

  // locus sync
  program
    .command('sync')
    .description(
      'Harvest latest Cursor & Claude Code local sessions and recompile IDE handoff bridges',
    )
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .action((opts) => {
      const engine = resolveEngine();
      try {
        const res = syncProjectState(engine, { projectPath: opts.project });
        console.log(
          `Synced project (${res.branch}): ${res.harvested.length} new IDE session(s) harvested.`,
        );
        if (res.bridges) {
          console.log(
            `Updated bridges: ${res.bridges.writtenFiles.join(', ')} (${res.bridges.compiled.tokenReport.usedTokens}/${res.bridges.compiled.tokenReport.totalBudget} tokens)`,
          );
        }
      } finally {
        engine.close();
      }
    });

  // locus hook <event> (invoked by Claude Code Stop / PreCompact hooks; never exits non-zero)
  program
    .command('hook <event>')
    .description('Internal lifecycle hook handler for Claude Code / IDE automation')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .action((_event: string, opts) => {
      try {
        const engine = resolveEngine();
        try {
          syncProjectState(engine, { projectPath: opts.project });
        } finally {
          engine.close();
        }
      } catch {
        // Never block or fail an IDE session hook
      }
    });

  // locus mcp
  program
    .command('mcp')
    .description('Start the Locus Model Context Protocol (MCP) server over stdio')
    .option('-p, --project <path>', 'Default project directory', process.cwd())
    .action(async (opts) => {
      await runStdioMcpServer({
        dbPath: options.dbPath,
        defaultProjectPath: path.resolve(opts.project),
      });
    });

  // locus ui
  program
    .command('ui')
    .description('Launch the Locus Mission Control web dashboard and local API server')
    .option('-p, --project <path>', 'Default project directory', process.cwd())
    .option('--port <port>', 'Port to listen on', '4317')
    .option('--host <host>', 'Hostname to bind', '127.0.0.1')
    .option('--api-only', 'Run HTTP API without requiring static build', false)
    .action(async (opts) => {
      const { port, hostname } = await startLocusHttpServer({
        dbPath: options.dbPath,
        defaultProjectPath: path.resolve(opts.project),
        port: Number(opts.port) || 4317,
        hostname: opts.host,
      });
      console.log(
        `Locus Mission Control listening on http://${hostname}:${port} (DB: ${options.dbPath ?? resolveDefaultDbPath()})`,
      );
    });

  // locus doctor
  program
    .command('doctor')
    .description('Inspect Locus database, git state, and IDE bridge health')
    .option('-p, --project <path>', 'Project directory', process.cwd())
    .action((opts) => {
      const engine = resolveEngine();
      try {
        const { project, git } = engine.ensureProject(opts.project);
        const health = inspectBridgeHealth(git.repoRoot);
        console.log(`Database:    ${engine.db.name} (OK)`);
        console.log(`Project:     ${project.name} (${project.id})`);
        console.log(`Git Repo:    ${git.isGitRepo ? git.repoRoot : 'Not a git repo'}`);
        console.log(`Initialized: ${health.initialized ? 'Yes' : 'No (`locus init`)'}`);
        for (const f of health.files) {
          if (f.exists) {
            console.log(`  [x] ${f.path} (${f.sizeBytes} bytes)`);
          }
        }
      } finally {
        engine.close();
      }
    });

  return program;
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const program = createCliProgram();
  program.parseAsync(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
