import fs from 'node:fs';
import path from 'node:path';
import { compileProjectContext } from './compiler.js';
import type { LocusEngine } from '../core/engine.js';
import { inspectGitRepo } from '../core/git.js';
import type { CompiledContext } from '../types.js';

export type IdeBridgeTarget = 'cursor' | 'claude-code' | 'agents' | 'windsurf';

export interface LocusProjectConfig {
  version: 1;
  projectId: string;
  targets: IdeBridgeTarget[];
  maxTokens: number;
  shared: boolean;
  mcpCommand?: {
    command: string;
    args: string[];
  };
}

export interface InitProjectOptions {
  projectPath?: string;
  targets?: IdeBridgeTarget[];
  maxTokens?: number;
  shared?: boolean;
  configureMcp?: boolean;
  configureHooks?: boolean;
  cliEntryPath?: string;
}

export interface BridgeWriteResult {
  compiled: CompiledContext;
  writtenFiles: string[];
  excludedEntries: string[];
}

const LOCUS_BLOCK_START = '<!-- LOCUS:START -->';
const LOCUS_BLOCK_END = '<!-- LOCUS:END -->';
const EXCLUDE_START = '### LOCUS-MANAGED START ###';
const EXCLUDE_END = '### LOCUS-MANAGED END ###';

export function upsertManagedBlock(
  existingContent: string,
  managedBody: string,
): string {
  const block = `${LOCUS_BLOCK_START}\n${managedBody.trim()}\n${LOCUS_BLOCK_END}`;
  const startIdx = existingContent.indexOf(LOCUS_BLOCK_START);
  const endIdx = existingContent.indexOf(LOCUS_BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingContent.slice(0, startIdx).trimEnd();
    const after = existingContent.slice(endIdx + LOCUS_BLOCK_END.length).trimStart();
    const parts = [before, block, after].filter(Boolean);
    return parts.join('\n\n') + '\n';
  }

  const trimmed = existingContent.trimEnd();
  if (!trimmed) return block + '\n';
  return `${trimmed}\n\n${block}\n`;
}

