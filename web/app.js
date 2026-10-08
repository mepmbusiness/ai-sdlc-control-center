import { marked } from '/vendor/marked.js';

// Artifacts are written by AI agents, so treat them as untrusted: raw HTML is
// shown as text and only http(s) or relative links are rendered as links.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
marked.use({
  renderer: {
    html({ text }) {
      return esc(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!/^(https?:|#|\/|\.)/i.test(href ?? '')) return label;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${label}</a>`;
    },
    image({ text }) {
      return esc(text);
    },
  },
});

const STATUS_TEXT = {
  WAITING: 'Waiting',
  READY: 'Ready',
  RUNNING: 'Running',
  PASS: 'Pass',
  FAIL: 'Fail',
  BLOCKED: 'Blocked',
  APPROVAL_REQUIRED: 'Needs approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const ui = {
  data: null,
  activity: [],
  selected: null,
  preflight: {},
  logs: {},
  handoffs: {},
  approvals: {},
  drafts: { feedback: {} },
  errors: {},
  busy: false,
  lastJson: '',
};

// ---------- data ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

async function refresh(force = false) {
  try {
    const data = await api('/api/overview');
    const activity = data.project ? await api('/api/activity') : [];
    const json = JSON.stringify([data, activity]);
    if (force || json !== ui.lastJson) {
      const prevRun = ui.data?.state?.activeRun?.runId;
      ui.lastJson = json;
      ui.data = data;
      ui.activity = activity;
      if (prevRun && prevRun !== data.state?.activeRun?.runId) {
        ui.preflight = {};
        ui.handoffs = {};
        ui.approvals = {};
      }
      render();
    }
    const run = ui.data?.state?.activeRun;
    if (run) await refreshLog(run.runId);
  } catch (e) {
    document.getElementById('app').innerHTML = `<div class="card card-body"><strong>Can't reach the Control Center server.</strong><p class="muted">${esc(e.message)}. Start it with <code>npm start</code> and reload.</p></div>`;
  } finally {
    setTimeout(refresh, ui.data?.state?.activeRun ? 1500 : 4000);
  }
}

async function refreshLog(runId) {
  ui.logs[runId] = await api(`/api/runs/${runId}/log`).catch(() => ui.logs[runId] ?? []);
  const el = document.querySelector(`[data-log="${runId}"]`);
  if (el) {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.innerHTML = logLines(ui.logs[runId]);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
}

async function ensure(cacheKey, store, loader) {
  if (cacheKey in store) return;
  store[cacheKey] = null;
  try {
    store[cacheKey] = await loader();
  } catch (e) {
    store[cacheKey] = { error: e.message };
  }
  render();
}

// ---------- helpers ----------

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const dateTime = (iso) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : 'Not yet';

function owner(def) {
  const { workflow } = ui.data;
  if (def.kind === 'agent') {
    const a = workflow.agents[def.agent];
    return { cls: a.cli, label: a.tool, agent: a.label };
  }
  return { cls: 'human', label: 'You', agent: def.kind === 'gate' ? 'Human approval' : 'Human' };
}

function fileList(paths, artifacts) {
  if (!paths?.length) return '<span class="muted">None</span>';
  return `<ul class="files">${paths
    .map((p) => {
      const a = artifacts.find((x) => x.path === p);
      const exists = a ? a.exists : true;
      return exists && /\.(md|json|html|log)$/.test(p)
        ? `<li><button data-open="${esc(p)}">${esc(p)}</button></li>`
        : `<li class="missing">${esc(p)}${exists ? '' : ' · not yet'}</li>`;
    })
    .join('')}</ul>`;
}

const logLines = (lines) =>
  lines?.length
    ? lines.map((l) => `<div><time>${time(l.ts)}</time><span>${esc(l.msg)}</span></div>`).join('')
    : '<div><time></time><span class="muted">Waiting for the first event…</span></div>';

// ---------- render ----------

function render() {
  renderTopbar();
  const app = document.getElementById('app');
  const focusId = document.activeElement?.id;
  if (!ui.data.project) {
    // Never wipe a half-typed product idea on a background refresh.
    if (!document.getElementById('new-product') || ui.errors.create !== undefined) app.innerHTML = welcome();
  } else {
    const { workflow, state } = ui.data;
    if (!ui.selected || !workflow.stages.some((s) => s.id === ui.selected)) ui.selected = state.currentStage;
    app.innerHTML = [attention(), track(), `<div class="grid-2">${stageDetail()}${activity()}</div>`, artifacts()].join('');
    loadSelectedExtras();
  }
  if (focusId) document.getElementById(focusId)?.focus();
  for (const el of document.querySelectorAll('[data-log]')) el.scrollTop = el.scrollHeight;
}

function renderTopbar() {
  const d = ui.data;
  const cli = (c) => {
    const s = d.clis[c];
    const ok = s.installed && s.loggedIn && s.subscription;
    const name = c === 'claude' ? 'Claude Code' : 'Codex';
    return `<span class="chip" title="${esc(s.detail)}"><span class="dot ${ok ? 'ok' : 'bad'}"></span>${name}${ok ? '' : ' · check setup'}</span>`;
  };
  const run = d.state?.activeRun;
  document.getElementById('topbar').innerHTML = `
    <div class="brand">
      <span class="eyebrow">AI SDLC Control Center</span>
      <h1>${esc(d.project?.name ?? 'No product yet')}</h1>
    </div>
    <div class="meta-row">
      ${run ? `<span class="chip"><span class="dot live"></span>${esc(d.workflow.agents[run.agent].label)} running</span>` : ''}
      ${d.git ? `<span class="chip" title="Latest commit: ${esc(d.git.lastCommit)}">⎇ ${esc(d.git.branch)} · ${d.git.changedFiles} changed</span>` : ''}
      ${cli('claude')}${cli('codex')}
    </div>`;
}

function welcome() {
  const steps = ['Idea', 'Discovery', 'Gate', 'PRD', 'Gate', 'Design', 'Gate', 'Tech', 'Gate', 'Build', 'Review', 'QA', 'Design QA', 'Product review', 'Gate', 'Ship'];
  return `
  <section class="welcome">
    <h2>Start a product.</h2>
    <p class="lede">Describe the idea. Agents will research it, define it, design it and build it, one stage at a time, and every hand-off waits for your approval.</p>
    <div class="mini-track" aria-hidden="true">${steps
      .map((s, i) => `${i ? '<i></i>' : ''}<span class="${s === 'Gate' ? 'g' : ''}">${s}</span>`)
      .join('')}</div>
    <form class="card form" id="new-product">
      <label>Product name <input id="np-name" name="name" required maxlength="80" autocomplete="off" placeholder="e.g. Class makeup scheduler"></label>
      <label>Idea or problem <small>What problem are we solving, for whom?</small>
        <textarea id="np-idea" name="idea" required rows="5"></textarea></label>
      <label>Context <small>Optional. Market, constraints, links, what you already know.</small>
        <textarea id="np-context" name="context" rows="3"></textarea></label>
      <div class="actions"><button class="btn primary" type="submit">Create product</button>
      <span class="muted">Creates <code>product/idea.md</code> and a Git repository for this product.</span></div>
      ${ui.errors.create ? `<p class="error-text">${esc(ui.errors.create)}</p>` : ''}
    </form>
  </section>`;
}

function attention() {
  const { workflow, state } = ui.data;
  const items = [];
  const run = state.activeRun;
  if (run) {
    const def = workflow.stages.find((s) => s.id === run.stageId);
    const a = workflow.agents[run.agent];
    items.push(['running', 'Running', `${a.label} is working on ${def.label}`, `${a.tool} · started ${time(run.startedAt)}`, def.id, 'View progress']);
  }
  for (const def of workflow.stages) {
    const st = state.stages[def.id];
    if (st.status === 'APPROVAL_REQUIRED') {
      const r = workflow.stages.find((s) => s.id === def.reviews);
      const checked = st.check?.status === 'PASS' || st.check?.status === 'CONCERNS';
      items.push(['gate', 'Your decision', `${def.label}`, `Review ${r.outputs.join(', ')}${def.check ? (checked ? ` · independent check: ${st.check.status.toLowerCase()}` : ' · independent check not run yet') : ''}`, def.id, 'Review']);
    }
    if (st.status === 'BLOCKED' || st.status === 'FAIL') {
      items.push(['problem', STATUS_TEXT[st.status], `${def.label} ${st.status === 'BLOCKED' ? 'is blocked' : 'failed'}`, st.blockers[0] ?? '', def.id, 'See blockers']);
    }
  }
  const cur = state.stages[state.currentStage];
  const curDef = workflow.stages.find((s) => s.id === state.currentStage);
  if (!run && cur.status === 'READY') {
    items.push(['ready', 'Next', `${curDef.label} is ready to run`, `${workflow.agents[curDef.agent].label} with ${workflow.agents[curDef.agent].tool}`, curDef.id, 'Open']);
  }
  if (!run && cur.status === 'WAITING' && !curDef.enabled) {
    items.push(['ready', 'Next', `${curDef.label} comes next`, 'This stage arrives in the next build of the Control Center. Everything so far is saved in the repository.', curDef.id, 'Open']);
  }
  if (curDef.kind === 'end' && cur.status === 'PASS') {
    items.unshift(['ship', 'Ready to ship', 'Approved for release', `Every gate is approved. The release commit is tagged in the product repository (${ui.data.workspace}).`, curDef.id, 'Open']);
  }
  if (!items.length) return '';
  return `<section class="attention" aria-label="Needs your attention">${items
    .map(
      ([kind, tag, title, sub, id, cta]) => `
      <div class="notice ${kind}"><span class="tag">${tag}</span>
        <div class="what"><strong>${esc(title)}</strong><p>${esc(sub)}</p></div>
        <button class="btn small" data-select="${id}">${cta}</button></div>`,
    )
    .join('')}</section>`;
}

function track() {
  const { workflow, state } = ui.data;
  let n = 0;
  const stations = workflow.stages
    .map((def) => {
      const st = state.stages[def.id];
      const o = owner(def);
      const isGate = def.kind === 'gate';
      if (!isGate) n += 1;
      const mark = isGate ? ({ APPROVED: '✓', REJECTED: '✕', APPROVAL_REQUIRED: '!' }[st.status] ?? '') : st.status === 'PASS' ? '✓' : st.status === 'FAIL' ? '✕' : n;
      const cls = [
        'station',
        `s-${st.status}`,
        isGate ? 'gate' : '',
        def.enabled || def.kind === 'start' ? '' : 'later',
        def.id === ui.selected ? 'selected' : '',
        def.id === state.currentStage ? 'current' : '',
      ].join(' ');
      return `<button class="${cls}" data-select="${def.id}" aria-pressed="${def.id === ui.selected}" aria-label="${esc(def.label)}: ${STATUS_TEXT[st.status]}, owner ${esc(o.label)}">
        ${isGate ? '<span class="barrier" aria-hidden="true"></span>' : ''}
        <span class="node" aria-hidden="true">${mark}</span>
        <span class="label">${esc(def.label)}</span>
        <span class="owner ${o.cls}">${esc(o.label)}</span>
        <span class="st">${STATUS_TEXT[st.status]}</span>
      </button>`;
    })
    .join('');
  return `<section class="card" aria-label="Workflow">
    <header><h2>Workflow</h2><span class="muted">Stage ${esc(workflow.stages.find((s) => s.id === state.currentStage).label)}</span></header>
    <div class="track-wrap"><div class="track">${stations}</div></div>
    <div class="legend">
      <span><span class="owner claude">Claude</span> Anthropic agents</span>
      <span><span class="owner codex">Codex</span> OpenAI agents</span>
      <span><span class="owner human">You</span> human gates: the barrier stays down until you approve</span>
      <span>Dashed track: arrives in a later build</span>
    </div>
  </section>`;
}

function stageDetail() {
  const { workflow, state, contracts, artifacts } = ui.data;
  const def = workflow.stages.find((s) => s.id === ui.selected);
  const st = state.stages[def.id];
  const o = owner(def);
  const contract = def.agent ? contracts[def.agent] : null;
  const body = [];

  body.push(`<p class="objective">${esc(contract?.objective ?? describeStage(def))}</p>`);
  const rows = [
    ['Agent', esc(o.agent)],
    ['Tool', `<span class="owner ${o.cls}">${esc(o.label)}</span>`],
    ['Status', STATUS_TEXT[st.status]],
  ];
  if (def.kind === 'agent') {
    rows.push(['Inputs', fileList(def.inputs, artifacts)], ['Outputs', fileList(def.outputs, artifacts)]);
    rows.push(['Started', dateTime(st.startedAt)], ['Completed', dateTime(st.completedAt)]);
    if (st.attempts) rows.push(['Attempts', `${st.attempts}${st.consecutiveFailures ? ` (${st.consecutiveFailures} failed in a row)` : ''}`]);
  }
  if (def.kind === 'start') rows.push(['Outputs', fileList(def.outputs, artifacts)]);
  body.push(`<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`);

  if (st.blockers?.length) body.push(`<div class="section-title">Blockers</div><ul class="blockers">${st.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
  if (st.summary && def.kind === 'agent') body.push(`<div class="section-title">Agent summary</div><p class="summary">${esc(st.summary)}</p>`);

  if (def.kind === 'agent') body.push(agentControls(def, st));
  if (def.kind === 'gate') body.push(gateControls(def, st));
  if (!def.enabled && def.kind !== 'start') {
    body.push(`<p class="muted">This stage is defined in the workflow but arrives in a later build. Its contract and routing are already in <code>workflow/workflow.json</code>.</p>`);
  }

  return `<section class="card" aria-label="Stage detail">
    <header><h2>${esc(def.label)}</h2><span class="chip">${STATUS_TEXT[st.status]}</span></header>
    <div class="card-body">${body.join('')}</div></section>`;
}

function describeStage(def) {
  if (def.kind === 'gate') return 'A human reads the artifact, optionally with an independent check from a different AI vendor, and decides whether the workflow can continue.';
  if (def.kind === 'start') return 'The product idea, written by you. Every agent downstream starts from this file.';
  if (def.kind === 'end') return 'The product is approved for release.';
  return '';
}

function agentControls(def, st) {
  const { state } = ui.data;
  const out = [];
  const handoff = st.lastRunId ? ui.handoffs[st.lastRunId] : null;
  if (handoff?.checks?.length) {
    out.push(`<div class="section-title">Quality gate (checked by the Control Center)</div><ul class="preflight">${handoff.checks
      .map((c) => `<li class="${c.ok ? 'ok' : 'no'}"><span class="mark">${c.ok ? '✓' : '✕'}</span><span>${esc(c.name)}${c.detail ? ` <small>${esc(c.detail)}</small>` : ''}</span></li>`)
      .join('')}</ul>`);
  }
  if (!def.enabled) return out.join('');

  const running = state.activeRun?.stageId === def.id;
  if (running) {
    out.push(`<div class="section-title">Live progress</div><div class="log" data-log="${state.activeRun.runId}">${logLines(ui.logs[state.activeRun.runId])}</div>
      <div class="actions"><button class="btn reject small" data-cancel="${state.activeRun.runId}">Stop this run</button></div>`);
    return out.join('');
  }
  if (def.verdict && ['FAIL', 'BLOCKED'].includes(st.status) && !state.activeRun) {
    const earlier = ui.data.workflow.stages.filter(
      (s) => s.kind === 'agent' && s.enabled && ui.data.workflow.stages.indexOf(s) < ui.data.workflow.stages.indexOf(def),
    );
    const draft = ui.drafts.feedback[`reopen:${def.id}`] ?? '';
    out.push(`<div class="section-title">Send the work back</div>
      <p class="muted" style="font-size:13.5px">The review blocked the release. Choose which stage should fix it; the agent there receives your reason.</p>
      <textarea id="reopen-${def.id}" data-feedback="reopen:${def.id}" placeholder="What must change before release?">${esc(draft)}</textarea>
      <div class="actions">${earlier.map((s) => `<button class="btn small" data-reopen="${s.id}" data-from="${def.id}">Reopen ${esc(s.label)}</button>`).join('')}</div>`);
    if (ui.errors[`reopen:${def.id}`]) out.push(`<p class="error-text">${esc(ui.errors[`reopen:${def.id}`])}</p>`);
  }
  if (st.status === 'BLOCKED') {
    out.push(`<div class="actions"><button class="btn" data-unblock="${def.id}">Unblock and allow a retry</button></div>`);
  }
  if (['READY', 'FAIL'].includes(st.status)) {
    const pf = ui.preflight[`produce:${def.id}`];
    out.push(`<div class="section-title">Before running</div>${preflightList(pf)}`);
    const agent = ui.data.workflow.agents[def.agent];
    out.push(`<div class="actions"><button class="btn primary" data-run="${def.id}" ${pf?.ok && !ui.busy ? '' : 'disabled'}>
      ${st.status === 'FAIL' ? 'Run again' : 'Run'} ${esc(agent.label)} with ${esc(agent.tool)}</button>
      <span class="muted">Runs on your ${agent.cli === 'claude' ? 'Claude' : 'ChatGPT'} subscription.</span></div>`);
    if (ui.errors[`run:${def.id}`]) out.push(`<p class="error-text">${esc(ui.errors[`run:${def.id}`])}</p>`);
  }
  if (st.lastRunId && !running) {
    out.push(`<details><summary class="section-title" style="cursor:pointer">Last run log</summary><div class="log" data-log="${st.lastRunId}">${logLines(ui.logs[st.lastRunId])}</div>
      <p class="muted" style="font-size:13px">Full prompt and raw output: <code>workflow/runs/${esc(st.lastRunId)}/</code></p></details>`);
  }
  return out.join('');
}

function preflightList(pf) {
  if (!pf) return '<p class="muted">Checking inputs, approvals and CLI login…</p>';
  if (pf.error) return `<p class="error-text">${esc(pf.error)}</p>`;
  return `<ul class="preflight">${pf.items
    .map((i) => `<li class="${i.ok ? 'ok' : 'no'}"><span class="mark">${i.ok ? '✓' : '✕'}</span><span>${esc(i.label)}<small>${esc(i.detail)}</small></span></li>`)
    .join('')}</ul>`;
}

function gateControls(def, st) {
  const { workflow, state } = ui.data;
  const out = [];
  const reviewed = workflow.stages.find((s) => s.id === def.reviews);
  out.push(`<div class="section-title">What you are approving</div>${fileList(reviewed?.outputs, ui.data.artifacts)}`);

  if (def.check) {
    const critic = workflow.agents[def.check.agent];
    const c = st.check;
    const running = state.activeRun?.purpose === 'check' && state.activeRun.stageId === def.id;
    out.push(`<div class="section-title">Independent check · ${esc(critic.tool)} (advisory)</div>`);
    if (running) {
      out.push(`<div class="log" data-log="${state.activeRun.runId}">${logLines(ui.logs[state.activeRun.runId])}</div>
        <div class="actions"><button class="btn reject small" data-cancel="${state.activeRun.runId}">Stop the check</button></div>`);
    } else if (c) {
      out.push(`<div class="check-box"><span class="verdict ${c.status}">${c.status}</span>
        ${c.findings ? ` <span class="muted">${c.findings} finding${c.findings > 1 ? 's' : ''}</span>` : ''}
        <p style="margin:8px 0 0">${esc(c.summary ?? '')}</p>
        ${c.status !== 'ERROR' ? `<div class="actions"><button class="btn small" data-open="workflow/checks/${def.id}.md">Read the full check</button></div>` : ''}</div>`);
    } else {
      out.push(`<p class="muted">A different AI vendor reads the artifact and its inputs and points out unsupported claims or gaps. It never blocks you.</p>`);
    }
    if (st.status === 'APPROVAL_REQUIRED' && !running) {
      const pf = ui.preflight[`check:${def.id}`];
      const failed = pf && !pf.error && !pf.ok;
      out.push(`<div class="actions"><button class="btn" data-check="${def.id}" ${pf?.ok && !state.activeRun ? '' : 'disabled'}>${c ? 'Run the check again' : `Run ${esc(critic.tool)} check`}</button></div>`);
      if (failed) out.push(preflightList(pf));
      if (ui.errors[`check:${def.id}`]) out.push(`<p class="error-text">${esc(ui.errors[`check:${def.id}`])}</p>`);
    }
  }

  out.push('<div class="section-title">Decision</div>');
  if (st.status === 'APPROVAL_REQUIRED') {
    const draft = ui.drafts.feedback[def.id] ?? '';
    const lock = state.activeRun ? 'disabled' : '';
    out.push(`<label for="fb-${def.id}" class="muted" style="font-size:13.5px">Feedback for the agent <small>(required to reject)</small></label>
      <textarea id="fb-${def.id}" data-feedback="${def.id}" placeholder="What should change?">${esc(draft)}</textarea>
      <div class="actions">
        <button class="btn approve" data-decide="${def.id}" data-decision="APPROVED" ${lock}>Approve ${esc(reviewed.label.toLowerCase())}</button>
        <button class="btn reject" data-decide="${def.id}" data-decision="REJECTED" ${lock}>Reject and send back</button>
      </div>
      <p class="muted" style="font-size:13px">Approving creates a local Git commit as a checkpoint. Nothing is pushed.</p>`);
    if (ui.errors[`decide:${def.id}`]) out.push(`<p class="error-text">${esc(ui.errors[`decide:${def.id}`])}</p>`);
  } else if (st.decision) {
    out.push(`<div class="decided"><strong>${st.decision.decision === 'APPROVED' ? 'Approved' : 'Rejected'}</strong> · ${dateTime(st.decision.decidedAt)}
      ${st.decision.feedback ? `<p style="margin:6px 0 0">“${esc(st.decision.feedback)}”</p>` : ''}</div>`);
  } else {
    out.push(`<p class="muted">Opens when ${esc(reviewed?.label ?? 'the previous stage')} passes.</p>`);
  }

  const history = ui.approvals[def.id];
  if (Array.isArray(history) && history.length) {
    out.push(`<div class="section-title">History</div><ul class="files">${history
      .slice()
      .reverse()
      .map((h) => `<li class="muted" style="font-size:13px">${dateTime(h.decidedAt)} · ${h.decision === 'APPROVED' ? 'Approved' : 'Rejected'}${h.feedback ? `: “${esc(h.feedback)}”` : ''}</li>`)
      .join('')}</ul>`);
  }
  return out.join('');
}

function loadSelectedExtras() {
  const { state, workflow } = ui.data;
  const def = workflow.stages.find((s) => s.id === ui.selected);
  const st = state.stages[def.id];
  if (def.kind === 'agent' && def.enabled && ['READY', 'FAIL'].includes(st.status) && !state.activeRun) {
    ensure(`produce:${def.id}`, ui.preflight, () => api(`/api/preflight?stage=${def.id}&purpose=produce`));
  }
  if (def.kind === 'gate' && def.check && st.status === 'APPROVAL_REQUIRED' && !state.activeRun) {
    ensure(`check:${def.id}`, ui.preflight, () => api(`/api/preflight?stage=${def.id}&purpose=check`));
  }
  if (st.lastRunId && state.activeRun?.runId !== st.lastRunId) {
    ensure(st.lastRunId, ui.handoffs, () => api(`/api/artifact?path=workflow/runs/${st.lastRunId}/handoff.json`).then((r) => JSON.parse(r.content)));
    if (!(st.lastRunId in ui.logs)) {
      ui.logs[st.lastRunId] = [];
      refreshLog(st.lastRunId);
    }
  }
  if (def.kind === 'gate') {
    ensure(def.id, ui.approvals, () => api(`/api/artifact?path=workflow/approvals/${def.id}.json`).then((r) => JSON.parse(r.content)).catch(() => []));
  }
}

function activity() {
  const items = ui.activity
    .map((e) => {
      const who = e.actor === 'human' ? ['human', 'You'] : e.cli ? [e.cli, e.cli === 'claude' ? 'Claude' : 'Codex'] : ['', 'System'];
      return `<li><time>${time(e.ts)}</time><span><span class="who ${who[0]}">${who[1]}</span>${esc(e.message)}
        ${e.blockers?.length ? `<span class="bl">${esc(e.blockers[0])}</span>` : ''}</span></li>`;
    })
    .join('');
  return `<section class="card" aria-label="Activity"><header><h2>Activity</h2><span class="muted mono">workflow/activity.jsonl</span></header>
    <ul class="activity">${items || '<li><time></time><span class="muted">No activity yet.</span></li>'}</ul></section>`;
}

function artifacts() {
  const rows = ui.data.artifacts
    .filter((a) => a.exists || ui.data.workflow.stages.find((s) => s.id === a.stage)?.enabled)
    .map(
      (a) => `<tr><td class="path">${a.exists ? `<button data-open="${esc(a.path)}">${esc(a.path)}</button>` : `<span class="missing">${esc(a.path)}</span>`}</td>
      <td>${esc(a.createdBy)}</td><td>${esc(a.stageLabel)}</td><td>${STATUS_TEXT[a.status]}</td><td>${a.updatedAt ? dateTime(a.updatedAt) : '<span class="muted">not yet</span>'}</td></tr>`,
    )
    .join('');
  return `<section class="card" aria-label="Artifacts"><header><h2>Artifacts</h2><span class="muted mono">${esc(ui.data.workspace)}/</span></header>
    <div class="table-wrap"><table><thead><tr><th>File</th><th>Created by</th><th>Stage</th><th>Stage status</th><th>Last updated</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

// ---------- artifact viewer ----------

async function openArtifact(path) {
  const dlg = document.getElementById('viewer');
  const meta = ui.data.artifacts.find((a) => a.path === path);
  try {
    const { content } = await api(`/api/artifact?path=${encodeURIComponent(path)}`);
    // Agent-written HTML runs in an opaque-origin sandbox: scripts work, but it
    // cannot reach this page, its cookies or the Control Center API.
    const html = path.endsWith('.md')
      ? marked.parse(content)
      : path.endsWith('.html')
        ? `<iframe class="prototype" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${esc(path)}" srcdoc="${esc(content)}"></iframe>`
        : `<pre>${esc(content)}</pre>`;
    dlg.innerHTML = `<header><div><h2 id="viewer-title">${esc(path)}</h2>
      ${meta ? `<div class="meta"><span class="chip">${esc(meta.createdBy)}</span><span class="chip">${esc(meta.stageLabel)} · ${STATUS_TEXT[meta.status]}</span><span class="chip">Updated ${dateTime(meta.updatedAt)}</span></div>` : ''}</div>
      <button class="btn small" data-close>Close</button></header><article class="${path.endsWith('.html') ? 'frame' : 'markdown'}">${html}</article>`;
  } catch (e) {
    dlg.innerHTML = `<header><h2 id="viewer-title">${esc(path)}</h2><button class="btn small" data-close>Close</button></header><div class="card-body"><p class="error-text">${esc(e.message)}</p></div>`;
  }
  dlg.showModal();
}

// ---------- events ----------

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.select) {
    ui.selected = d.select;
    render();
    document.querySelector('[aria-label="Stage detail"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else if (d.open) {
    openArtifact(d.open);
  } else if (d.close !== undefined) {
    document.getElementById('viewer').close();
  } else if (d.run) {
    await act(`run:${d.run}`, () => post(`/api/stages/${d.run}/run`));
  } else if (d.check) {
    await act(`check:${d.check}`, () => post(`/api/gates/${d.check}/check`));
  } else if (d.cancel) {
    await act('cancel', () => post(`/api/runs/${d.cancel}/cancel`));
  } else if (d.reopen) {
    const reason = ui.drafts.feedback[`reopen:${d.from}`] ?? '';
    if (!reason.trim()) {
      ui.errors[`reopen:${d.from}`] = 'Write what must change before sending the work back.';
      render();
      return;
    }
    const ok = await act(`reopen:${d.from}`, () => post(`/api/stages/${d.reopen}/reopen`, { reason }));
    if (ok) {
      delete ui.drafts.feedback[`reopen:${d.from}`];
      ui.selected = d.reopen;
      render();
    }
  } else if (d.unblock) {
    await act(`unblock:${d.unblock}`, () => post(`/api/stages/${d.unblock}/unblock`));
  } else if (d.decide) {
    const feedback = ui.drafts.feedback[d.decide] ?? '';
    if (d.decision === 'REJECTED' && !feedback.trim()) {
      ui.errors[`decide:${d.decide}`] = 'Write what should change before rejecting. The agent receives this feedback.';
      render();
      document.getElementById(`fb-${d.decide}`)?.focus();
      return;
    }
    const ok = await act(`decide:${d.decide}`, () => post(`/api/gates/${d.decide}/decision`, { decision: d.decision, feedback }));
    if (ok) delete ui.drafts.feedback[d.decide];
  }
});

async function act(key, fn) {
  ui.busy = true;
  delete ui.errors[key];
  try {
    await fn();
    ui.preflight = {};
    ui.approvals = {};
    return true;
  } catch (e) {
    ui.errors[key] = e.message;
    return false;
  } finally {
    ui.busy = false;
    ui.lastJson = '';
    await refreshOnce();
  }
}

async function refreshOnce() {
  const data = await api('/api/overview');
  ui.data = data;
  ui.activity = data.project ? await api('/api/activity') : [];
  ui.lastJson = JSON.stringify([data, ui.activity]);
  render();
}

document.addEventListener('input', (ev) => {
  if (ev.target.dataset?.feedback) ui.drafts.feedback[ev.target.dataset.feedback] = ev.target.value;
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'new-product') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  try {
    await post('/api/products', { name: f.get('name'), idea: f.get('idea'), context: f.get('context') });
    delete ui.errors.create;
    await refreshOnce();
  } catch (e) {
    ui.errors.create = e.message;
    render();
  }
});

document.getElementById('viewer').addEventListener('click', (ev) => {
  if (ev.target.id === 'viewer') ev.target.close();
});

refresh(true);
