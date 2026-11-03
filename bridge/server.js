#!/usr/bin/env node
// figma-lens bridge: receives exports from the Figma plugin and writes them to disk
// so Claude Code can read them. Zero config:  node bridge/server.js --out ./design
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { renderMarkdown, summarizeUsage } from './render-md.js';

const VERSION = '0.1.0';
const MARKER = '.figma-lens.json';
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

function cropSections(src, sections, scale) {
  if (!sections || !sections.length) return [];
  const out = [];
  sections.forEach((s, i) => {
    const x = Math.max(0, Math.round(s.box.x * scale));
    const y = Math.max(0, Math.round(s.box.y * scale));
    const w = Math.min(src.width - x, Math.round(s.box.w * scale));
    const h = Math.min(src.height - y, Math.round(s.box.h * scale));
    if (w <= 0 || h <= 0) return;
    const dst = new PNG({ width: w, height: h });
    PNG.bitblt(src, dst, x, y, w, h, 0, 0);
    const n = String(i + 1).padStart(2, '0');
    const slug = folderSlug(s.name, 'section').replace(/[^A-Za-z0-9-]+/g, '') || 'section';
    out.push({ file: `sections/${n}-${slug}.png`, buf: PNG.sync.write(dst), id: s.id, name: s.name, box: s.box });
  });
  return out;
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

export async function writeExport(outRoot, payload) {
  const { meta, spec, tokens, files } = payload || {};
  if (!meta || !spec || !Array.isArray(files)) throw new HttpError(400, 'payload needs meta, spec and files[]');
  if (meta.tool !== 'figma-lens') throw new HttpError(400, 'not a figma-lens payload');

  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.base64 !== 'string') throw new HttpError(400, 'bad file entry');
    if (!SAFE_FILE.test(f.path) || f.path.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new HttpError(400, `unsafe file path: ${f.path}`);
    }
    if (f.path === MARKER) throw new HttpError(400, `reserved file name: ${f.path}`);
  }

  const dir = await claimDir(outRoot, folderSlug(meta.nodeName, 'node-' + meta.nodeId), meta.nodeId);
  await fs.mkdir(outRoot, { recursive: true });
  if (await exists(dir)) await fs.rm(dir, { recursive: true, force: true }); // this frame's own previous export
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
  let sectionFiles = [];
  if (screenBuf) {
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
      } else if (meta.sections && meta.sections.length) {
        sectionFiles = cropSections(src, meta.sections, scale);
        for (const s of sectionFiles) {
          const full = insideDir(dir, s.file);
          await fs.mkdir(path.dirname(full), { recursive: true });
          await fs.writeFile(full, s.buf);
        }
      }
    } catch (e) {
      meta.warnings.push(`section crops failed: ${e.message}`);
      sectionFiles = [];
    }
  }
  meta.sectionFiles = sectionFiles.map(({ file, id, name, box }) => ({ file, id, name, box }));

  const usage = summarizeUsage(spec);
  await fs.writeFile(path.join(dir, 'spec.json'), JSON.stringify({ meta, spec }, null, 1));
  await fs.writeFile(path.join(dir, 'tokens.json'), JSON.stringify({ ...(tokens || {}), usage }, null, 1));
  await fs.writeFile(path.join(dir, 'spec.md'), renderMarkdown({ meta, spec, tokens }, usage));
  const { warnings, sections, sectionFiles: _sf, ...markerMeta } = meta;
  await fs.writeFile(path.join(dir, MARKER), JSON.stringify(markerMeta, null, 1));
  await writeIndex(outRoot);

  return { dir, files: files.length + sectionFiles.length + 3 };
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

export function createBridge({ outRoot, log = console.log } = {}) {
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
        const result = await writeExport(root, payload);
        log(`✔ ${payload.meta.nodeName} → ${result.dir} (${result.files} files)`);
        send(res, 200, { ok: true, ...result });
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
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port || Number(process.env.FIGMA_LENS_PORT) || 4141;
  const outRoot = path.resolve(args.out || process.env.FIGMA_LENS_OUT || 'design');
  // Loopback only (never the LAN). Figma may resolve "localhost" to IPv4 or IPv6, so bind both.
  createBridge({ outRoot })
    .on('error', (e) => {
      console.error(`cannot listen on 127.0.0.1:${port}: ${e.message}`);
      process.exit(1);
    })
    .listen(port, '127.0.0.1', () => {
      console.log(`figma-lens bridge ${VERSION} on http://localhost:${port}`);
      console.log(`writing exports to ${outRoot}`);
    });
  createBridge({ outRoot })
    .on('error', () => {
      // IPv6 loopback unavailable; IPv4 is enough
    })
    .listen(port, '::1');
}