function readJsonSafe(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeJsonPretty(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function resolveMcpServerCommand(
  repoRoot: string,
  cliEntryPath?: string,
  dbPath?: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  const env: Record<string, string> = {};
  if (dbPath && dbPath !== ':memory:') {
    env.LOCUS_DB_PATH = dbPath;
  }

  if (cliEntryPath && fs.existsSync(cliEntryPath)) {
    return {
      command: process.execPath,
      args: [cliEntryPath, 'mcp', '--project', repoRoot],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  const localDistCli = path.resolve(repoRoot, 'dist/cli/index.js');
  if (fs.existsSync(localDistCli)) {
    return {
      command: process.execPath,
      args: [localDistCli, 'mcp', '--project', repoRoot],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  return {
    command: 'locus',
    args: ['mcp', '--project', repoRoot],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function loadProjectConfig(repoRoot: string): LocusProjectConfig | null {
  const configPath = path.join(repoRoot, '.locus', 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as LocusProjectConfig;
  } catch {
    return null;
  }
}

export function saveProjectConfig(repoRoot: string, config: LocusProjectConfig): string {
  const configPath = path.join(repoRoot, '.locus', 'config.json');
  writeJsonPretty(configPath, config);
  return configPath;
}

export function ensureGitLocalExcludes(
  gitCommonDir: string | null,
  entries: string[],
): string[] {
  if (!gitCommonDir || entries.length === 0) return [];
  const infoDir = path.join(gitCommonDir, 'info');
  fs.mkdirSync(infoDir, { recursive: true });
  const excludePath = path.join(infoDir, 'exclude');

  const existing = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, 'utf8')
    : '';

  const blockLines = [EXCLUDE_START, ...entries, EXCLUDE_END].join('\n');
  const sIdx = existing.indexOf(EXCLUDE_START);
  const eIdx = existing.indexOf(EXCLUDE_END);

  let updated: string;
  if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
    const before = existing.slice(0, sIdx).trimEnd();
    const after = existing.slice(eIdx + EXCLUDE_END.length).trimStart();
    updated = [before, blockLines, after].filter(Boolean).join('\n\n') + '\n';
  } else {
    const trimmed = existing.trimEnd();
    updated = trimmed ? `${trimmed}\n\n${blockLines}\n` : `${blockLines}\n`;
  }

  fs.writeFileSync(excludePath, updated, 'utf8');
  return entries;
}

export function writeIdeBridges(
  engine: LocusEngine,
  options: {
    projectPath?: string;
    targets?: IdeBridgeTarget[];
    maxTokens?: number;
    shared?: boolean;
  } = {},
): BridgeWriteResult {
  const { project, git } = engine.ensureProject(options.projectPath ?? process.cwd());
  const existingConfig = loadProjectConfig(git.repoRoot);

  const targets =
    options.targets ??
    existingConfig?.targets ?? ['cursor', 'claude-code', 'agents'];
  const maxTokens = options.maxTokens ?? existingConfig?.maxTokens ?? 850;
  const shared = options.shared ?? existingConfig?.shared ?? false;

  const compiled = compileProjectContext(engine, {
    projectPath: git.repoRoot,
    branch: git.branch,
    maxTokens,
  });

  const writtenFiles: string[] = [];

  // 1. Canonical Handoff File (.locus/HANDOFF.md)
  const handoffPath = path.join(git.repoRoot, '.locus', 'HANDOFF.md');
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  fs.writeFileSync(handoffPath, compiled.markdown, 'utf8');
  writtenFiles.push('.locus/HANDOFF.md');

  // 2. Cursor Rule (.cursor/rules/locus-handoff.mdc)
  if (targets.includes('cursor')) {
    const cursorRulePath = path.join(
      git.repoRoot,
      '.cursor',
      'rules',
      'locus-handoff.mdc',
    );
    fs.mkdirSync(path.dirname(cursorRulePath), { recursive: true });
    fs.writeFileSync(cursorRulePath, compiled.cursorMdc, 'utf8');
    writtenFiles.push('.cursor/rules/locus-handoff.mdc');
  }

  // 3. Claude Code Bridge (CLAUDE.local.md in local mode, CLAUDE.md in shared mode)
  if (targets.includes('claude-code')) {
    const claudeFile = shared ? 'CLAUDE.md' : 'CLAUDE.local.md';
    const claudePath = path.join(git.repoRoot, claudeFile);
    const existingClaude = fs.existsSync(claudePath)
      ? fs.readFileSync(claudePath, 'utf8')
      : '';

    const claudeBlock = [
      '## Locus Active Project Memory',
      'Live cross-IDE handoff state is maintained automatically by Locus in `.locus/HANDOFF.md`:',
      '',
      '@.locus/HANDOFF.md',
    ].join('\n');

    fs.writeFileSync(
      claudePath,
      upsertManagedBlock(existingClaude, claudeBlock),
      'utf8',
    );
    writtenFiles.push(claudeFile);
  }

  // 4. Universal AGENTS.md Bridge (for Codex CLI, OpenCode, Zed, Amp, etc.)
  if (targets.includes('agents')) {
    const agentsPath = path.join(git.repoRoot, 'AGENTS.md');
    const agentsExisted = fs.existsSync(agentsPath);
    const existingAgents = agentsExisted ? fs.readFileSync(agentsPath, 'utf8') : '';

    fs.writeFileSync(
      agentsPath,
      upsertManagedBlock(existingAgents, compiled.markdown),
      'utf8',
    );
    writtenFiles.push('AGENTS.md');
  }

  // 5. Windsurf Rule (.windsurf/rules/locus-handoff.md)
  if (targets.includes('windsurf')) {
    const windsurfPath = path.join(
      git.repoRoot,
      '.windsurf',
      'rules',
      'locus-handoff.md',
    );
    fs.mkdirSync(path.dirname(windsurfPath), { recursive: true });
    fs.writeFileSync(windsurfPath, compiled.markdown, 'utf8');
    writtenFiles.push('.windsurf/rules/locus-handoff.md');
  }

  // 6. Git hygiene (.git/info/exclude) when not in shared mode
  let excludedEntries: string[] = [];
  if (!shared && git.isGitRepo) {
    const toExclude = [
      '.locus/',
      'CLAUDE.local.md',
      '.claude/settings.local.json',
      '.cursor/rules/locus-handoff.mdc',
      '.cursor/mcp.json',
      '.mcp.json',
      '.windsurf/rules/locus-handoff.md',
      'AGENTS.md',
    ];
    excludedEntries = ensureGitLocalExcludes(git.gitCommonDir, toExclude);
  }

  engine.insertTimelineEvent({
    projectId: project.id,
    branch: git.branch,
    sourceIde: 'cli',
    eventType: 'bridge_compiled',
    summary: `Compiled context bridges (${compiled.tokenReport.usedTokens}/${compiled.tokenReport.totalBudget} tokens)`,
    metadata: {
      writtenFiles,
      tokenReport: compiled.tokenReport,
    },
  });

  return {
    compiled,
    writtenFiles,
    excludedEntries,
  };
}

export function initializeProjectBridges(
  engine: LocusEngine,
  options: InitProjectOptions = {},
): {
  projectId: string;
  repoRoot: string;
  configPath: string;
  writtenFiles: string[];
  excludedEntries: string[];
  compiled: CompiledContext;
} {
  const { project, git } = engine.ensureProject(options.projectPath ?? process.cwd());
  const targets = options.targets ?? ['cursor', 'claude-code', 'agents'];
  const maxTokens = options.maxTokens ?? 850;
  const shared = options.shared ?? false;
  const configureMcp = options.configureMcp ?? true;
  const configureHooks = options.configureHooks ?? true;

  const dbPath = engine.db.name;
  const mcpCmd = resolveMcpServerCommand(git.repoRoot, options.cliEntryPath, dbPath);

  const config: LocusProjectConfig = {
    version: 1,
    projectId: project.id,
    targets,
    maxTokens,
    shared,
    mcpCommand: {
      command: mcpCmd.command,
      args: mcpCmd.args,
    },
  };

  const configPath = saveProjectConfig(git.repoRoot, config);
  const extraWritten: string[] = ['.locus/config.json'];

  // Non-destructively register MCP server for Cursor & Claude Code
  if (configureMcp) {
    if (targets.includes('cursor')) {
      const cursorMcpPath = path.join(git.repoRoot, '.cursor', 'mcp.json');
      const existing = readJsonSafe(cursorMcpPath);
      const servers =
        existing.mcpServers && typeof existing.mcpServers === 'object'
          ? (existing.mcpServers as Record<string, unknown>)
          : {};
      servers.locus = mcpCmd;
      existing.mcpServers = servers;
      writeJsonPretty(cursorMcpPath, existing);
      extraWritten.push('.cursor/mcp.json');
    }

    if (targets.includes('claude-code')) {
      const claudeMcpPath = path.join(git.repoRoot, '.mcp.json');
      const existing = readJsonSafe(claudeMcpPath);
      const servers =
        existing.mcpServers && typeof existing.mcpServers === 'object'
          ? (existing.mcpServers as Record<string, unknown>)
          : {};
      servers.locus = mcpCmd;
      existing.mcpServers = servers;
      writeJsonPretty(claudeMcpPath, existing);
      extraWritten.push('.mcp.json');
    }
  }

  // Non-destructively wire Claude Code lifecycle hooks in .claude/settings.local.json
  if (configureHooks && targets.includes('claude-code')) {
    const settingsPath = path.join(git.repoRoot, '.claude', 'settings.local.json');
    const existing = readJsonSafe(settingsPath);
    const hooksObj =
      existing.hooks && typeof existing.hooks === 'object'
        ? (existing.hooks as Record<string, unknown[]>)
        : {};

    const hookRunnerPrefix =
      options.cliEntryPath && fs.existsSync(options.cliEntryPath)
        ? `"${process.execPath}" "${options.cliEntryPath}"`
        : 'locus';

    const ensureHookEvent = (eventName: string, subcmd: string) => {
      const hookCmd = `${hookRunnerPrefix} hook ${subcmd} --project "${git.repoRoot}"`;
      const currentArr = Array.isArray(hooksObj[eventName])
        ? (hooksObj[eventName] as Array<Record<string, unknown>>)
        : [];
      const alreadyPresent = JSON.stringify(currentArr).includes(`hook ${subcmd}`);
      if (!alreadyPresent) {
        currentArr.push({
          hooks: [
            {
              type: 'command',
              command: hookCmd,
            },
          ],
        });
      }
      hooksObj[eventName] = currentArr;
    };

    ensureHookEvent('Stop', 'stop');
    ensureHookEvent('PreCompact', 'pre-compact');

    existing.hooks = hooksObj;
    writeJsonPretty(settingsPath, existing);
    extraWritten.push('.claude/settings.local.json');
  }

  engine.insertTimelineEvent({
    projectId: project.id,
    branch: git.branch,
    sourceIde: 'cli',
    eventType: 'init',
    summary: `Initialized Locus for ${project.name} (targets: ${targets.join(', ')})`,
    metadata: { targets, shared, maxTokens },
  });

  const bridgeRes = writeIdeBridges(engine, {
    projectPath: git.repoRoot,
    targets,
    maxTokens,
    shared,
  });

  return {
    projectId: project.id,
    repoRoot: git.repoRoot,
    configPath,
    writtenFiles: [...extraWritten, ...bridgeRes.writtenFiles],
    excludedEntries: bridgeRes.excludedEntries,
    compiled: bridgeRes.compiled,
  };
}

export function inspectBridgeHealth(projectPath: string): {
  initialized: boolean;
  config: LocusProjectConfig | null;
  files: Array<{ path: string; exists: boolean; sizeBytes: number }>;
} {
  const git = inspectGitRepo(projectPath);
  const config = loadProjectConfig(git.repoRoot);
  const candidatePaths = [
    '.locus/config.json',
    '.locus/HANDOFF.md',
    '.cursor/rules/locus-handoff.mdc',
    '.cursor/mcp.json',
    'CLAUDE.local.md',
    'CLAUDE.md',
    '.mcp.json',
    '.claude/settings.local.json',
    'AGENTS.md',
    '.windsurf/rules/locus-handoff.md',
  ];

  const files = candidatePaths.map((rel) => {
    const abs = path.join(git.repoRoot, rel);
    const exists = fs.existsSync(abs);
    return {
      path: rel,
      exists,
      sizeBytes: exists ? fs.statSync(abs).size : 0,
    };
  });

  return {
    initialized: config !== null,
    config,
    files,
  };
}
