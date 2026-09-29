import Database from 'better-sqlite3'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE providers (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT, headers TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE models (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    model TEXT NOT NULL, display_name TEXT NOT NULL, context_window INTEGER, supports_tools INTEGER NOT NULL DEFAULT 1,
    supports_vision INTEGER NOT NULL DEFAULT 0, temperature REAL, max_tokens INTEGER, reasoning_effort TEXT,
    is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, model_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL, command TEXT, args TEXT, env TEXT, url TEXT,
    headers TEXT, enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE connectors (
    id TEXT PRIMARY KEY, connected INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    connected_at INTEGER, error TEXT, custom_def TEXT
  );
  CREATE TABLE plugin_state (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE skill_state (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE macros (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, model_id TEXT, cron TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  );
  CREATE TABLE task_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, thread_id TEXT NOT NULL,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, summary TEXT, error TEXT
  );
  CREATE TABLE traces (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
    input TEXT NOT NULL, output TEXT NOT NULL, duration_ms INTEGER NOT NULL, tokens INTEGER, created_at INTEGER NOT NULL
  );
  CREATE INDEX traces_thread ON traces(thread_id, created_at);
  `,
  `
  CREATE TABLE files (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    kind TEXT, status TEXT NOT NULL, progress TEXT, error TEXT, engine TEXT, title TEXT,
    units INTEGER, unit_label TEXT, chars INTEGER, warnings TEXT, ocr_pages TEXT,
    created_at INTEGER NOT NULL, parsed_at INTEGER
  );
  CREATE INDEX files_sha ON files(sha256);
  `,
  `
  CREATE TABLE memories (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, scope TEXT,
    status TEXT NOT NULL DEFAULT 'active', pinned INTEGER NOT NULL DEFAULT 0,
    source_thread TEXT, source_title TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX memories_status ON memories(status, kind);
  `,
  `
  CREATE TABLE memory_days (
    day TEXT NOT NULL, thread_id TEXT NOT NULL, thread_title TEXT NOT NULL, text TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (day, thread_id)
  );
  `,
]

/** Opens (and migrates) the app database. No Electron imports: also used by the agent process. */
export function openDatabase(path: string): Database.Database {
  const d = new Database(path)
  d.pragma('journal_mode = WAL')
  d.pragma('busy_timeout = 5000')
  d.pragma('foreign_keys = ON')
  const version = d.pragma('user_version', { simple: true }) as number
  for (let i = version; i < MIGRATIONS.length; i++) {
    d.transaction(() => {
      d.exec(MIGRATIONS[i])
      d.pragma(`user_version = ${i + 1}`)
    })()
  }
  return d
}
