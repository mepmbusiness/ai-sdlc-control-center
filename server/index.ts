// Local HTTP server for the Control Center. Binds to 127.0.0.1 only.

import http from 'node:http';
import { promises as fs, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as engine from './engine.ts';
import * as store from './store.ts';
import * as runner from './runner.ts';
import { cliStatus } from './clis.ts';

const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';
const WEB = path.join(store.TOOL_ROOT, 'web');
const STATIC: Record<string, [string, string]> = {
  '/': [path.join(WEB, 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(WEB, 'app.js'), 'text/javascript; charset=utf-8'],
  '/styles.css': [path.join(WEB, 'styles.css'), 'text/css; charset=utf-8'],
  '/vendor/marked.js': [path.join(store.TOOL_ROOT, 'node_modules/marked/lib/marked.esm.js'), 'text/javascript; charset=utf-8'],
};

const now = () => new Date().toISOString();

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new HttpError(413, 'Request too large.');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'Body must be JSON.');
  }
}

// Blocks other websites from driving this local server through the browser:
// the Host header must be local (DNS rebinding), and state-changing requests
// must be JSON from this origin (a cross-site page cannot send that without a
// CORS preflight, which this server never approves).
function guard(req: http.IncomingMessage) {
  const allowed = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (!allowed.includes(req.headers.host ?? '')) throw new HttpError(403, 'Unexpected Host header.');
  if (req.method === 'POST') {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new HttpError(415, 'Requests must be JSON.');
    }
    const origin = req.headers.origin;
    if (origin && !allowed.map((h) => `http://${h}`).includes(origin)) throw new HttpError(403, 'Cross-origin request refused.');
  }
}

function requireWorkspace(): string {
  const ws = store.activeWorkspace();
  if (!ws) throw new HttpError(409, 'No product yet. Create one first.');
  return ws;
}

async function artifactList(ws: string, wf: engine.Workflow, state: engine.WorkflowState) {
  const list: Record<string, unknown>[] = [];
  const add = (rel: string, stage: engine.StageDef, createdBy: string) => {
    if (rel.endsWith('/')) return;
    const full = store.safeJoin(ws, rel);
    const exists = existsSync(full);
    list.push({
      path: rel,
      stage: stage.id,
      stageLabel: stage.label,
      createdBy,
      exists,
      updatedAt: exists ? statSync(full).mtime.toISOString() : null,
      status: state.stages[stage.id].status,
    });
  };
  for (const def of wf.stages) {
    const by = def.agent ? `${wf.agents[def.agent].label} (${wf.agents[def.agent].tool})` : 'Human';
    for (const out of def.outputs ?? []) add(out, def, by);
    if (def.kind === 'gate' && def.check) {
      const critic = wf.agents[def.check.agent];
      add(`workflow/checks/${def.id}.md`, def, `${critic.label} (${critic.tool})`);
    }
  }
  return list;
}

async function overview() {
  const ws = store.activeWorkspace();
  const clis = await cliStatus();
  if (!ws) return { project: null, clis };
  const [wf, state, git] = await Promise.all([store.loadWorkflow(ws), store.loadState(ws), store.gitInfo(ws)]);
  const contracts: Record<string, unknown> = {};
  for (const id of Object.keys(wf.agents)) {
    try {
      contracts[id] = (await store.loadContract(ws, id)).meta;
    } catch {
      contracts[id] = null;
    }
  }
  return {
    project: state.project,
    workspace: path.relative(store.TOOL_ROOT, ws),
    workflow: wf,
    state,
    contracts,
    git,
    clis,
    artifacts: await artifactList(ws, wf, state),
  };
}

