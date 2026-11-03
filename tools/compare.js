// Compare a screenshot of the built UI against the Figma export, find where they differ,
// and name the Figma layers in those regions so the agent knows what to fix.
import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { readPng, writePng, crop, resize, flatten, hstack } from './image.js';

const DIFF_COLOR = [255, 0, 64];
const r1 = (n) => Math.round(n * 10) / 10;

export function loadDesign(designDir) {
  const specFile = path.join(designDir, 'spec.json');
  if (!fs.existsSync(specFile)) throw new Error(`${designDir} is not a figma-lens export (no spec.json)`);
  const { meta, spec } = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const screenFile = path.join(designDir, meta.screen);
  if (!fs.existsSync(screenFile)) throw new Error(`missing ${screenFile}`);
  return { meta, spec, screen: readPng(screenFile) };
}

function flattenNodes(node, depth = 0, out = []) {
  out.push({ node, depth });
  for (const c of node.children || []) flattenNodes(c, depth + 1, out);
  return out;
}

function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Most specific layers covering a region: high overlap relative to the smaller box, deeper first.
function nodesFor(region, nodes) {
  const ra = region.w * region.h;
  return nodes
    .filter(({ depth }) => depth > 0)
    .map(({ node, depth }) => {
      const na = Math.max(1, node.box.w * node.box.h);
      const inter = overlap(region, node.box);
      return { node, depth, score: inter / Math.min(na, ra), area: na };
    })
    .filter((c) => c.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.depth - a.depth || a.area - b.area)
    .slice(0, 3)
    .map(({ node }) => ({ id: node.id, type: node.type, name: node.name, ...(node.text ? { text: node.text.characters.slice(0, 60) } : {}) }));
}

// Group mismatching pixels into rectangles on a coarse grid (cell = N design units).
function findRegions(mask, W, H, scale, cellUnits, frame, nodes) {
  const cellPx = Math.max(1, Math.round(cellUnits * scale));
  const cols = Math.ceil(W / cellPx);
  const rows = Math.ceil(H / cellPx);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / cellPx) * cols;
    for (let x = 0; x < W; x++) if (mask[y * W + x]) counts[row + Math.floor(x / cellPx)]++;
  }
  const hot = (i) => counts[i] / (cellPx * cellPx) > 0.02;
  const seen = new Uint8Array(cols * rows);
  const regions = [];
  for (let i = 0; i < counts.length; i++) {
    if (seen[i] || !hot(i)) continue;
    let minC = cols, minR = rows, maxC = 0, maxR = 0, px = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      const c = j % cols;
      const r = (j - c) / cols;
      minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      px += counts[j];
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const k = nr * cols + nc;
        if (!seen[k] && hot(k)) { seen[k] = 1; stack.push(k); }
      }
    }
    const x = minC * cellUnits, y = minR * cellUnits;
    const box = {
      x, y,
      w: Math.min(frame.w, (maxC + 1) * cellUnits) - x,
      h: Math.min(frame.h, (maxR + 1) * cellUnits) - y,
    };
    const areaPx = Math.max(1, box.w * box.h * scale * scale);
    regions.push({ box, diffPixels: px, mismatchPct: r1((px / areaPx) * 100), nodes: nodesFor(box, nodes) });
  }
  return regions.sort((a, b) => b.diffPixels - a.diffPixels);
}

/**
 * Pure comparison (no files written). Returns images + stats.
 * cropTop/cropBottom are in pixels of the ACTUAL screenshot (e.g. a phone status bar).
 */
