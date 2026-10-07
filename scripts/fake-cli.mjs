#!/usr/bin/env node
// Stand-in for the `claude` and `codex` CLIs, used by the integration tests to
// exercise success and failure paths without spending subscription quota.
// Usage: fake-cli.mjs <claude|codex> [cli args...]
// Behavior is read on every call from the JSON file in FAKE_MODE_FILE, e.g.
// {"claude": "pass", "codex": "fail"}. Modes: pass | fail | missing-section | crash | slow | logged-out.

import { readFileSync, writeFileSync } from 'node:fs';

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
