// Screenshots for Design QA: the approved prototype and the implemented app,
// screen by screen, so the reviewer compares pixels and not only source code.

import http from 'node:http';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BINARIES, childEnv } from './clis.ts';
import { killGroup } from './workspace.ts';

export interface Screen {
  id: string;
  path: string;
}
export interface Capture {
  images: { label: string; rel: string }[];
  notes: string[];
}

const MAX_SCREENS = 8;
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const APP_SERVER_LIMIT_MS = 2 * 60_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

// Serves static files from one folder on a random local port. Used for the
// prototype and for static apps, so no agent-written server code runs.
function staticServer(root: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (existsSync(file) && (await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

// Starts the product's `npm start` inside the Codex sandbox. Writes stay
// confined to the product folder; network is enabled because the sandbox has
// no localhost-only mode, and the run is short and killed afterwards.
async function startApp(ws: string, script: string): Promise<{ url: string; stop: () => void; log: () => string }> {
  const port = await freePort();
  const child = spawn(
    BINARIES.codex,
    ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', 'sh', '-c', script],
    { cwd: ws, env: { ...childEnv(), PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development' }, detached: true },
  );
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const killer = setTimeout(() => killGroup(child), APP_SERVER_LIMIT_MS);
  const stop = () => {
    clearTimeout(killer);
    killGroup(child);
  };
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    try {
      await fetch(url);
      return { url, stop, log: () => output };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  stop();
  throw new Error(`The app did not answer on ${url} within 30 seconds. Output:\n${output.slice(-1500)}`);
}

export async function captureScreens(ws: string, runDir: string, screens: Screen[], prototypeRel: string | null): Promise<Capture> {
  const notes: string[] = [];
  const images: Capture['images'] = [];
  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch {
    return { images, notes: ['Playwright is not installed, so no screenshots were taken. Judge from the code.'] };
  }
  const list = screens.slice(0, MAX_SCREENS);
  if (screens.length > MAX_SCREENS) notes.push(`Only the first ${MAX_SCREENS} of ${screens.length} screens were captured.`);
  const outDir = path.join(ws, runDir, 'screens');
  await fs.mkdir(outDir, { recursive: true });
  const shot = async (page: import('playwright').Page, label: string, name: string) => {
    const rel = path.join(runDir, 'screens', name);
    await page.screenshot({ path: path.join(ws, rel), fullPage: true });
    images.push({ label, rel });
  };

  const browser = await pw.chromium.launch();
  const cleanups: (() => void)[] = [];
  try {
    const context = await browser.newContext();
    // Agent-written pages may only talk to the local servers started here.
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'data:' ? route.continue() : route.abort();
    });
    const page = await context.newPage();

    if (prototypeRel && existsSync(path.join(ws, prototypeRel))) {
      const proto = await staticServer(path.dirname(path.join(ws, prototypeRel)));
      cleanups.push(proto.close);
      await page.setViewportSize(MOBILE);
      for (const s of list) {
        await page.goto(`${proto.url}/${path.basename(prototypeRel)}`, { waitUntil: 'load' });
        const found = await page.evaluate((id) => {
          const all = [...document.querySelectorAll<HTMLElement>('[data-screen]')];
          const target = all.find((el) => el.dataset.screen === id);
          if (!target) return false;
          for (const el of all) el.style.setProperty('display', el === target ? 'block' : 'none', 'important');
          target.hidden = false;
          return true;
        }, s.id);
        if (found) await shot(page, `Prototype ${s.id}, mobile`, `prototype-${s.id}-mobile.png`);
        else notes.push(`Prototype has no element with data-screen="${s.id}".`);
      }
    }

    let pkg: { scripts?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(await fs.readFile(path.join(ws, 'package.json'), 'utf8'));
    } catch {
      /* no package.json */
    }
    let base: string | null = null;
    if (pkg.scripts?.start) {
      try {
        const app = await startApp(ws, pkg.scripts.start);
        cleanups.push(app.stop);
        base = app.url;
        notes.push('The app was started with `npm start` in the sandbox (network enabled for at most 2 minutes, writes limited to the product folder).');
      } catch (e) {
        notes.push((e as Error).message);
      }
    } else {
      const entry = ['public/index.html', 'index.html', 'src/index.html'].find((f) => existsSync(path.join(ws, f)));
      if (entry) {
        const app = await staticServer(path.dirname(path.join(ws, entry)));
        cleanups.push(app.close);
        base = app.url;
        notes.push(`Static app served from ${path.dirname(entry) || '.'}/ by the Control Center.`);
      } else {
        notes.push('No `start` script and no index.html found, so the app was not captured.');
      }
    }
    if (base) {
      for (const s of list) {
        for (const [vp, size] of [['mobile', MOBILE], ['desktop', DESKTOP]] as const) {
          await page.setViewportSize(size);
          try {
            await page.goto(new URL(s.path || '/', base + '/').toString(), { waitUntil: 'load', timeout: 15_000 });
            await shot(page, `App ${s.id} (${s.path}), ${vp}`, `app-${s.id}-${vp}.png`);
          } catch (e) {
            notes.push(`Could not open ${s.id} at ${s.path}: ${(e as Error).message.split('\n')[0]}`);
          }
        }
      }
    }
  } finally {
    for (const c of cleanups) c();
    await browser.close();
  }
  return { images, notes };
}
