#!/usr/bin/env node
// Stand-in for the `claude` and `codex` CLIs, used by the integration tests to
// exercise success and failure paths without spending subscription quota.
// Usage: fake-cli.mjs <claude|codex> [cli args...]
// Behavior is read on every call from the JSON file in FAKE_MODE_FILE, e.g.
// {"claude": "pass", "codex": "fail"}. Modes: pass | fail | missing-section | crash | slow | logged-out.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const flavor = args.shift();
let mode = 'pass';
try {
  mode = JSON.parse(readFileSync(process.env.FAKE_MODE_FILE, 'utf8'))[flavor] ?? 'pass';
} catch {
  /* default: pass */
}

if (args[0] === '--version') {
  console.log(flavor === 'claude' ? '2.1.288 (Claude Code) [fake]' : 'codex-cli 0.159.2 [fake]');
  process.exit(0);
}
// `codex sandbox [-c k=v]... <command...>`: runs the command (no real sandbox in tests).
if (args[0] === 'sandbox') {
  let i = 1;
  while (args[i] === '-c') i += 2;
  const r = spawnSync(args[i], args.slice(i + 1), { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: mode !== 'logged-out', authMethod: mode === 'logged-out' ? 'none' : 'claude.ai' }));
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log(mode === 'logged-out' ? 'Not logged in' : 'Logged in using ChatGPT');
  process.exit(0);
}

// Builds valid artifacts for whatever the prompt asks for, from its "Files to return" list.
function artifactsFor(prompt) {
  const block = prompt.split('## Files to return')[1] ?? '';
  const files = [...block.matchAll(/^- `([^`]+)`(?:: level-2 headings (.+))?$/gm)].map((m) => ({
    path: m[1],
    headings: m[2] ? [...m[2].matchAll(/"([^"]+)"/g)].map((h) => h[1]) : [],
  }));
  return files.map(({ path, headings }) => ({
    path,
    headings,
    content: path.endsWith('.html')
      ? '<!doctype html><html><body><section data-screen="S1">Fake screen</section></body></html>'
      : `# Fake ${path}\n\n${headings.map((h) => `## ${h}\nContent for ${h}.\n`).join('\n')}`,
  }));
}

let prompt = '';
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', async () => {
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 30_000));
  if (mode === 'crash') {
    process.stderr.write('fatal: simulated CLI crash\n');
    process.exit(2);
  }

  if (flavor === 'claude') {
    let artifacts = artifactsFor(prompt);
    if (mode === 'missing-section') {
      const md = artifacts.find((a) => a.headings.length);
      const last = md.headings.at(-1);
      md.content = md.content.replace(new RegExp(`## ${last}[\\s\\S]*$`), '');
    }
    if (mode === 'extra-file') artifacts.push({ path: 'src/sneaky.js', content: 'alert(1)' });
    artifacts = artifacts.map(({ path, content }) => ({ path, content }));
    const output =
      mode === 'fail'
        ? { status: 'FAIL', summary: 'Input too vague.', artifacts: [], blockers: ['The input does not say who has the problem.'] }
        : mode === 'verdict-fail'
          ? { status: 'FAIL', summary: 'Found a defect.', artifacts, blockers: ['AC-1 is not met in src/app.js: add() ignores negative numbers.'] }
          : mode === 'fail-no-blockers'
            ? { status: 'FAIL', summary: 'Not good.', artifacts, blockers: [] }
            : { status: 'PASS', summary: 'Artifacts written.', artifacts, blockers: [] };
    const sawFeedback = prompt.includes('Human feedback on your previous version');
    if (sawFeedback) output.summary += ' Addressed human feedback.';
    const events = [
      { type: 'system', subtype: 'init', model: 'fake-model' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'fake query' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: output }] } },
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, structured_output: output },
    ];
    for (const e of events) console.log(JSON.stringify(e));
    process.exit(0);
  }

  // codex
  const out = args[args.indexOf('--output-last-message') + 1];
  if (args[args.indexOf('--sandbox') + 1] === 'workspace-write') {
    const cwd = args[args.indexOf('--cd') + 1];
    const put = (rel, text) => {
      mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      writeFileSync(path.join(cwd, rel), text);
    };
    const deps = mode === 'needs-dep' ? { 'left-pad': '^1.3.0' } : mode === 'bad-dep' ? { evil: 'git+https://example.com/evil.git' } : undefined;
    put('package.json', JSON.stringify({ type: 'module', scripts: { test: 'node --test' }, ...(deps ? { dependencies: deps } : {}) }));
    put('src/app.js', `export const add = (a, b) => a + b;\n// fix run: ${prompt.includes("(fix these)")} at ${Date.now()}\n`);
    put('test/app.test.js', `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/app.js';\ntest('adds', () => assert.equal(add(1, 2), ${mode === 'break-tests' ? 4 : 3}));\n`);
    if (mode === 'tamper') put('product/prd.md', '# PRD rewritten by the engineer\n');
    const fixing = prompt.includes('(fix these)');
    const needs = mode === 'needs-dep' || mode === 'bad-dep';
    writeFileSync(out, JSON.stringify({
      status: needs ? 'FAIL' : 'PASS', summary: fixing ? 'Fixed the reported blockers.' : 'Implemented all tasks.',
      tasks_completed: ['T-1'], tasks_remaining: [], files_changed: ['src/app.js', 'test/app.test.js', 'package.json'],
      how_to_run: 'node src/app.js', fixes: fixing ? [{ blocker: 'reported blocker', resolution: 'fixed' }] : [],
      notes_for_reviewers: 'Small app.', blockers: needs ? [`Needs package install: ${Object.keys(deps)[0]}`] : [],
    }));
    console.log(JSON.stringify({ type: 'thread.started' }));
    console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'node --test' } }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
    process.exit(0);
  }
  const critique =
    mode === 'fail'
      ? { verdict: 'CONCERNS', summary: 'Two claims lack sources.', findings: [{ severity: 'high', issue: 'Unsourced fact', evidence: 'Facts section', suggestion: 'Add a source.' }] }
      : { verdict: 'PASS', summary: 'Looks sound.', findings: [] };
  console.log(JSON.stringify({ type: 'thread.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Reviewing the artifact.' } }));
  writeFileSync(out, JSON.stringify(critique));
  console.log(JSON.stringify({ type: 'turn.completed' }));
  process.exit(0);
});
