#!/usr/bin/env node
// figma-lens bridge: receives exports from the Figma plugin and writes them to disk
// so Claude Code can read them. Zero config:  node bridge/server.js --out ./design
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { renderSpecFiles, summarizeUsage } from './render-md.js';
import { planSections, cropSections } from './sections.js';
import { findMap, loadMap } from '../tools/map.js';
import { findConfig, loadAutoConfig, createQueue, runJob, CONFIG_FILE } from '../tools/auto.js';

const VERSION = '0.2.0';
const MARKER = '.figma-lens.json';
const AUTO_DIR = 'auto'; // auto-mode results inside an export folder; survives re-exports
const MAX_BODY = 300 * 1024 * 1024;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._@-]*(\/[A-Za-z0-9][A-Za-z0-9._@-]*)*$/;

export function folderSlug(name, fallback) {
  const s = String(name || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return s || String(fallback || 'frame').replace(/[^A-Za-z0-9]+/g, '-');
}

function insideDir(dir, rel) {
  const full = path.resolve(dir, rel);
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Everything derived from spec + screenshot: section crops, spec.json, spec.md (+ per-section
 * spec files for large frames). Shared by the bridge and `figma-lens render`, which re-runs it
 * on an existing export. With a screenshot it replaces the export's sections/ folder (it only holds
 * generated files); without one it cannot re-crop, so it keeps the existing crops and only
 * replaces the section spec files.
 * Mutates meta (warnings, sectionPlan, sectionFiles). Returns the number of files written.
 */
export async function writeDerived(dir, { meta, spec, tokens, usage, map, screenBuf }) {
  const generated = (w) => /^section crops/.test(w) || /^screenshot is \d+×\d+px but/.test(w) || /^no screenshot: /.test(w);
  meta.warnings = (Array.isArray(meta.warnings) ? meta.warnings : []).filter((w) => !generated(w));
  const plan = planSections(meta, spec);
  const sectionsDir = path.join(dir, 'sections');
  if (!screenBuf) {
    // Nothing to crop from: never delete crops we cannot regenerate.
    const kept = Array.isArray(meta.sectionFiles) ? meta.sectionFiles : [];
    if (kept.length) meta.warnings.push('no screenshot: kept the existing section crops; they may not match the section list');
    const old = await fs.readdir(sectionsDir).catch(() => []);
    for (const f of old.filter((f) => f.endsWith('.md'))) await fs.rm(path.join(sectionsDir, f), { force: true });
    meta.sectionPlan = plan;
    meta.sectionFiles = kept;
    return (await writeSpecs(dir, { meta, spec, tokens, usage, map })) + 1;
  }
  let sectionFiles = [];
  if (plan.length) {
    try {
      const src = PNG.sync.read(screenBuf);
      const scale = meta.scale || 1;
      const ew = Math.round(meta.width * scale);
      const eh = Math.round(meta.height * scale);
      if (!(Math.abs(src.width - ew) <= 1 && Math.abs(src.height - eh) <= 1)) {
        // Never emit shifted crops: a wrong reference image is worse than none.
        meta.warnings.push(
          `screenshot is ${src.width}×${src.height}px but the frame at ${scale}x should be ${ew}×${eh}px — ` +
            'screenshot pixels do not map to spec coordinates; section crops skipped',
        );
      } else {
        sectionFiles = cropSections(src, plan, scale);
      }
    } catch (e) {
      meta.warnings.push(`section crops failed: ${e.message}`);
      sectionFiles = [];
    }
  }
  await fs.rm(sectionsDir, { recursive: true, force: true });
  for (const s of sectionFiles) {
    const full = insideDir(dir, s.file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, s.buf);
  }
  meta.sectionPlan = plan;
  meta.sectionFiles = sectionFiles.map(({ file, id, name, box, px }) => ({ file, id, name, box, px }));
  return sectionFiles.length + (await writeSpecs(dir, { meta, spec, tokens, usage, map }));
}

// spec.json + spec.md (+ section spec files). Returns the number of files written.
async function writeSpecs(dir, { meta, spec, tokens, usage, map }) {
  await fs.writeFile(path.join(dir, 'spec.json'), JSON.stringify({ meta, spec }, null, 1));
  const mdFiles = renderSpecFiles({ meta, spec, tokens }, usage, map);
  for (const f of mdFiles) {
    const full = insideDir(dir, f.file);
    if (!full) throw new Error(`unsafe spec file path: ${f.file}`);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.text);
  }
  return mdFiles.length + 1;
}

