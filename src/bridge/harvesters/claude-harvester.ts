import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface HarvestedSessionSummary {
  sourceIde: 'claude-code' | 'cursor';
  sessionId: string;
  updatedAt: string;
  latestUserPrompt: string;
  latestAssistantSummary: string;
  touchedFiles: string[];
  errors: string[];
  cursorToken: string;
}

function defaultClaudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

export function encodeClaudeProjectSlug(repoRoot: string): string {
  return repoRoot.replace(/[^a-zA-Z0-9-]/g, '-');
}

function findClaudeSessionDir(repoRoot: string, projectsBaseDir: string): string | null {
  if (!fs.existsSync(projectsBaseDir)) return null;

  const exactSlug = encodeClaudeProjectSlug(repoRoot);
  const directCandidate = path.join(projectsBaseDir, exactSlug);
  if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).isDirectory()) {
    return directCandidate;
  }

  // Fallback: inspect directories whose JSONL entries have matching `cwd`
  const entries = fs.readdirSync(projectsBaseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(projectsBaseDir, entry.name);
    const jsonlFiles = fs
      .readdirSync(dirPath)
      .filter((f) => f.endsWith('.jsonl'))
      .slice(0, 3);

    for (const jf of jsonlFiles) {
      const head = fs.readFileSync(path.join(dirPath, jf), 'utf8').slice(0, 4096);
      const firstLine = head.split('\n')[0];
      if (!firstLine) continue;
      try {
        const parsed = JSON.parse(firstLine) as { cwd?: string };
        if (parsed.cwd && path.resolve(parsed.cwd) === path.resolve(repoRoot)) {
          return dirPath;
        }
      } catch {
        // Ignore malformed line
      }
    }
  }

  return null;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text.trim());
        }
      }
    }
    return texts.filter(Boolean).join('\n').trim();
  }
  return '';
}

export function harvestClaudeCodeSession(options: {
  repoRoot: string;
  claudeProjectsDir?: string;
  lastCursor?: string | null;
}): HarvestedSessionSummary | null {
  const projectsDir = options.claudeProjectsDir ?? defaultClaudeProjectsDir();
  const sessionDir = findClaudeSessionDir(options.repoRoot, projectsDir);
  if (!sessionDir) return null;

  const files = fs
    .readdirSync(sessionDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(sessionDir, f);
      const stat = fs.statSync(full);
      return { name: f, full, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .filter((f) => f.size > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (files.length === 0) return null;

  const latest = files[0];
  const cursorToken = `${latest.name}:${Math.floor(latest.mtimeMs)}:${latest.size}`;
  if (options.lastCursor === cursorToken) {
    return null;
  }

  const raw = fs.readFileSync(latest.full, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  let latestUserPrompt = '';
  let latestAssistantSummary = '';
  let latestTimestamp = new Date(latest.mtimeMs).toISOString();
  const touchedSet = new Set<string>();
  const errors: string[] = [];

  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof record.timestamp === 'string') {
      latestTimestamp = record.timestamp;
    }

    const msg =
      record.message && typeof record.message === 'object'
        ? (record.message as Record<string, unknown>)
        : null;

    if (record.type === 'user' && msg) {
      const txt = extractTextFromContent(msg.content);
      // Skip internal command wrappers or tiny "ok" acks when looking for task objective
      if (txt && txt.length >= 8 && !txt.startsWith('<command-')) {
        latestUserPrompt = txt;
      }

      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item && typeof item === 'object') {
            const block = item as Record<string, unknown>;
            if (block.type === 'tool_result' && block.is_error === true) {
              const errTxt =
                typeof block.content === 'string'
                  ? block.content
                  : extractTextFromContent(block.content);
              if (errTxt) {
                errors.push(errTxt.replace(/\s+/g, ' ').trim().slice(0, 180));
              }
            }
          }
        }
      }
    } else if (record.type === 'assistant' && msg) {
      const txt = extractTextFromContent(msg.content);
      if (txt && txt.length >= 12) {
        latestAssistantSummary = txt;
      }

      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item && typeof item === 'object') {
            const block = item as Record<string, unknown>;
            if (
              block.type === 'tool_use' &&
              block.input &&
              typeof block.input === 'object'
            ) {
              const inp = block.input as Record<string, unknown>;
              const fp =
                (typeof inp.file_path === 'string' && inp.file_path) ||
                (typeof inp.path === 'string' && inp.path) ||
                '';
              if (fp) {
                const rel = path.isAbsolute(fp)
                  ? path.relative(options.repoRoot, fp).replace(/\\/g, '/')
                  : fp.replace(/\\/g, '/');
                if (!rel.startsWith('..')) {
                  touchedSet.add(rel);
                }
              }
            }
          }
        }
      }
    }
  }

  if (!latestUserPrompt && !latestAssistantSummary && touchedSet.size === 0) {
    return null;
  }

  return {
    sourceIde: 'claude-code',
    sessionId: path.basename(latest.name, '.jsonl'),
    updatedAt: latestTimestamp,
    latestUserPrompt: latestUserPrompt.slice(0, 320),
    latestAssistantSummary: latestAssistantSummary.slice(0, 420),
    touchedFiles: Array.from(touchedSet).slice(0, 20),
    errors: errors.slice(-3),
    cursorToken,
  };
}
