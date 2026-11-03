import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blank, writePng, readPng, resize } from '../tools/image.js';
import { compare, computeDiff } from '../tools/compare.js';
import { initMap, loadMap, componentTarget, tokenTarget } from '../tools/map.js';
import { makeDemo } from '../tools/demo.js';
import { renderMarkdown, summarizeUsage } from '../bridge/render-md.js';

const CLI = fileURLToPath(new URL('../bin/figma-lens.js', import.meta.url));
const BLUE = [91, 91, 214, 255];

// Frame 200×100 design units, exported at 2x. A blue "Card" at 20,20 60×30.
function drawScreen({ scale = 2, cardX = 20, extraTop = 0, extraBottom = 0, w = 200, h = 100 } = {}) {
  const img = blank(w * scale, h * scale + extraTop + extraBottom);
  if (extraTop) for (let y = 0; y < extraTop; y++) for (let x = 0; x < img.width; x++) img.data.set([40, 40, 40, 255], (y * img.width + x) * 4);
  for (let y = 20 * scale; y < 50 * scale; y++) {
    for (let x = cardX * scale; x < (cardX + 60) * scale; x++) img.data.set(BLUE, ((y + extraTop) * img.width + x) * 4);
  }
  return img;
}

function makeExport(root, name = 'card-screen') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    tool: 'figma-lens', nodeName: 'Card Screen', nodeId: '1:1', file: 'f', page: 'p', nodeType: 'FRAME', version: '0.2.0',
    width: 200, height: 100, scale: 2, screen: 'screen@2x.png', exportedAt: '2026-11-04T00:00:00.000Z', warnings: [],
    sectionFiles: [{ file: 'sections/01-card.png', id: '1:5', name: 'Card', box: { x: 20, y: 20, w: 60, h: 30 } }],
  };
  const spec = {
    id: '1:1', name: 'Card Screen', type: 'FRAME', box: { x: 0, y: 0, w: 200, h: 100 }, fills: [{ type: 'solid', color: '#FFFFFF' }],
    children: [
      { id: '1:5', name: 'Card', type: 'INSTANCE', box: { x: 20, y: 20, w: 60, h: 30 }, rel: { x: 20, y: 20 },
        fills: [{ type: 'solid', color: '#5B5BD6', var: 'color/primary' }], component: { name: 'Card', variant: 'Style=Filled' } },
      { id: '1:6', name: 'Icon', type: 'INSTANCE', box: { x: 150, y: 20, w: 24, h: 24 }, rel: { x: 150, y: 20 },
        component: { name: 'Icon/Bell' }, asset: 'assets/icon-bell.svg' },
      { id: '1:7', name: 'Badge', type: 'INSTANCE', box: { x: 150, y: 60, w: 30, h: 16 }, rel: { x: 150, y: 60 }, component: { name: 'Badge' } },
    ],
  };
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ meta, spec }));
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({
    variables: { Colors: { modes: ['Light'], vars: { 'color/primary': { type: 'COLOR', values: { Light: '#5B5BD6' } } } } },
    styles: {},
  }));
  writePng(path.join(dir, 'screen@2x.png'), drawScreen());
  return dir;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'figma-lens-cmp-'));
}

test('identical build at a different pixel density is ~0% different', () => {
  const root = tmp();
  const dir = makeExport(root);
  const shot = path.join(root, 'shot1x.png');
  writePng(shot, drawScreen({ scale: 1 }));
  const { stats } = computeDiff({ designDir: dir, actualFile: shot });
  assert.ok(stats.mismatchPct < 1, `mismatch ${stats.mismatchPct}%`);
  assert.equal(stats.heightDelta, 0);
});

test('a shifted element is found and named by its Figma layer', () => {
  const root = tmp();
  const dir = makeExport(root);
  const shot = path.join(root, 'shifted.png');
  writePng(shot, drawScreen({ cardX: 40 }));
  const r = compare({ designDir: dir, actualFile: shot });
  assert.ok(r.mismatchPct > 2, `mismatch ${r.mismatchPct}%`);
  const named = r.regions.flatMap((g) => g.nodes.map((n) => n.id));
  assert.ok(named.includes('1:5'), `regions name ${JSON.stringify(named)}`);
  assert.ok(r.sections[0].mismatchPct > 10);
  for (const f of ['diff.png', 'side-by-side.png', 'report.json', 'report.md', 'history.json']) {
    assert.ok(fs.existsSync(path.join(dir, 'compare', f)), f);
  }
  const md = fs.readFileSync(path.join(dir, 'compare', 'report.md'), 'utf8');
  assert.match(md, /`1:5` INSTANCE "Card"/);
  // second run remembers the previous score (progress tracking for the fix loop)
  writePng(shot, drawScreen());
  const r2 = compare({ designDir: dir, actualFile: shot });
  assert.equal(r2.previousMismatchPct, r.mismatchPct);
  assert.ok(r2.mismatchPct < 1);
});

