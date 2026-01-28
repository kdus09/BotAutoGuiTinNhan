const Database = require("better-sqlite3");

const db = new Database("data.sqlite");
db.pragma("journal_mode = WAL");

// 1) Create tables (safe)
db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  chat_id INTEGER PRIMARY KEY,
  title TEXT,
  username TEXT,
  type TEXT,
  added_at INTEGER
);

CREATE TABLE IF NOT EXISTS drafts (
  user_id INTEGER PRIMARY KEY,
  from_chat_id INTEGER,
  message_id INTEGER,
  mode TEXT,
  target_chat_id INTEGER,
  run_at INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  from_chat_id INTEGER,
  message_id INTEGER,
  mode TEXT,
  target_chat_id INTEGER,
  run_at INTEGER,
  status TEXT,
  error TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS admins (
  user_id INTEGER PRIMARY KEY,
  role TEXT,
  added_at INTEGER
);
`);

// 2) Safe add columns (no duplicate errors)
function hasColumn(table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === col);
}

function addColumnIfMissing(table, col, typeSql) {
  if (!hasColumn(table, col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typeSql}`);
  }
}

// Add new columns to jobs
addColumnIfMissing("jobs", "repeat", "TEXT");          // none|daily|weekly
addColumnIfMissing("jobs", "delete_after", "INTEGER"); // ms

module.exports = { db };
