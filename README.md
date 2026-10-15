# opencode-mesh

A coordination system that lets multiple [opencode](https://opencode.ai) CLI instances (AI coding agents) collaborate: parallel task splitting with dependency ordering, shared memory (notes), direct + broadcast messaging, a code review flow, and local git merge requests — all over MCP Streamable HTTP, locally or through a Cloudflare tunnel.

No native dependencies: storage is SQLite via Node's built-in `node:sqlite`; the only npm dep is `@modelcontextprotocol/sdk`.

## Layout

| file | role |
|---|---|
| `server.mjs` | meshd — the MCP-over-HTTP daemon (default `127.0.0.1:7700`, endpoint `/mcp`) |
| `db.mjs` | shared SQLite schema/open logic (imported by server and CLI) |
| `mesh.mjs` | CLI: start/stop/status, spawn workers, tunnel, DB viewers |
| `test/smoke.mjs` | end-to-end smoke test (`npm test`) |

State lives in `~/.local/share/opencode-mesh/` (db, pidfile, logs, worker logs); the auth token in `~/.config/opencode-mesh/token` (auto-generated, mode 0600). Env overrides: `MESH_PORT`, `MESH_HOST`, `MESH_DB`, `MESH_TOKEN_FILE`.

## Quickstart

```bash
cd ~/opencode-mesh
node mesh.mjs start          # start the daemon
node mesh.mjs status         # pid alive? port reachable? who is online?
node mesh.mjs spawn 3 --role worker --dir ~/my-project   # launch 3 headless workers
```

Each spawned worker is a headless `opencode run` process that registers itself as `worker-<n>-<rand>`, checks its inbox and shared notes, then loops `mesh_task_claim` → work → `mesh_task_update`.

Then drive the mesh from an interactive opencode session that has the mesh MCP server configured (see below): create tasks, post notes, request reviews, open and merge MRs.

To let an interactive opencode session use the mesh locally, add under `"mcp"` in `~/.config/opencode/opencode.json` (already installed on this machine as `mesh`):

```json
"mesh": {
  "type": "remote",
  "url": "http://127.0.0.1:7700/mcp",
  "headers": { "Authorization": "Bearer <token from ~/.config/opencode-mesh/token>" }
}
```

Three pre-built agents are installed in `~/.config/opencode/agent/` — `mesh-coordinator` (splits goals into tasks, monitors, merges), `mesh-worker` (claims and executes tasks), `mesh-reviewer` (tests and approves MRs). They default to the local Ollama model because mesh tools require tool calling.

## Typical collaboration flow

1. A lead agent creates tasks: `mesh_task_create` (use `deps` for ordering).
2. Workers claim and complete them: `mesh_task_claim` / `mesh_task_update`.
3. Workers leave findings via `mesh_note_write`; others pick them up with `mesh_note_search`.
4. A worker opens an MR: `mesh_mr_open` (validates the branch, auto-creates a pending review).
5. A reviewer agent approves: `mesh_review_submit` with verdict `approved`.
6. Anyone merges: `mesh_mr_merge` runs `git merge --no-ff` locally; conflicts are aborted cleanly and the MR is marked `conflict`.

## Tool reference

All tools return JSON-stringified content. The MCP server registers them unprefixed (`register`, `task_claim`, ...); opencode exposes every MCP tool as `<server-key>_<tool>`, so with the `mesh` server key agents see and call them as `mesh_register`, `mesh_task_claim`, etc. (the names used below).

| tool | args | purpose |
|---|---|---|
| `mesh_register` | name, role, capabilities? | upsert instance + heartbeat |
| `mesh_who` | — | instances seen in the last 10 min |
| `mesh_task_create` | title, details?, created_by, deps? | create task; deps = task ids that must finish first |
| `mesh_task_claim` | name | atomically claim oldest open task with all deps done |
| `mesh_task_update` | id, name, status, note? | done/failed (claimant only) or release to open |
| `mesh_task_list` | status? | list tasks |
| `mesh_note_write` | topic, content, author, tags? | write shared-memory note |
| `mesh_note_search` | query | LIKE search over topic/content/tags |
| `mesh_msg_send` | sender, recipient, body | direct message |
| `mesh_msg_broadcast` | sender, body | message to all |
| `mesh_msg_inbox` | name | fetch unread direct+broadcast, mark read |
| `mesh_review_request` | what, ref?, requested_by | request a code review |
| `mesh_review_submit` | id, reviewer, verdict, comments? | verdict: `approved` \| `changes_requested` |
| `mesh_mr_open` | repo_path, branch, title, author, base_branch? | open MR (branch validated via git; base defaults to repo HEAD branch); auto-creates linked pending review |
| `mesh_mr_merge` | id, name | local `git merge --no-ff`, only when linked review is approved |
| `mesh_mr_list` | — | list merge requests |

## CLI reference

```
node mesh.mjs start|stop|status
node mesh.mjs spawn <n> [--role worker] [--prompt "extra instructions"] [--dir path] [--model provider/id]
node mesh.mjs tunnel
node mesh.mjs tasks|notes|mrs|who
node mesh.mjs inbox <name>
```

## Remote machines (Cloudflare tunnel)

```bash
node mesh.mjs tunnel
```

This starts a quick `cloudflared` tunnel, waits for the `https://*.trycloudflare.com` URL, and prints a ready-to-paste config block like:

```json
{
  "mesh": {
    "type": "remote",
    "url": "https://random-name.trycloudflare.com/mcp",
    "headers": { "Authorization": "Bearer <real token>" }
  }
}
```

Add that under `"mcp"` in `~/.config/opencode/opencode.json` on the remote machine. All mesh traffic requires the bearer token, which never leaves the token file except into this header.

## Troubleshooting

- **Workers do nothing / never call mesh tools**: mesh tools require a model with `tool_call: true`. The default worker model is `ollama/qwen3-mesh:4b` (a local variant of `qwen3:4b` created with `num_ctx 16384` — Ollama's default 4096-token context truncates the tool list, which makes models ramble about tool calls instead of making them). The GLM provider has `tool_call` disabled, so agents on it cannot use the mesh. Recreate the worker model if needed: `printf 'FROM qwen3:4b\nPARAMETER num_ctx 16384\n' | ollama create qwen3-mesh:4b -f -`
- **Workers exit after one task**: `opencode run` ends when the model stops emitting tool calls. To keep a worker going, respawn it (`node mesh.mjs spawn 1 --dir <repo>`), or run the loop interactively in a persistent session.
- **GitHub PRs**: merging is local by default. `gh auth login` is needed for anything GitHub-related; `mesh_mr_merge` only notes that a PR could be opened when `gh auth status` succeeds and the repo has a github remote.
- **Logs**: daemon log at `~/.local/share/opencode-mesh/meshd.log`, per-worker logs under `~/.local/share/opencode-mesh/workers/`, tunnel log at `~/.local/share/opencode-mesh/tunnel.log`.
- **401 errors**: the token in your MCP config headers must match `~/.config/opencode-mesh/token` on the machine running meshd.
- **Stale daemon**: `node mesh.mjs stop` then `node mesh.mjs start`; `status` reports a dead pidfile if it crashed.

## Test

```bash
npm test
```

Starts meshd on a test port with a temp db/token, exercises the full flow (register, tasks with deps, notes, messages, reviews, real git MR merge, negative merge, 401), and exits non-zero on any failure.
