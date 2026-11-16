import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarvestedSessionSummary } from './claude-harvester.js';

function defaultCursorUserDirs(): string[] {
  if (process.env.CURSOR_USER_DIR) {
    return [path.resolve(process.env.CURSOR_USER_DIR)];
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Application Support', 'Cursor', 'User'),
    path.join(home, '.config', 'Cursor', 'User'),
  ];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Cursor', 'User'));
  }
  return candidates.filter((d) => fs.existsSync(d));
}

function normalizeFolderUri(folderUri: string): string | null {
  try {
    if (folderUri.startsWith('file://')) {
      return path.resolve(fileURLToPath(folderUri));
    }
    return path.resolve(folderUri);
  } catch {
    return null;
  }
}

function findWorkspaceVscdb(repoRoot: string, userDirs: string[]): string | null {
  const targetRoot = fs.existsSync(repoRoot)
    ? fs.realpathSync.native(path.resolve(repoRoot))
    : path.resolve(repoRoot);

  for (const userDir of userDirs) {
    const wsStorage = path.join(userDir, 'workspaceStorage');
    if (!fs.existsSync(wsStorage)) continue;

    const subdirs = fs.readdirSync(wsStorage, { withFileTypes: true });
    for (const d of subdirs) {
      if (!d.isDirectory()) continue;
      const wsJsonPath = path.join(wsStorage, d.name, 'workspace.json');
      const vscdbPath = path.join(wsStorage, d.name, 'state.vscdb');
      if (!fs.existsSync(wsJsonPath) || !fs.existsSync(vscdbPath)) continue;

      try {
        const meta = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8')) as {
          folder?: string;
        };
        if (!meta.folder) continue;
        const folderPath = normalizeFolderUri(meta.folder);
        if (!folderPath) continue;
        const realFolder = fs.existsSync(folderPath)
          ? fs.realpathSync.native(folderPath)
          : folderPath;
        if (realFolder === targetRoot) {
          return vscdbPath;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

function parseJsonValue(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function harvestCursorSession(options: {
  repoRoot: string;
  cursorUserDir?: string;
  lastCursor?: string | null;
}): HarvestedSessionSummary | null {
  const userDirs = options.cursorUserDir
    ? [path.resolve(options.cursorUserDir)]
    : defaultCursorUserDirs();

  const vscdbPath = findWorkspaceVscdb(options.repoRoot, userDirs);
  if (!vscdbPath) return null;

  const stat = fs.statSync(vscdbPath);
  const cursorToken = `${path.basename(path.dirname(vscdbPath))}:${Math.floor(stat.mtimeMs)}:${stat.size}`;
  if (options.lastCursor === cursorToken) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(vscdbPath, { readonly: true, fileMustExist: true });

    const tableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'",
      )
      .get();
    if (!tableExists) return null;

    const getKey = (key: string): unknown => {
      const row = db!
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get(key) as { value: unknown } | undefined;
      return row ? parseJsonValue(row.value) : null;
    };

    let latestUserPrompt = '';
    let latestAssistantSummary = '';
    let sessionId = path.basename(path.dirname(vscdbPath));
    const touchedFiles = new Set<string>();

    const recordFileRef = (candidate: unknown) => {
      if (typeof candidate !== 'string' || !candidate.trim()) return;
      let clean = candidate.trim();
      if (clean.startsWith('file://')) {
        clean = normalizeFolderUri(clean) ?? clean;
      }
      const rel = path.isAbsolute(clean)
        ? path.relative(options.repoRoot, clean).replace(/\\/g, '/')
        : clean.replace(/\\/g, '/').replace(/^\.\//, '');
      if (rel && !rel.startsWith('..')) {
        touchedFiles.add(rel);
      }
    };

    // 1. Check composer.composerData
    const composerData = getKey('composer.composerData') as Record<string, unknown> | null;
    if (composerData && Array.isArray(composerData.allComposers)) {
      const composers = [...(composerData.allComposers as Array<Record<string, unknown>>)];
      composers.sort(
        (a, b) =>
          Number(b.lastUpdatedAt ?? b.createdAt ?? 0) -
          Number(a.lastUpdatedAt ?? a.createdAt ?? 0),
      );
      const active = composers[0];
      if (active) {
        if (typeof active.composerId === 'string') sessionId = active.composerId;
        if (typeof active.name === 'string' && active.name.trim()) {
          latestUserPrompt = active.name.trim();
        }
        if (Array.isArray(active.conversation)) {
          for (const bubble of active.conversation as Array<Record<string, unknown>>) {
            const bText =
              (typeof bubble.text === 'string' && bubble.text.trim()) ||
              (typeof bubble.rawText === 'string' && bubble.rawText.trim()) ||
              '';
            const bType = bubble.type;
            // Cursor composer: type 1 or 'user' = user, type 2 or 'ai'/'assistant' = assistant
            if ((bType === 1 || bType === 'user') && bText.length >= 6) {
              latestUserPrompt = bText;
            } else if (
              (bType === 2 || bType === 'ai' || bType === 'assistant') &&
              bText.length >= 10
            ) {
              latestAssistantSummary = bText;
            }

            if (bubble.context && typeof bubble.context === 'object') {
              const ctx = bubble.context as Record<string, unknown>;
              if (Array.isArray(ctx.fileSelections)) {
                for (const sel of ctx.fileSelections as Array<Record<string, unknown>>) {
                  recordFileRef(
                    (sel.uri as Record<string, unknown> | undefined)?.fsPath ??
                      sel.fsPath ??
                      sel.path,
                  );
                }
              }
            }
          }
        }
      }
    }

    // 2. Check workbench.panel.aichat.view.aichat.chatdata
    const chatData = getKey(
      'workbench.panel.aichat.view.aichat.chatdata',
    ) as Record<string, unknown> | null;
    if (chatData && Array.isArray(chatData.tabs)) {
      for (const tab of chatData.tabs as Array<Record<string, unknown>>) {
        if (!Array.isArray(tab.bubbles)) continue;
        for (const bubble of tab.bubbles as Array<Record<string, unknown>>) {
          const bText =
            (typeof bubble.text === 'string' && bubble.text.trim()) ||
            (typeof bubble.rawText === 'string' && bubble.rawText.trim()) ||
            '';
          if (bubble.type === 'user' && bText.length >= 6) {
            latestUserPrompt = bText;
          } else if (
            (bubble.type === 'ai' || bubble.type === 'assistant') &&
            bText.length >= 10
          ) {
            latestAssistantSummary = bText;
          }
          if (Array.isArray(bubble.selections)) {
            for (const sel of bubble.selections as Array<Record<string, unknown>>) {
              recordFileRef(
                (sel.uri as Record<string, unknown> | undefined)?.fsPath ?? sel.filePath,
              );
            }
          }
        }
      }
    }

    // 3. Fallback: aiService.prompts & aiService.generations
    if (!latestUserPrompt) {
      const prompts = getKey('aiService.prompts');
      if (Array.isArray(prompts) && prompts.length > 0) {
        const last = prompts[prompts.length - 1] as Record<string, unknown>;
        const txt = typeof last.text === 'string' ? last.text.trim() : '';
        if (txt) latestUserPrompt = txt;
      }
    }
    if (!latestAssistantSummary) {
      const generations = getKey('aiService.generations');
      if (Array.isArray(generations) && generations.length > 0) {
        const last = generations[generations.length - 1] as Record<string, unknown>;
        const desc =
          typeof last.textDescription === 'string' ? last.textDescription.trim() : '';
        if (desc) latestAssistantSummary = desc;
      }
    }

    if (!latestUserPrompt && !latestAssistantSummary && touchedFiles.size === 0) {
      return null;
    }

    return {
      sourceIde: 'cursor',
      sessionId,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      latestUserPrompt: latestUserPrompt.slice(0, 320),
      latestAssistantSummary: latestAssistantSummary.slice(0, 420),
      touchedFiles: Array.from(touchedFiles).slice(0, 20),
      errors: [],
      cursorToken,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
