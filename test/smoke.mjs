import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 18701;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-smoke-'));
const DB = path.join(tmp, 'mesh.db');
const TOKEN_FILE = path.join(tmp, 'token');

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) console.log(`PASS ${label}`);
  else { console.log(`FAIL ${label} ${extra}`); failures++; }
}

async function waitForPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

const server = spawn(process.execPath, [new URL('../server.mjs', import.meta.url).pathname], {
  env: { ...process.env, MESH_PORT: String(PORT), MESH_HOST: '127.0.0.1', MESH_DB: DB, MESH_TOKEN_FILE: TOKEN_FILE },
  stdio: ['ignore', fs.openSync(path.join(tmp, 'server.log'), 'a'), fs.openSync(path.join(tmp, 'server.log'), 'a')],
});

let client;
try {
  await waitForPort();
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  check('token file generated', token.length === 64);

  const unauth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('401 without token', unauth.status === 401);

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  client = new Client({ name: 'mesh-smoke', version: '0.0.0' });
  await client.connect(transport);
  check('mcp client connected', true);

  async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name} error: ${r.content?.[0]?.text}`);
    return JSON.parse(r.content[0].text);
  }

  await call('register', { name: 'worker-a', role: 'worker', capabilities: 'code' });
  await call('register', { name: 'worker-b', role: 'reviewer', capabilities: 'review' });
  const who = await call('who');
  check('register + who shows 2 instances', who.length === 2, JSON.stringify(who));

  const t1 = await call('task_create', { title: 'base task', details: 'foundation', created_by: 'smoke' });
  const t2 = await call('task_create', { title: 'blocked task', details: 'needs base', created_by: 'smoke', deps: [t1.id] });
  const t3 = await call('task_create', { title: 'free task', details: 'independent', created_by: 'smoke' });
  check('3 tasks created', t1.id && t2.id && t3.id);

  const c1 = await call('task_claim', { name: 'worker-a' });
  check('first claim gets base task', c1.id === t1.id, JSON.stringify(c1));
  const c2 = await call('task_claim', { name: 'worker-a' });
  check('second claim skips dep-blocked task', c2.id === t3.id, JSON.stringify(c2));
  const c3 = await call('task_claim', { name: 'worker-a' });
  check('third claim finds nothing (dep not done)', c3.message === 'no tasks available', JSON.stringify(c3));

  const bad = await call('task_update', { id: t1.id, name: 'worker-b', status: 'done' });
  check('non-claimant cannot complete task', !!bad.error, JSON.stringify(bad));
  await call('task_update', { id: t1.id, name: 'worker-a', status: 'done', note: 'foundation laid' });
  const c4 = await call('task_claim', { name: 'worker-a' });
  check('claim works after dep done', c4.id === t2.id, JSON.stringify(c4));

  await call('note_write', { topic: 'repo layout', content: 'src/ holds the parser module', author: 'worker-a', tags: 'architecture parser' });
  const notes = await call('note_search', { query: 'parser' });
  check('note write + search', notes.length === 1 && notes[0].topic === 'repo layout', JSON.stringify(notes));

  await call('msg_send', { sender: 'worker-a', recipient: 'worker-b', body: 'please review my branch' });
  await call('msg_broadcast', { sender: 'worker-a', body: 'mesh is up' });
  const inbox = await call('msg_inbox', { name: 'worker-b' });
  check('direct + broadcast in inbox', inbox.length === 2, JSON.stringify(inbox));
  const inbox2 = await call('msg_inbox', { name: 'worker-b' });
  check('inbox empties after read', inbox2.length === 0, JSON.stringify(inbox2));

  const rev = await call('review_request', { what: 'parser patch', ref: 'HEAD', requested_by: 'worker-a' });
  await call('review_submit', { id: rev.id, reviewer: 'worker-b', verdict: 'approved', comments: 'lgtm' });
  check('review request + approve', rev.status === 'pending');

  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  g('init', '-b', 'main');
  g('config', 'user.email', 'smoke@test');
  g('config', 'user.name', 'Smoke');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  g('add', '.');
  g('commit', '-m', 'init');
  g('checkout', '-b', 'mesh/test-1');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'feature\n');
  g('add', '.');
  g('commit', '-m', 'feature work');
  g('checkout', 'main');

  const mr = await call('mr_open', { repo_path: repo, branch: 'mesh/test-1', title: 'add feature', author: 'worker-a' });
  check('mr_open returns mr + review ids, base=main', mr.mr_id && mr.review_id && mr.base_branch === 'main', JSON.stringify(mr));
  await call('review_submit', { id: mr.review_id, reviewer: 'worker-b', verdict: 'approved', comments: 'ok' });
  const merged = await call('mr_merge', { id: mr.mr_id, name: 'worker-b' });
  check('mr_merge succeeds after approval', merged.ok === true, JSON.stringify(merged));
  const merges = g('log', '--merges', '--oneline');
  check('merge commit exists', merges.includes('mesh/test-1'), merges);
  const mrs = await call('mr_list');
  check('mr status is merged', mrs[0]?.status === 'merged', JSON.stringify(mrs));

  g('checkout', '-b', 'mesh/test-2');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'unreviewed\n');
  g('add', '.');
  g('commit', '-m', 'unreviewed work');
  g('checkout', 'main');
  const mr2 = await call('mr_open', { repo_path: repo, branch: 'mesh/test-2', title: 'unreviewed', author: 'worker-a' });
  const denied = await call('mr_merge', { id: mr2.mr_id, name: 'worker-b' });
  check('merge without approved review fails', !!denied.error, JSON.stringify(denied));
  const head = g('rev-parse', 'HEAD');
  const head2 = g('rev-parse', 'main');
  check('no half-merge on failure', head === head2);
} catch (e) {
  console.log(`FAIL exception: ${e.stack || e}`);
  failures++;
} finally {
  if (client) await client.close().catch(() => {});
  server.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