export function computeDiff({ designDir, actualFile, cropTop = 0, cropBottom = 0, threshold = 0.1, cellUnits = 8 }) {
  const { meta, spec, screen } = loadDesign(designDir);
  // Pixels per design unit, measured from the image itself (robust if it isn't exactly frame × meta.scale).
  const scale = meta.width ? screen.width / meta.width : meta.scale || 1;
  const design = flatten(screen);
  let actual = flatten(readPng(actualFile));
  if (cropTop || cropBottom) actual = crop(actual, 0, cropTop, actual.width, actual.height - cropTop - cropBottom);

  // Bring the build onto the design's pixel grid: match width, keep aspect ratio.
  const scaledH = Math.max(1, Math.round(actual.height * (design.width / actual.width)));
  actual = resize(actual, design.width, scaledH);

  const W = design.width;
  const H = Math.min(design.height, actual.height);
  const d = H === design.height ? design : crop(design, 0, 0, W, H);
  const a = H === actual.height ? actual : crop(actual, 0, 0, W, H);
  const diff = new PNG({ width: W, height: H });
  const diffPixels = pixelmatch(d.data, a.data, diff.data, W, H, {
    threshold, includeAA: false, alpha: 0.25, diffColor: DIFF_COLOR, aaColor: [255, 210, 0],
  });

  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < W * H; i += 4, p++) {
    if (diff.data[i] === DIFF_COLOR[0] && diff.data[i + 1] === DIFF_COLOR[1] && diff.data[i + 2] === DIFF_COLOR[2]) mask[p] = 1;
  }
  const frame = { w: meta.width, h: meta.height };
  const nodes = flattenNodes(spec);
  const regions = findRegions(mask, W, H, scale, cellUnits, frame, nodes);

  const sections = (meta.sectionFiles || []).map((s) => {
    let px = 0, total = 0;
    const x0 = Math.max(0, Math.round(s.box.x * scale)), y0 = Math.max(0, Math.round(s.box.y * scale));
    const x1 = Math.min(W, Math.round((s.box.x + s.box.w) * scale)), y1 = Math.min(H, Math.round((s.box.y + s.box.h) * scale));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { total++; px += mask[y * W + x]; }
    return { name: s.name, file: s.file, mismatchPct: total ? r1((px / total) * 100) : null, compared: total > 0 };
  });

  return {
    meta,
    design: d,
    actual: a,
    diff,
    stats: {
      mismatchPct: r1((diffPixels / (W * H)) * 100),
      diffPixels,
      comparedPx: { w: W, h: H },
      heightDelta: r1((actual.height - design.height) / scale), // design units; + = build is taller
      regions,
      sections,
    },
  };
}

function reportMarkdown(meta, stats, files, prev) {
  const out = [];
  out.push(`# Compare: ${meta.nodeName}`);
  out.push('');
  const trend = prev != null ? ` (previous run ${prev}%)` : '';
  out.push(`**Mismatch: ${stats.mismatchPct}%** of compared pixels${trend}. Target: under 2–3% (text anti-aliasing never reaches 0).`);
  out.push('');
  out.push(`Images: \`${files.sideBySide}\` (Figma | build | diff) and \`${files.diff}\` (red = different).`);
  if (Math.abs(stats.heightDelta) >= 2) {
    out.push('');
    out.push(`⚠ The build is **${Math.abs(stats.heightDelta)} units ${stats.heightDelta > 0 ? 'taller' : 'shorter'}** than the frame (${meta.width}×${meta.height}). ` +
      'Only the overlapping height was compared. Check vertical spacing/padding and font line heights first — they shift everything below.');
  }
  out.push('');
  if (stats.sections.some((s) => s.compared)) {
    out.push('## By section');
    for (const s of stats.sections) out.push(`- ${s.name}: ${s.compared ? s.mismatchPct + '%' : 'not compared (outside the build height)'}`);
    out.push('');
  }
  out.push('## Biggest differences (fix top-down)');
  if (!stats.regions.length) out.push('- none above the noise floor 🎉');
  stats.regions.slice(0, 12).forEach((r, i) => {
    const b = r.box;
    const where = r.nodes.length
      ? r.nodes.map((n) => `\`${n.id}\` ${n.type} "${n.name}"${n.text ? ` ("${n.text}")` : ''}`).join(', ')
      : 'no single layer (background / spacing)';
    out.push(`${i + 1}. area ${b.x},${b.y} ${b.w}×${b.h} — ${r.mismatchPct}% different — layers: ${where}`);
  });
  out.push('');
  out.push('Next: open the side-by-side image, look up each listed layer id in spec.md, fix the code, re-run the check.');
  out.push('');
  return out.join('\n');
}

/** Compare and write diff.png, side-by-side.png, report.json, report.md and history.json. */
export function compare(opts) {
  const outDir = opts.outDir || path.join(opts.designDir, 'compare');
  const { meta, design, actual, diff, stats } = computeDiff(opts);
  fs.mkdirSync(outDir, { recursive: true });
  const files = { diff: path.join(outDir, 'diff.png'), sideBySide: path.join(outDir, 'side-by-side.png') };
  writePng(files.diff, diff);
  writePng(files.sideBySide, hstack([design, actual, diff], { bar: 8, barColors: [[91, 91, 214, 255], [31, 35, 40, 255], [255, 0, 64, 255]] }));

  const historyFile = path.join(outDir, 'history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch { history = []; }
  const prev = history.length ? history[history.length - 1].mismatchPct : null;
  history.push({ at: new Date().toISOString(), mismatchPct: stats.mismatchPct, actual: path.resolve(opts.actualFile) });
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 1));

  const report = { frame: meta.nodeName, ...stats, files, previousMismatchPct: prev };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(outDir, 'report.md'), reportMarkdown(meta, stats, files, prev));
  return { ...report, reportFile: path.join(outDir, 'report.md') };
}
