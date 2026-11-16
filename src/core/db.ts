import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveDefaultDbPath(): string {
  if (process.env.LOCUS_DB_PATH) {
    return path.resolve(process.env.LOCUS_DB_PATH);
  }
  const homeDir = process.env.LOCUS_HOME
    ? path.resolve(process.env.LOCUS_HOME)
    : path.join(os.homedir(), '.locus');
  return path.join(homeDir, 'locus.db');
}

export function openLocusDatabase(dbPath?: string): Database.Database {
  const target = dbPath ?? resolveDefaultDbPath();
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }

  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const currentVersion =
    (
      db
        .prepare('SELECT MAX(version) AS v FROM schema_migrations')
        .get() as { v: number | null } | undefined
    )?.v ?? 0;

  if (currentVersion < 1) {
    const migrateV1 = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          git_common_dir TEXT,
          default_branch TEXT NOT NULL DEFAULT 'main',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_projects_root_path ON projects(root_path);
        CREATE INDEX IF NOT EXISTS idx_projects_git_common_dir ON projects(git_common_dir);

        CREATE TABLE IF NOT EXISTS handoffs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          branch TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          objective TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          active_hypothesis TEXT NOT NULL DEFAULT '',
          tasks_json TEXT NOT NULL DEFAULT '[]',
          blockers_json TEXT NOT NULL DEFAULT '[]',
          next_steps_json TEXT NOT NULL DEFAULT '[]',
          active_files_json TEXT NOT NULL DEFAULT '[]',
          head_sha TEXT,
          dirty_signature TEXT,
          last_ide TEXT NOT NULL DEFAULT 'cli',
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, branch)
        );

        CREATE INDEX IF NOT EXISTS idx_handoffs_project_branch
          ON handoffs(project_id, branch);

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          branch TEXT,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          body TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          related_files_json TEXT NOT NULL DEFAULT '[]',
          source_urls_json TEXT NOT NULL DEFAULT '[]',
          anchor_commit TEXT,
          source_ide TEXT NOT NULL DEFAULT 'cli',
          status TEXT NOT NULL DEFAULT 'active',
          superseded_by TEXT,
          pinned INTEGER NOT NULL DEFAULT 0,
          embedding BLOB,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memories_project_kind_status
          ON memories(project_id, kind, status, updated_at DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          memory_id UNINDEXED,
          project_id UNINDEXED,
          title,
          summary,
          body,
          tags,
          related_files,
          tokenize = 'porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS trg_memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(memory_id, project_id, title, summary, body, tags, related_files)
          VALUES (
            NEW.id,
            NEW.project_id,
            NEW.title,
            NEW.summary,
            NEW.body,
            NEW.tags_json,
            NEW.related_files_json
          );
        END;

        CREATE TRIGGER IF NOT EXISTS trg_memories_au AFTER UPDATE ON memories BEGIN
          DELETE FROM memories_fts WHERE memory_id = OLD.id;
          INSERT INTO memories_fts(memory_id, project_id, title, summary, body, tags, related_files)
          VALUES (
            NEW.id,
            NEW.project_id,
            NEW.title,
            NEW.summary,
            NEW.body,
            NEW.tags_json,
            NEW.related_files_json
          );
        END;

        CREATE TRIGGER IF NOT EXISTS trg_memories_ad AFTER DELETE ON memories BEGIN
          DELETE FROM memories_fts WHERE memory_id = OLD.id;
        END;

        CREATE TABLE IF NOT EXISTS timeline_events (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          branch TEXT,
          source_ide TEXT NOT NULL,
          event_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_timeline_project_created
          ON timeline_events(project_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS harvester_cursors (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          source TEXT NOT NULL,
          cursor_value TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, source)
        );
      `);

      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(1, new Date().toISOString());
    });

    migrateV1();
  }
}