test('status bar crop and a taller build are handled', () => {
  const root = tmp();
  const dir = makeExport(root);
  const withBar = path.join(root, 'bar.png');
  writePng(withBar, drawScreen({ extraTop: 48 }));
  assert.ok(computeDiff({ designDir: dir, actualFile: withBar, cropTop: 48 }).stats.mismatchPct < 0.5);

  const taller = path.join(root, 'taller.png');
  writePng(taller, drawScreen({ extraBottom: 60 }));
  const r = compare({ designDir: dir, actualFile: taller });
  assert.equal(r.heightDelta, 30);
  assert.match(fs.readFileSync(r.reportFile, 'utf8'), /30 units taller/);
});

test('resize keeps solid colors exact', () => {
  const img = blank(10, 10, [10, 20, 30, 255]);
  const out = resize(img, 25, 25);
  assert.deepEqual([...out.data.slice(0, 4)], [10, 20, 30, 255]);
});

test('component map: init, lookup (exact + wildcard), and spec.md annotations', () => {
  const root = tmp();
  const design = path.join(root, 'design');
  const dir = makeExport(design);
  const mapFile = path.join(root, 'figma-lens.map.json');

  const r = initMap({ designRoot: design, mapFile });
  assert.deepEqual(r.added.components.sort(), ['Badge', 'Card', 'Icon/Bell']);
  assert.deepEqual(r.added.tokens, ['color/primary']);

  // Real order: `map` already wrote "Icon/Bell": "" — the user then adds a wildcard and leaves it.
  const raw = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  assert.deepEqual(raw.components['Icon/Bell'], { flutter: '', web: '', props: {} });
  raw.components.Card = { flutter: 'lib/widgets/app_card.dart#AppCard', web: '', props: { Style: 'variant' } };
  raw.components['Icon/*'] = "SvgPicture.asset('assets/icons/<name>.svg')";
  raw.tokens['color/primary'] = { flutter: 'AppColors.primary', web: 'var(--primary)' };
  fs.writeFileSync(mapFile, JSON.stringify(raw));

  // re-running init keeps hand-written values
  initMap({ designRoot: design, mapFile });
  const map = loadMap(mapFile);
  assert.equal(componentTarget(map, 'Card').flutter, 'lib/widgets/app_card.dart#AppCard');
  assert.match(componentTarget(map, 'Icon/Bell'), /SvgPicture/);
  assert.equal(componentTarget(map, 'Badge'), null);
  assert.equal(tokenTarget(map, 'color/primary').flutter, 'AppColors.primary');

  const { meta, spec } = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
  const tokens = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
  const md = renderMarkdown({ meta, spec, tokens }, summarizeUsage(spec), map);
  assert.match(md, /component Card \{Style=Filled\} ⇒ USE flutter: lib\/widgets\/app_card\.dart#AppCard · props Style→variant/);
  assert.match(md, /component Badge ⇒ \(not in map\)/);
  assert.match(md, /#5B5BD6 \(color\/primary ⇒ flutter: AppColors\.primary · web: var\(--primary\)\)/);
  assert.match(md, /\*\*Not mapped yet:\*\* Badge ×1/);
  // without a map, spec.md says how to create one and has no arrows
  const plain = renderMarkdown({ meta, spec, tokens }, summarizeUsage(spec), null);
  assert.match(plain, /No `figma-lens\.map\.json` found/);
  assert.doesNotMatch(plain, /⇒/);
});

test('demo builds a GIF and a before/after image', () => {
  const root = tmp();
  const dir = makeExport(root);
  const before = path.join(root, 'before.png');
  const after = path.join(root, 'after.png');
  writePng(before, drawScreen({ cardX: 50 }));
  writePng(after, drawScreen());
  const r = makeDemo({ designDir: dir, before, after });
  assert.equal(fs.readFileSync(r.gif).subarray(0, 6).toString(), 'GIF89a');
  assert.ok(r.beforePct > r.afterPct);
  assert.ok(readPng(r.png).height > 0);
});

test('CLI: help, compare --fail-above exit code, render with map', () => {
  const root = tmp();
  const design = path.join(root, 'design');
  const dir = makeExport(design);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: root });

  const help = run('help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /figma-lens check/);

  const shot = path.join(root, 'shifted.png');
  writePng(shot, drawScreen({ cardX: 40 }));
  const failing = run('compare', '--design', dir, '--actual', shot, '--fail-above', '1');
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stdout, /Card Screen: [\d.]+% different/);

  assert.equal(run('map', '--design', design).status, 0);
  assert.ok(fs.existsSync(path.join(root, 'figma-lens.map.json')));
  const rendered = run('render', dir);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'), /## Component map/);

  const bad = run('compare', '--design', path.join(root, 'nope'), '--actual', shot);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not a figma-lens export/);
});