async function decide(gateId: string, body: Record<string, unknown>) {
  const ws = requireWorkspace();
  const decision = body.decision === 'APPROVED' ? 'APPROVED' : body.decision === 'REJECTED' ? 'REJECTED' : null;
  if (!decision) throw new HttpError(400, 'decision must be APPROVED or REJECTED.');
  const feedback = typeof body.feedback === 'string' ? body.feedback : null;

  return store.withLock(async () => {
    const wf = await store.loadWorkflow(ws);
    let state = await store.loadState(ws);
    const gate = engine.stageDef(wf, gateId);
    const ts = now();
    state = engine.decideGate(state, wf, gateId, decision, feedback, ts);
    await store.saveState(ws, state);
    const reviewed = engine.stageDef(wf, gate.reviews!);
    // The hash pins exactly which version of each artifact the human decided on.
    const artifacts = [];
    for (const rel of reviewed.outputs ?? []) {
      const content = await store.readText(ws, rel);
      artifacts.push({ path: rel, sha256: content === null ? null : createHash('sha256').update(content).digest('hex') });
    }
    const record = {
      gate: gateId,
      decision,
      feedback: state.stages[gateId].decision!.feedback,
      decidedAt: ts,
      artifacts,
      artifactRunId: state.stages[gateId].decision!.artifactRunId,
      check: state.stages[gateId].check,
    };
    await store.appendApproval(ws, gateId, record);
    await store.appendActivity(ws, {
      ts, actor: 'human', event: decision === 'APPROVED' ? 'gate_approved' : 'gate_rejected', stage: gateId,
      result: decision, feedback: record.feedback, inputs: reviewed.outputs,
      message: `Human ${decision === 'APPROVED' ? 'approved' : 'rejected'} ${gate.label}${record.feedback ? `: "${record.feedback}"` : ''}`,
    });

    let commit: string | null = null;
    if (decision === 'APPROVED') {
      const next = engine.stageDef(wf, gate.next!);
      commit = await store.commitAll(
        ws,
        `Approve ${reviewed.label}\n\nA human approved ${reviewed.outputs!.join(', ')} ` +
          `(run ${record.artifactRunId}), unlocking ${next.label}. Checkpoint so later reviews diff against an approved baseline.`,
      );
      await store.appendActivity(ws, {
        ts: now(), actor: 'system', event: 'checkpoint_commit', stage: gateId,
        message: commit ? `Checkpoint commit ${commit}` : 'Nothing new to commit',
      });
    }
    return { state, commit };
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(await fs.readFile(file));
    return;
  }
  if (!p.startsWith('/api/')) throw new HttpError(404, 'Not found.');

  if (req.method === 'GET') {
    if (p === '/api/overview') return send(res, 200, await overview());
    if (p === '/api/activity') return send(res, 200, await store.readActivity(requireWorkspace()));
    if (p === '/api/artifact') {
      const ws = requireWorkspace();
      const rel = url.searchParams.get('path') ?? '';
      if (!/\.(md|json|html|log)$/.test(rel)) throw new HttpError(400, "Only Markdown, JSON, HTML and log files can be viewed.");
      try {
        store.safeJoin(ws, rel);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const content = await store.readText(ws, rel);
      if (content === null) throw new HttpError(404, `${rel} does not exist yet.`);
      return send(res, 200, { path: rel, content });
    }
    if (p === '/api/preflight') {
      const ws = requireWorkspace();
      const purpose = url.searchParams.get('purpose') === 'check' ? 'check' : 'produce';
      const [wf, state] = await Promise.all([store.loadWorkflow(ws), store.loadState(ws)]);
      return send(res, 200, await runner.preflight(ws, wf, state, url.searchParams.get('stage') ?? '', purpose));
    }
    const log = p.match(/^\/api\/runs\/([\w-]+)\/log$/);
    if (log) return send(res, 200, await runner.readRunLog(requireWorkspace(), log[1]));
    throw new HttpError(404, 'Not found.');
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (p === '/api/products') {
      const name = String(body.name ?? '').trim();
      const idea = String(body.idea ?? '').trim();
      if (!name || !idea) throw new HttpError(400, 'Product name and idea are required.');
      if (store.activeWorkspace()) throw new HttpError(409, 'This version manages one product at a time.');
      const ws = await store.createWorkspace(
        { name, idea, context: String(body.context ?? '') },
        (wf, project) => engine.initialState(wf, project, now()),
        now(),
      );
      return send(res, 201, { workspace: path.relative(store.TOOL_ROOT, ws) });
    }
    let m = p.match(/^\/api\/stages\/([\w-]+)\/run$/);
    if (m) {
      const ws = requireWorkspace();
      const runId = await store.withLock(() => runner.startProduce(ws, m![1]));
      return send(res, 202, { runId });
    }
    m = p.match(/^\/api\/gates\/([\w-]+)\/check$/);
    if (m) {
      const ws = requireWorkspace();
      const runId = await store.withLock(() => runner.startCheck(ws, m![1]));
      return send(res, 202, { runId });
    }
    m = p.match(/^\/api\/gates\/([\w-]+)\/decision$/);
    if (m) return send(res, 200, await decide(m[1], body));
    m = p.match(/^\/api\/stages\/([\w-]+)\/unblock$/);
    if (m) {
      const ws = requireWorkspace();
      const state = await store.withLock(async () => {
        const wf = await store.loadWorkflow(ws);
        const next = engine.unblock(await store.loadState(ws), wf, m![1], now());
        await store.saveState(ws, next);
        await store.appendActivity(ws, { ts: now(), actor: 'human', event: 'stage_unblocked', stage: m![1], message: `Human unblocked ${engine.stageDef(wf, m![1]).label}` });
        return next;
      });
      return send(res, 200, { state });
    }
    m = p.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
    if (m) {
      if (!runner.cancelRun(m[1])) throw new HttpError(404, 'That run is not active.');
      return send(res, 202, { cancelled: m[1] });
    }
  }
  throw new HttpError(404, 'Not found.');
}

async function recoverInterruptedRun() {
  const ws = store.activeWorkspace();
  if (!ws) return;
  const state = await store.loadState(ws);
  if (!state.activeRun) return;
  const wf = await store.loadWorkflow(ws);
  const reason = 'The Control Center restarted while this agent was running, so the run was lost. Run it again.';
  await store.saveState(ws, engine.interruptActiveRun(state, wf, reason, now()));
  await store.appendActivity(ws, {
    ts: now(), actor: 'system', event: 'run_interrupted', stage: state.activeRun.stageId, runId: state.activeRun.runId,
    agent: state.activeRun.agent, result: 'FAIL', blockers: [reason], message: reason,
  });
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => guard(req))
    .then(() => route(req, res))
    .catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof engine.EngineError ? 409 : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: (err as Error).message, code: (err as engine.EngineError).code });
    });
});

await recoverInterruptedRun();
server.listen(PORT, HOST, () => {
  console.log(`AI SDLC Control Center running at http://localhost:${PORT}`);
});
