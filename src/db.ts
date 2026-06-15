import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'spmove.db'));

db.exec("PRAGMA journal_mode = WAL;");

db.exec("PRAGMA foreign_keys = ON;");

// migration: add station column if missing
try { db.exec("ALTER TABLE reports ADD COLUMN station TEXT;"); } catch { /* already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    line_num    TEXT    NOT NULL,
    device_id   TEXT    NOT NULL,
    category    TEXT    NOT NULL,
    description TEXT,
    image_b64   TEXT,
    net_votes   INTEGER NOT NULL DEFAULT 0,
    promoted    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS report_votes (
    report_id INTEGER NOT NULL,
    device_id TEXT    NOT NULL,
    vote      INTEGER NOT NULL,
    PRIMARY KEY (report_id, device_id),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    token         TEXT    PRIMARY KEY,
    registered_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS line_subscriptions (
    token    TEXT NOT NULL REFERENCES devices(token) ON DELETE CASCADE,
    line_num TEXT NOT NULL,
    PRIMARY KEY (token, line_num)
  );

  CREATE TABLE IF NOT EXISTS prev_status (
    line_num   TEXT    PRIMARY KEY,
    status     TEXT    NOT NULL,
    note       TEXT,
    updated_at INTEGER NOT NULL
  );
`);

export default db;