async function readMarker(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

// Folder for this frame: "<slug>", or "<slug>-<nodeId>" when "<slug>" belongs to another frame
// or to something that isn't a figma-lens export. Only ever replaces a folder owned by the same node,
// and keeps using a folder this node already owns (so no stale duplicate is left behind).
async function claimDir(outRoot, slug, nodeId) {
  const idSlug = String(nodeId).replace(/[^A-Za-z0-9]+/g, '-');
  const candidates = [slug, `${slug}-${idSlug}`].map((name) => path.join(outRoot, name));
  for (const dir of candidates) {
    const owner = await readMarker(dir);
    if (owner && owner.nodeId === nodeId) return dir;
  }
  for (const dir of candidates) {
    if (!(await exists(dir))) return dir;
  }
  throw new HttpError(409, `folders "${slug}" and "${slug}-${idSlug}" are taken by other exports or files; rename the frame`);
}

async function writeIndex(outRoot) {
  const rows = [];
  for (const entry of await fs.readdir(outRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = await readMarker(path.join(outRoot, entry.name));
    if (m) rows.push({ dir: entry.name, ...m });
  }
  rows.sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)));
  const lines = [
    '# Figma exports (figma-lens)',
    '',
    'Read `<folder>/spec.md` first, then look at the screenshot and section crops.',
    '',
    '| Folder | Frame | Size | Figma file / page | Exported |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| \`${r.dir}/\` | ${r.nodeName} | ${r.width}×${r.height} | ${r.file} / ${r.page} | ${r.exportedAt} |`),
    '',
  ];
  await fs.writeFile(path.join(outRoot, 'INDEX.md'), lines.join('\n'));
}

// Map is re-read on every export so edits apply without restarting the bridge.
// A broken map must not block exports: warn and continue without it.
function mapFor(outRoot, mapFile, warnings) {
  try {
    return loadMap(mapFile || findMap([outRoot, path.dirname(outRoot)]));
  } catch (e) {
    warnings.push(`component map ignored: ${e.message}`);
    return null;
  }
}

export async function writeExport(outRoot, payload, { mapFile } = {}) {
  const { meta, spec, tokens, files } = payload || {};
  if (!meta || !spec || !Array.isArray(files)) throw new HttpError(400, 'payload needs meta, spec and files[]');
  if (meta.tool !== 'figma-lens') throw new HttpError(400, 'not a figma-lens payload');

  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.base64 !== 'string') throw new HttpError(400, 'bad file entry');
    if (!SAFE_FILE.test(f.path) || f.path.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new HttpError(400, `unsafe file path: ${f.path}`);
    }
    if (f.path === MARKER) throw new HttpError(400, `reserved file name: ${f.path}`);
    // case-insensitive: Auto/ is the same folder as auto/ on Windows and macOS
    if (f.path.split('/')[0].toLowerCase() === AUTO_DIR) throw new HttpError(400, `reserved folder: ${AUTO_DIR}/`);
  }

  const dir = await claimDir(outRoot, folderSlug(meta.nodeName, 'node-' + meta.nodeId), meta.nodeId);
  await fs.mkdir(outRoot, { recursive: true });
  // Replace this frame's own previous export, but keep auto/: an auto-mode run for this frame may
  // still be working and writes its record (run.json, report.md) there.
  for (const entry of await fs.readdir(dir).catch(() => [])) {
    if (entry !== AUTO_DIR) await fs.rm(path.join(dir, entry), { recursive: true, force: true });
  }
  await fs.mkdir(dir, { recursive: true });

  let screenBuf = null;
  for (const f of files) {
    const full = insideDir(dir, f.path);
    if (!full) throw new HttpError(400, `unsafe file path: ${f.path}`);
    const buf = Buffer.from(f.base64, 'base64');
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf);
    if (f.path === meta.screen) screenBuf = buf;
  }

  meta.warnings = Array.isArray(meta.warnings) ? meta.warnings : [];
  const usage = summarizeUsage(spec);
  const map = mapFor(outRoot, mapFile, meta.warnings);
  await fs.writeFile(path.join(dir, 'tokens.json'), JSON.stringify({ ...(tokens || {}), usage }, null, 1));
  const derived = await writeDerived(dir, { meta, spec, tokens, usage, map, screenBuf });
  const { warnings, sections, sectionFiles: _sf, sectionPlan: _sp, ...markerMeta } = meta;
  await fs.writeFile(path.join(dir, MARKER), JSON.stringify(markerMeta, null, 1));
  await writeIndex(outRoot);

  return { dir, files: files.length + derived + 1 };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'export too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// The plugin UI iframe has origin "null"; curl/scripts send no Origin. Any other web page
