import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as schema from './schema';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(path.join(DATA_DIR, 'spmove.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    line_num    TEXT    NOT NULL,
    device_id   TEXT    NOT NULL,
    category    TEXT    NOT NULL,
    station     TEXT,
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

// Safe migration for databases created before station column was added
try { sqlite.exec('ALTER TABLE reports ADD COLUMN station TEXT'); } catch { /* already exists */ }

export const db = drizzle(sqlite, { schema });
