#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, dataDir } from './db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = dataDir();
const PID_FILE = path.join(DIR, 'meshd.pid');
const LOG_FILE = path.join(DIR, 'meshd.log');
const TUNNEL_LOG = path.join(DIR, 'tunnel.log');
const WORKERS_DIR = path.join(DIR, 'workers');
const HOST = process.env.MESH_HOST || '127.0.0.1';
const PORT = Number(process.env.MESH_PORT || 7700);
const TOKEN_FILE = process.env.MESH_TOKEN_FILE || path.join(os.homedir(), '.config', 'opencode-mesh', 'token');
const OPENCODE = '/home/cortix/.opencode/bin/opencode';

function readToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function portReachable() {
  try {
    const r = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

function openLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return fs.openSync(file, 'a');
}

function detach(file, cmd, args, opts = {}) {
  const fd = openLog(file);
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd], ...opts });
  child.unref();
  fs.closeSync(fd);
  return child;
}

function print(rows) {
  if (!rows.length) { console.log('(none)'); return; }
  for (const r of rows) console.log(JSON.stringify(r));
}

async function cmdStart() {
  if (fs.existsSync(PID_FILE)) {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (pidAlive(pid)) { console.log(`meshd already running (pid ${pid})`); return; }
  }
  fs.mkdirSync(DIR, { recursive: true });
  const child = detach(LOG_FILE, process.execPath, [path.join(HERE, 'server.mjs')]);
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`meshd started (pid ${child.pid}), log: ${LOG_FILE}`);
}

async function cmdStop() {
  if (!fs.existsSync(PID_FILE)) { console.log('no pidfile; meshd not running?'); return; }
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  if (pidAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    console.log(`sent SIGTERM to ${pid}`);
  } else {
    console.log(`pid ${pid} not alive`);
  }
  fs.unlinkSync(PID_FILE);
}

async function cmdStatus() {
  const pid = fs.existsSync(PID_FILE) ? Number(fs.readFileSync(PID_FILE, 'utf8').trim()) : null;
  console.log(`pidfile: ${pid ?? 'none'} ${pid && pidAlive(pid) ? '(alive)' : pid ? '(dead)' : ''}`);
  console.log(`port ${HOST}:${PORT}: ${await portReachable() ? 'reachable' : 'unreachable'}`);
  try {
    const db = openDb();
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const rows = db.prepare('SELECT name, role, last_seen FROM instances WHERE last_seen >= ? ORDER BY name').all(cutoff);
    console.log(`instances (last 10 min): ${rows.length}`);
    print(rows);
    db.close();
  } catch (e) {
    console.log(`db: ${e.message}`);
  }
}

function workerPrompt(name, role, extra) {
  return [
    `You are "${name}", a ${role} in the opencode-mesh multi-agent mesh.`,
    'You have MCP tools prefixed mesh_. Follow this loop strictly:',
    `1. Call mesh_register with name="${name}", role="${role}", and your capabilities.`,
    `2. Call mesh_msg_inbox with name="${name}" and mesh_note_search with query="${role}" to pick up context left by other agents.`,
    `3. Loop: call mesh_task_claim with name="${name}". If it returns a task, do the work it describes in the current repository, then call mesh_task_update with the task id, name="${name}", status "done" (or "failed") and a short note. If it returns "no tasks available", call mesh_note_write summarizing what you finished and stop.`,
    'Use mesh_note_write to share anything important you learn. Use mesh_msg_send to talk to specific agents.',
    extra ? `Additional instructions: ${extra}` : '',
  ].filter(Boolean).join(' ');
}

async function cmdSpawn(args) {
  const n = Number(args[0]);
  if (!n || n < 1) { console.error('usage: mesh.mjs spawn <n> [--role worker] [--prompt "text"] [--dir path] [--model provider/id]'); process.exit(1); }
  let role = 'worker', extra = '', dir = process.cwd(), model = 'ollama/qwen3-mesh:4b';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--role') role = args[++i];
    else if (args[i] === '--prompt') extra = args[++i];
    else if (args[i] === '--dir') dir = path.resolve(args[++i]);
    else if (args[i] === '--model') model = args[++i];
  }
  fs.mkdirSync(WORKERS_DIR, { recursive: true });
  for (let i = 0; i < n; i++) {
    const name = `worker-${i + 1}-${crypto.randomBytes(2).toString('hex')}`;
    const log = path.join(WORKERS_DIR, `${name}.log`);
    const child = detach(log, OPENCODE, ['run', '-m', model, workerPrompt(name, role, extra)], { cwd: dir, env: { ...process.env, PWD: dir } });
    console.log(`spawned ${name} (pid ${child.pid}) dir=${dir} log=${log}`);
  }
  console.log('note: workers need a tool-capable model (tool_call: true) to use mesh tools; see README troubleshooting.');
}

async function cmdTunnel() {
  if (!(await portReachable())) { console.error('meshd not reachable; run `node mesh.mjs start` first'); process.exit(1); }
  const token = readToken();
  if (!token) { console.error(`no token at ${TOKEN_FILE}`); process.exit(1); }
  const child = detach(TUNNEL_LOG, 'cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`]);
  console.log(`cloudflared started (pid ${child.pid}), log: ${TUNNEL_LOG}`);
  let url = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const m = fs.readFileSync(TUNNEL_LOG, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { url = m[0]; break; }
    } catch { /* log not written yet */ }
  }
  if (!url) { console.error(`timed out waiting for tunnel URL; check ${TUNNEL_LOG}`); process.exit(1); }
  console.log(`tunnel URL: ${url}`);
  console.log('\nAdd this to ~/.config/opencode/opencode.json under "mcp" on the remote machine:\n');
  console.log(JSON.stringify({
    'mesh': {
      type: 'remote',
      url: `${url}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    },
  }, null, 2));
}

function withDb(fn) {
  const db = openDb();
  try { fn(db); } finally { db.close(); }
}

const commands = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  spawn: cmdSpawn,
  tunnel: cmdTunnel,
  tasks: async () => withDb(db => print(db.prepare('SELECT * FROM tasks ORDER BY id').all())),
  notes: async () => withDb(db => print(db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT 50').all())),
  mrs: async () => withDb(db => print(db.prepare('SELECT * FROM mrs ORDER BY id').all())),
  who: async () => withDb(db => {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    print(db.prepare('SELECT * FROM instances WHERE last_seen >= ? ORDER BY name').all(cutoff));
  }),
  inbox: async (args) => {
    const name = args[0];
    if (!name) { console.error('usage: mesh.mjs inbox <name>'); process.exit(1); }
    withDb(db => print(db.prepare('SELECT * FROM messages WHERE recipient = ? OR recipient IS NULL ORDER BY id DESC LIMIT 50').all(name)));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log(`usage: node mesh.mjs <${Object.keys(commands).join('|')}> [args]`);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd](rest);
