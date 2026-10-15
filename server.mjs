import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { openDb, now } from './db.mjs';

const HOST = process.env.MESH_HOST || '127.0.0.1';
const PORT = Number(process.env.MESH_PORT || 7700);
const TOKEN_FILE = process.env.MESH_TOKEN_FILE || path.join(os.homedir(), '.config', 'opencode-mesh', 'token');

function log(msg) {
  console.log(`[${now()}] ${msg}`);
}

function loadToken() {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  log(`generated new token at ${TOKEN_FILE}`);
  return token;
}

const token = loadToken();
const db = openDb();

function result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function git(args, cwd) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createServer() {
  const server = new McpServer({ name: 'opencode-mesh', version: '1.0.0' });

  server.registerTool('register', {
    description: 'Register (or heartbeat) this opencode instance in the mesh',
    inputSchema: { name: z.string(), role: z.string(), capabilities: z.string().optional() },
  }, ({ name, role, capabilities }) => {
    const t = now();
    db.prepare(`INSERT INTO instances (name, role, capabilities, registered_at, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET role=excluded.role, capabilities=excluded.capabilities, last_seen=excluded.last_seen`)
      .run(name, role, capabilities || '', t, t);
    return result({ ok: true, name, role });
  });

  server.registerTool('who', {
    description: 'List mesh instances seen in the last 10 minutes',
  }, () => {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const rows = db.prepare('SELECT * FROM instances WHERE last_seen >= ? ORDER BY name').all(cutoff);
    return result(rows);
  });

  server.registerTool('task_create', {
    description: 'Create a task. deps = task ids that must be done first.',
    inputSchema: {
      title: z.string(), details: z.string().optional(), created_by: z.string(),
      deps: z.array(z.number()).optional(),
    },
  }, ({ title, details, created_by, deps }) => {
    const t = now();
    const r = db.prepare(`INSERT INTO tasks (title, details, created_by, deps, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(title, details || '', created_by, JSON.stringify(deps || []), t, t);
    return result({ id: Number(r.lastInsertRowid), title });
  });

  server.registerTool('task_claim', {
    description: 'Atomically claim the oldest open task whose deps are all done',
    inputSchema: { name: z.string() },
  }, ({ name }) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const open = db.prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY id").all();
      const doneStmt = db.prepare("SELECT status FROM tasks WHERE id = ?");
      let claimed = null;
      for (const task of open) {
        const deps = JSON.parse(task.deps || '[]');
        const blocked = deps.some(d => doneStmt.get(d)?.status !== 'done');
        if (blocked) continue;
        const r = db.prepare("UPDATE tasks SET status='claimed', claimed_by=?, updated_at=? WHERE id=? AND status='open'")
          .run(name, now(), task.id);
        if (r.changes === 1) { claimed = { ...task, status: 'claimed', claimed_by: name }; break; }
      }
      db.exec('COMMIT');
      return result(claimed || { message: 'no tasks available' });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  server.registerTool('task_update', {
    description: 'Mark a task done/failed (claimant only) or release it back to open',
    inputSchema: {
      id: z.number(), name: z.string(),
      status: z.enum(['done', 'failed', 'open']), note: z.string().optional(),
    },
  }, ({ id, name, status, note }) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!task) return result({ error: `task ${id} not found` });
    if (task.claimed_by !== name) return result({ error: `task ${id} is claimed by ${task.claimed_by}, not ${name}` });
    const claimedBy = status === 'open' ? null : task.claimed_by;
    db.prepare('UPDATE tasks SET status=?, claimed_by=?, note=COALESCE(?, note), updated_at=? WHERE id=?')
      .run(status, claimedBy, note ?? null, now(), id);
    return result({ ok: true, id, status });
  });

  server.registerTool('task_list', {
    description: 'List tasks, optionally filtered by status',
    inputSchema: { status: z.enum(['open', 'claimed', 'done', 'failed']).optional() },
  }, ({ status }) => {
    const rows = status
      ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id').all(status)
      : db.prepare('SELECT * FROM tasks ORDER BY id').all();
    return result(rows);
  });

  server.registerTool('note_write', {
    description: 'Write a shared-memory note',
    inputSchema: { topic: z.string(), content: z.string(), author: z.string(), tags: z.string().optional() },
  }, ({ topic, content, author, tags }) => {
    const r = db.prepare('INSERT INTO notes (topic, content, tags, author, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(topic, content, tags || '', author, now());
    return result({ id: Number(r.lastInsertRowid), topic });
  });

  server.registerTool('note_search', {
    description: 'Search notes by topic/content/tags (LIKE)',
    inputSchema: { query: z.string() },
  }, ({ query }) => {
    const q = `%${query}%`;
    const rows = db.prepare('SELECT * FROM notes WHERE topic LIKE ? OR content LIKE ? OR tags LIKE ? ORDER BY id DESC LIMIT 50')
      .all(q, q, q);
    return result(rows);
  });

  server.registerTool('msg_send', {
    description: 'Send a direct message to another instance',
    inputSchema: { sender: z.string(), recipient: z.string(), body: z.string() },
  }, ({ sender, recipient, body }) => {
    const r = db.prepare('INSERT INTO messages (sender, recipient, body, created_at) VALUES (?, ?, ?, ?)')
      .run(sender, recipient, body, now());
    return result({ id: Number(r.lastInsertRowid) });
  });

  server.registerTool('msg_broadcast', {
    description: 'Broadcast a message to all instances',
    inputSchema: { sender: z.string(), body: z.string() },
  }, ({ sender, body }) => {
    const r = db.prepare('INSERT INTO messages (sender, recipient, body, created_at) VALUES (?, NULL, ?, ?)')
      .run(sender, body, now());
    return result({ id: Number(r.lastInsertRowid) });
  });

  server.registerTool('msg_inbox', {
    description: 'Fetch unread messages (direct + broadcast) for an instance and mark them read',
    inputSchema: { name: z.string() },
  }, ({ name }) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare('SELECT * FROM messages WHERE read = 0 AND (recipient = ? OR recipient IS NULL) ORDER BY id').all(name);
      if (rows.length) {
        const mark = db.prepare('UPDATE messages SET read = 1 WHERE id = ?');
        for (const m of rows) mark.run(m.id);
      }
      db.exec('COMMIT');
      return result(rows);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  server.registerTool('review_request', {
    description: 'Request a code review',
    inputSchema: { what: z.string(), ref: z.string().optional(), requested_by: z.string() },
  }, ({ what, ref, requested_by }) => {
    const t = now();
    const r = db.prepare('INSERT INTO reviews (what, ref, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(what, ref || '', requested_by, t, t);
    return result({ id: Number(r.lastInsertRowid), status: 'pending' });
  });

  server.registerTool('review_submit', {
    description: 'Submit a review verdict',
    inputSchema: {
      id: z.number(), reviewer: z.string(),
      verdict: z.enum(['approved', 'changes_requested']), comments: z.string().optional(),
    },
  }, ({ id, reviewer, verdict, comments }) => {
    const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
    if (!review) return result({ error: `review ${id} not found` });
    db.prepare('UPDATE reviews SET status=?, reviewer=?, comments=?, updated_at=? WHERE id=?')
      .run(verdict, reviewer, comments || '', now(), id);
    return result({ ok: true, id, status: verdict });
  });

  server.registerTool('mr_open', {
    description: 'Open a merge request for a local git branch; auto-creates a linked pending review',
    inputSchema: {
      repo_path: z.string(), branch: z.string(), title: z.string(),
      author: z.string(), base_branch: z.string().optional(),
    },
  }, ({ repo_path, branch, title, author, base_branch }) => {
    try {
      git(['rev-parse', '--verify', branch], repo_path);
    } catch {
      return result({ error: `branch '${branch}' not found in ${repo_path}` });
    }
    let base = base_branch;
    if (!base) {
      try {
        base = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo_path);
      } catch {
        return result({ error: `could not determine base branch in ${repo_path}` });
      }
    }
    const t = now();
    const rev = db.prepare('INSERT INTO reviews (what, ref, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(`MR: ${title}`, `${repo_path}#${branch}`, author, t, t);
    const reviewId = Number(rev.lastInsertRowid);
    const mr = db.prepare(`INSERT INTO mrs (repo_path, branch, base_branch, title, author, review_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(repo_path, branch, base, title, author, reviewId, t, t);
    return result({ mr_id: Number(mr.lastInsertRowid), review_id: reviewId, base_branch: base });
  });

  server.registerTool('mr_merge', {
    description: 'Merge an MR locally (git merge --no-ff) once its linked review is approved',
    inputSchema: { id: z.number(), name: z.string() },
  }, ({ id, name }) => {
    const mr = db.prepare('SELECT * FROM mrs WHERE id = ?').get(id);
    if (!mr) return result({ error: `mr ${id} not found` });
    if (mr.status !== 'open') return result({ error: `mr ${id} is ${mr.status}, not open` });
    const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(mr.review_id);
    if (!review || review.status !== 'approved') {
      return result({ error: `mr ${id} cannot merge: linked review ${mr.review_id} is ${review ? review.status : 'missing'} (needs approved)` });
    }
    const repo = mr.repo_path;
    try {
      git(['checkout', mr.base_branch], repo);
      git(['merge', '--no-ff', '-m', `Merge branch '${mr.branch}' (mesh MR #${id}, merged by ${name})`, mr.branch], repo);
    } catch (e) {
      try { git(['merge', '--abort'], repo); } catch { /* no merge in progress */ }
      db.prepare("UPDATE mrs SET status='conflict', updated_at=? WHERE id=?").run(now(), id);
      return result({ error: `merge conflict merging ${mr.branch} into ${mr.base_branch}`, detail: String(e.stderr || e.message), mr_status: 'conflict' });
    }
    db.prepare("UPDATE mrs SET status='merged', updated_at=? WHERE id=?").run(now(), id);
    let prNote = null;
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const remotes = git(['remote', '-v'], repo);
      if (remotes.includes('github.com')) {
        prNote = 'github remote detected and gh is authed: a PR could be opened for upstream review';
      }
    } catch { /* gh unavailable or not authed; local merge is the default path */ }
    return result({ ok: true, id, status: 'merged', branch: mr.branch, base_branch: mr.base_branch, note: prNote });
  });

  server.registerTool('mr_list', {
    description: 'List merge requests',
  }, () => {
    return result(db.prepare('SELECT * FROM mrs ORDER BY id').all());
  });

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    log(`401 ${req.method} ${url.pathname} from ${req.socket.remoteAddress}`);
    return;
  }
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    log(`error handling ${req.method} ${url.pathname}: ${e.stack || e}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  }
});

httpServer.listen(PORT, HOST, () => log(`meshd listening on http://${HOST}:${PORT}/mcp (db: ${process.env.MESH_DB || 'default'})`));

function shutdown(sig) {
  log(`${sig} received, shutting down`);
  httpServer.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