// open in a browser must not be able to write files through this bridge.
export function originAllowed(origin) {
  if (process.env.FIGMA_LENS_ALLOW_ANY_ORIGIN === '1') return true;
  if (origin === undefined || origin === 'null') return true;
  return /^https:\/\/([a-z0-9-]+\.)*figma\.com$/.test(origin);
}

// onExport(dir) runs after the plugin got its answer (auto mode), so Figma never waits on it.
export function createBridge({ outRoot, mapFile, log = console.log, onExport } = {}) {
  const root = path.resolve(outRoot || 'design');
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      log(`✖ blocked request from origin ${origin} (set FIGMA_LENS_ALLOW_ANY_ORIGIN=1 to allow)`);
      send(res, 403, { ok: false, error: `origin ${origin} not allowed` });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { ok: true, tool: 'figma-lens', version: VERSION, outRoot: root });
        return;
      }
      if (req.method === 'POST' && req.url === '/export') {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'body is not valid JSON');
        }
        const result = await writeExport(root, payload, { mapFile });
        log(`✔ ${payload.meta.nodeName} → ${result.dir} (${result.files} files)`);
        send(res, 200, { ok: true, ...result });
        if (onExport) {
          try {
            onExport(result.dir);
          } catch (e) {
            log(`✖ auto: ${e.message}`);
          }
        }
        return;
      }
      send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) log(`✖ ${e.stack || e.message}`);
      else log(`✖ ${e.message}`);
      if (!res.headersSent) send(res, status, { ok: false, error: e.message });
    }
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--map') out.map = argv[++i];
    else if (argv[i] === '--auto') out.auto = true;
  }
  return out;
}

// Auto mode: one queue for the whole bridge. The config is re-read for every export, so edits
// (or turning auto.enabled off) apply without restarting the bridge.
export function autoHandler(outRoot, log = console.log) {
  const queue = createQueue(async (dir) => {
    const configFile = findConfig([outRoot, path.dirname(outRoot)]);
    if (!configFile) return log(`⚠ auto: no ${CONFIG_FILE} next to ${outRoot} — run figma-lens auto --init in your project`);
    if (!loadAutoConfig(configFile).enabled) return log(`⚠ auto: auto.enabled is false in ${configFile}`);
    await runJob({ frameDir: dir, configFile, log });
  });
  const handle = (dir) => {
    if (!queue.enqueue(dir)) log(`… auto: ${path.basename(dir)} is already waiting; it will use this export`);
  };
  handle.idle = queue.idle; // for tests: resolves when the queue is empty
  return handle;
}

export function startBridge({ port, out, map, auto } = {}) {
  port = port || Number(process.env.FIGMA_LENS_PORT) || 4141;
  const outRoot = path.resolve(out || process.env.FIGMA_LENS_OUT || 'design');
  const mapFile = map ? path.resolve(map) : undefined;
  const onExport = auto ? autoHandler(outRoot) : undefined;
  // Loopback only (never the LAN). Figma may resolve "localhost" to IPv4 or IPv6, so bind both.
  createBridge({ outRoot, mapFile, onExport })
    .on('error', (e) => {
      console.error(`cannot listen on 127.0.0.1:${port}: ${e.message}`);
      process.exit(1);
    })
    .listen(port, '127.0.0.1', () => {
      console.log(`figma-lens bridge ${VERSION} on http://localhost:${port}`);
      console.log(`writing exports to ${outRoot}`);
      console.log(`component map: ${mapFile || findMap([outRoot, path.dirname(outRoot)]) || '(none yet — run figma-lens map)'}`);
      if (auto) {
        const cfg = findConfig([outRoot, path.dirname(outRoot)]);
        console.log(`auto mode: ON — each export is implemented by Claude Code on a figma/<frame> branch (${cfg || `no ${CONFIG_FILE} yet — run figma-lens auto --init`})`);
      }
    });
  createBridge({ outRoot, mapFile, onExport })
    .on('error', () => {
      // IPv6 loopback unavailable; IPv4 is enough
    })
    .listen(port, '::1');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBridge(parseArgs(process.argv.slice(2)));
}
