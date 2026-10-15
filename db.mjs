import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function dataDir() {
  return process.env.MESH_DB
    ? path.dirname(process.env.MESH_DB)
    : path.join(os.homedir(), '.local', 'share', 'opencode-mesh');
}

export function defaultDbPath() {
  return process.env.MESH_DB || path.join(dataDir(), 'mesh.db');
}

export function openDb(dbPath = defaultDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      name TEXT PRIMARY KEY,
      role TEXT,
      capabilities TEXT,
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT,
      deps TEXT NOT NULL DEFAULT '[]',
      created_by TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      author TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT,
      recipient TEXT,
      body TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      what TEXT NOT NULL,
      ref TEXT,
      requested_by TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewer TEXT,
      comments TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mrs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      review_id INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

export function now() {
  return new Date().toISOString();
}
