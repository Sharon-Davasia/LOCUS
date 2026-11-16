import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadProjectConfig, writeIdeBridges } from '../bridge/adapters.js';
import { compileProjectContext } from '../bridge/compiler.js';
import { syncProjectState } from '../bridge/harvesters/sync.js';
import { LocusEngine } from '../core/engine.js';
import type { MemoryKind, SourceIde, TaskStatus } from '../types.js';

export interface LocusMcpServerOptions {
  engine?: LocusEngine;
  dbPath?: string;
  defaultProjectPath?: string;
}

const SOURCE_IDE_ENUM = z.enum([
  'cursor',
  'claude-code',
  'windsurf',
  'codex',
  'cli',
  'ui',
  'mcp',
  'git',
]);

const MEMORY_KIND_ENUM = z.enum([
  'decision',
  'dead_end',
  'research',
  'convention',
  'note',
]);

const TASK_STATUS_ENUM = z.enum(['done', 'in_progress', 'todo', 'blocked']);

function maybeRefreshBridges(engine: LocusEngine, projectPath: string): void {
  const cfg = loadProjectConfig(projectPath);
  if (cfg) {
    writeIdeBridges(engine, { projectPath });
  }
}

export function createLocusMcpServer(options: LocusMcpServerOptions = {}): {
  mcp: McpServer;
  engine: LocusEngine;
} {
  const engine = options.engine ?? new LocusEngine(options.dbPath);
  const defaultPath = options.defaultProjectPath ?? process.cwd();

  const mcp = new McpServer(
    {
      name: 'locus',
      version: '0.1.0',
    },
    {
      instructions:
        'Locus is the local project memory space and cross-IDE handoff engine. ' +
        'Check `locus_get_handoff` when starting a session, `locus_search` / `locus_get_entry` before researching or refactoring unfamiliar modules, ' +
        '`locus_record` whenever making architectural decisions or hitting dead ends, and `locus_checkpoint` before concluding work.',
    },
  );

  // 1. Tool: locus_get_handoff
  mcp.registerTool(
    'locus_get_handoff',
    {
      title: 'Get Active Project Handoff',
      description:
        'Fetch the compiled branch Handoff Capsule, live git dirty state, dead-end warnings, key decisions, and research index.',
      inputSchema: {
        projectPath: z
          .string()
          .optional()
          .describe('Optional repository path (defaults to workspace root)'),
        branch: z.string().optional().describe('Optional git branch override'),
        maxTokens: z
          .number()
          .int()
          .min(300)
          .max(4000)
          .optional()
          .describe('Token budget for the compiled capsule (default 850)'),
      },
    },
    async (args) => {
      const targetPath = args.projectPath ?? defaultPath;
      const { project, git } = engine.ensureProject(targetPath);
      const branch = args.branch ?? git.branch;
      const handoff = engine.getHandoff(project.id, branch, git.repoRoot);
      const compiled = compileProjectContext(engine, {
        projectPath: git.repoRoot,
        branch,
        maxTokens: args.maxTokens ?? 850,
      });

      return {
        content: [
          {
            type: 'text',
            text: compiled.markdown,
          },
          {
            type: 'text',
            text: JSON.stringify(
              {
                projectId: project.id,
                branch,
                lastIde: handoff.lastIde,
                tokenReport: compiled.tokenReport,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 2. Tool: locus_checkpoint
  mcp.registerTool(
    'locus_checkpoint',
    {
      title: 'Save Handoff Checkpoint',
      description:
        'Save or update the active branch Handoff Capsule (objective, summary, hypothesis, checklist tasks, blockers, next steps) so switching IDEs resumes seamlessly.',
      inputSchema: {
        projectPath: z.string().optional(),
        objective: z.string().optional().describe('Current overarching task goal'),
        summary: z
          .string()
          .optional()
          .describe('Concise summary of current state and why uncommitted files look as they do'),
        activeHypothesis: z
          .string()
          .optional()
          .describe('Current engineering hypothesis or approach'),
        tasks: z
          .array(
            z.object({
              text: z.string(),
              status: TASK_STATUS_ENUM,
              files: z.array(z.string()).optional(),
            }),
          )
          .optional()
          .describe('Checklist items with status done | in_progress | todo | blocked'),
        blockers: z.array(z.string()).optional(),
        nextSteps: z.array(z.string()).optional(),
        activeFiles: z.array(z.string()).optional(),
        mergeTasks: z
          .boolean()
          .optional()
          .describe('If true, merges incoming tasks by text instead of replacing the whole list'),
        sourceIde: SOURCE_IDE_ENUM.optional().describe(
          'Identifier of the active IDE/agent (e.g. cursor, claude-code, windsurf, codex)',
        ),
      },
    },
    async (args) => {
      const targetPath = args.projectPath ?? defaultPath;
      const result = engine.saveCheckpoint({
        projectPath: targetPath,
        objective: args.objective,
        summary: args.summary,
        activeHypothesis: args.activeHypothesis,
        tasks: args.tasks as Array<{
          text: string;
          status: TaskStatus;
          files?: string[];
        }>,
        blockers: args.blockers,
        nextSteps: args.nextSteps,
        activeFiles: args.activeFiles,
        mergeTasks: args.mergeTasks,
        sourceIde: (args.sourceIde as SourceIde | undefined) ?? 'mcp',
      });

      maybeRefreshBridges(engine, result.git.repoRoot);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                projectId: result.project.id,
                branch: result.handoff.branch,
                switchedFromIde: result.switchedFromIde,
                handoff: result.handoff,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 3. Tool: locus_record
  mcp.registerTool(
    'locus_record',
    {
      title: 'Record Project Memory',
      description:
        'Store a structured project memory: `decision` (architectural choice & why), `dead_end` (failed approach & root cause — do not retry), `research` (benchmarks, docs, API findings), `convention`, or `note`.',
      inputSchema: {
        projectPath: z.string().optional(),
        kind: MEMORY_KIND_ENUM,
        title: z.string().min(3).describe('Concise, specific title'),
        summary: z
          .string()
          .optional()
          .describe('1-2 sentence summary for compact handoff injection'),
        body: z
          .string()
          .min(3)
          .describe('Detailed Markdown explanation, rationale, root cause, or findings'),
        tags: z.array(z.string()).optional(),
        relatedFiles: z
          .array(z.string())
          .optional()
          .describe('Relative file paths anchored to this memory for Git Drift detection'),
        sourceUrls: z.array(z.string()).optional(),
        supersedesId: z
          .string()
          .optional()
          .describe('Optional ID of an older memory that this entry supersedes'),
        pinned: z.boolean().optional(),
        sourceIde: SOURCE_IDE_ENUM.optional(),
      },
    },
    async (args) => {
      const targetPath = args.projectPath ?? defaultPath;
      const { git } = engine.ensureProject(targetPath);
      const entry = engine.recordMemory({
        projectPath: git.repoRoot,
        kind: args.kind as MemoryKind,
        title: args.title,
        summary: args.summary,
        body: args.body,
        tags: args.tags,
        relatedFiles: args.relatedFiles,
        sourceUrls: args.sourceUrls,
        supersedesId: args.supersedesId,
        pinned: args.pinned,
        sourceIde: (args.sourceIde as SourceIde | undefined) ?? 'mcp',
      });

      maybeRefreshBridges(engine, git.repoRoot);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                entry,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 4. Tool: locus_search
  mcp.registerTool(
    'locus_search',
    {
      title: 'Hybrid Search Project Memory',
      description:
        'Search across all project research, decisions, dead ends, and conventions using hybrid FTS5 BM25 + semantic similarity + git file context.',
      inputSchema: {
        projectPath: z.string().optional(),
        query: z.string().describe('Search terms, file path, error message, or topic'),
        kinds: z.array(MEMORY_KIND_ENUM).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      },
    },
    async (args) => {
      const targetPath = args.projectPath ?? defaultPath;
      const { project, git } = engine.ensureProject(targetPath);
      const hits = engine.searchMemories({
        projectId: project.id,
        projectPath: git.repoRoot,
        query: args.query,
        kinds: args.kinds as MemoryKind[] | undefined,
        tags: args.tags,
        branch: git.branch,
        limit: args.limit ?? 8,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: hits.length,
                results: hits.map((h) => ({
                  id: h.id,
                  kind: h.kind,
                  title: h.title,
                  summary: h.summary,
                  snippet: h.snippet,
                  score: h.score,
                  tags: h.tags,
                  relatedFiles: h.relatedFiles,
                  sourceIde: h.sourceIde,
                  drift: h.drift,
                  updatedAt: h.updatedAt,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 5. Tool: locus_get_entry
  mcp.registerTool(
    'locus_get_entry',
    {
      title: 'Get Full Memory Entry',
      description:
        'Retrieve the full Markdown body, source URLs, related files, and live Git Drift status of a memory entry by ID.',
      inputSchema: {
        id: z.string().describe('Memory ID (e.g. mem_...)'),
        projectPath: z.string().optional(),
      },
    },
    async (args) => {
      const targetPath = args.projectPath ?? defaultPath;
      const entry = engine.getMemory(args.id, targetPath);
      if (!entry) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Memory entry not found: ${args.id}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(entry, null, 2),
          },
        ],
      };
    },
  );

  // 6. Tool: locus_list_recent
  mcp.registerTool(
    'locus_list_recent',
    {
      title: 'List Recent Memories & Cross-IDE Timeline',
      description:
        'List recent structured memories and cross-IDE activity events for the current project.',
      inputSchema: {
        projectPath: z.string().optional(),
        kinds: z.array(MEMORY_KIND_ENUM).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) => {
      const targetPath = args.projectPath ?? defaultPath;
      const { project, git } = engine.ensureProject(targetPath);
      const memories = engine.listMemories({
        projectId: project.id,
        projectPath: git.repoRoot,
        kinds: args.kinds as MemoryKind[] | undefined,
        limit: args.limit ?? 12,
      });
      const timeline = engine.listTimeline(project.id, 10);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                project: project.name,
                branch: git.branch,
                memories,
                timeline,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 7. Tool: locus_update_task
  mcp.registerTool(
    'locus_update_task',
    {
      title: 'Update Task Step Status',
      description:
        'Update the status of a task in the active branch Handoff checklist by ID or text substring.',
      inputSchema: {
        projectPath: z.string().optional(),
        taskIdOrQuery: z
          .string()
          .describe('Task ID or unique substring of the task text'),
        status: TASK_STATUS_ENUM,
        sourceIde: SOURCE_IDE_ENUM.optional(),
      },
    },
    async (args) => {
      const targetPath = args.projectPath ?? defaultPath;
      const { project, git } = engine.ensureProject(targetPath);
      const updated = engine.updateTaskStatus(
        project.id,
        git.branch,
        args.taskIdOrQuery,
        args.status as TaskStatus,
        (args.sourceIde as SourceIde | undefined) ?? 'mcp',
      );

      if (!updated) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `No matching task found for "${args.taskIdOrQuery}" on branch ${git.branch}.`,
            },
          ],
        };
      }

      maybeRefreshBridges(engine, git.repoRoot);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, handoff: updated }, null, 2),
          },
        ],
      };
    },
  );

  // 8. Tool: locus_sync
  mcp.registerTool(
    'locus_sync',
    {
      title: 'Sync IDE Sessions & Recompile Bridges',
      description:
        'Harvest recent local Cursor and Claude Code session logs, inspect git working tree changes, and refresh IDE handoff bridges.',
      inputSchema: {
        projectPath: z.string().optional(),
      },
    },
    async (args) => {
      const targetPath = args.projectPath ?? defaultPath;
      const res = syncProjectState(engine, { projectPath: targetPath });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                projectId: res.projectId,
                branch: res.branch,
                harvestedSessions: res.harvested.length,
                writtenFiles: res.bridges?.writtenFiles ?? [],
                tokenReport: res.bridges?.compiled.tokenReport ?? null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // Resources
  mcp.registerResource(
    'current-handoff',
    'locus://handoff/current',
    {
      title: 'Current Locus Handoff Capsule',
      description: 'Compiled branch handoff state, git status, decisions, and dead ends',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const compiled = compileProjectContext(engine, { projectPath: defaultPath });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: compiled.markdown,
          },
        ],
      };
    },
  );

  mcp.registerResource(
    'dead-ends',
    'locus://memories/dead-ends',
    {
      title: 'Project Dead Ends (Do Not Retry)',
      description: 'Failed approaches and root causes recorded across IDE sessions',
      mimeType: 'application/json',
    },
    async (uri) => {
      const { project, git } = engine.ensureProject(defaultPath);
      const items = engine.listMemories({
        projectId: project.id,
        projectPath: git.repoRoot,
        kinds: ['dead_end'],
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    },
  );

  mcp.registerResource(
    'decisions',
    'locus://memories/decisions',
    {
      title: 'Architectural Decisions',
      description: 'Active architectural choices and rationales for the project',
      mimeType: 'application/json',
    },
    async (uri) => {
      const { project, git } = engine.ensureProject(defaultPath);
      const items = engine.listMemories({
        projectId: project.id,
        projectPath: git.repoRoot,
        kinds: ['decision'],
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(items, null, 2),
          },
        ],
      };
    },
  );

  // Prompts
  mcp.registerPrompt(
    'resume-work',
    {
      title: 'Resume Work from Locus Handoff',
      description:
        'Load the active cross-IDE handoff state and continue seamlessly without losing context.',
    },
    async () => {
      const compiled = compileProjectContext(engine, { projectPath: defaultPath });
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                'I just switched into this IDE/session. Review the Locus Handoff Capsule below, verify any drifted files if flagged, and continue from the active tasks and next steps without repeating any listed dead ends:',
                '',
                compiled.markdown,
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  mcp.registerPrompt(
    'prepare-handoff',
    {
      title: 'Prepare Clean IDE Handoff',
      description:
        'Checkpoint current progress, decisions, and dead ends into Locus before switching IDEs.',
      argsSchema: {
        targetIde: z
          .string()
          .optional()
          .describe('Optional IDE you are switching to (e.g. claude-code or cursor)'),
      },
    },
    async (args) => {
      const dest = args.targetIde ? ` to ${args.targetIde}` : ' to another IDE';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `I am about to switch${dest}. Please:\n` +
                `1. Call \`locus_record\` for any new architectural \`decision\`, \`dead_end\` (failed attempt), or \`research\` finding from this session.\n` +
                `2. Call \`locus_checkpoint\` with the exact current objective, state summary (including why any dirty git files are uncommitted), updated task checklist, blockers, and immediate next steps.\n` +
                `3. Confirm in 3 concise bullets once the handoff capsule is saved.`,
            },
          },
        ],
      };
    },
  );

  return { mcp, engine };
}

export async function runStdioMcpServer(
  options: LocusMcpServerOptions = {},
): Promise<void> {
  const { mcp } = createLocusMcpServer(options);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}
