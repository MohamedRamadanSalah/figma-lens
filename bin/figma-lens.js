#!/usr/bin/env node
// figma-lens CLI: bridge, screenshot, compare-and-fix, component map, demo.
import fs from 'node:fs';
import path from 'node:path';
import { startBridge, writeDerived } from '../bridge/server.js';
import { summarizeUsage } from '../bridge/render-md.js';
import { compare } from '../tools/compare.js';
import { shotWeb, shotAdb } from '../tools/shot.js';
import { initMap, loadMap, findMap, MAP_FILE } from '../tools/map.js';
import { makeDemo } from '../tools/demo.js';

const HELP = `figma-lens — let coding agents see Figma designs accurately

Usage:
  figma-lens bridge  [--out design] [--port 4141] [--map figma-lens.map.json]
      Receive exports from the Figma plugin.

  figma-lens check   --design design/<frame> (--url <page url> | --adb) [--viewport] [--crop-top px] [--crop-bottom px] [--fail-above pct]
      Screenshot the build and compare it with the Figma frame (shot + compare in one step).
      Web pages are captured full-page, so a build taller than the frame is reported instead of
      cut off. --viewport captures only the frame-sized viewport (e.g. a scrolling app screen
      whose frame shows one screenful); full-page capture also resizes 100vh / position:fixed.

  figma-lens shot    --design design/<frame> --url <page url> [--out shot.png] [--full] [--wait ms] [--channel msedge|chrome]
  figma-lens shot    --adb [--serial id] --out shot.png
      Screenshot a web page (or Flutter web) at the frame's size, or an Android device/emulator.

  figma-lens compare --design design/<frame> --actual shot.png [--crop-top px] [--crop-bottom px] [--out dir] [--fail-above pct]
      Diff a screenshot against the frame. Writes compare/{report.md,report.json,diff.png,side-by-side.png}.

  figma-lens map     [--design design] [--map figma-lens.map.json]
      Create/extend the component map with every component and token seen in the exports.

  figma-lens render  design/<frame> [--map figma-lens.map.json]
      Re-generate spec.md, the section crops and (for large frames) the per-section spec files,
      e.g. after editing the component map or updating figma-lens. Rewrites spec.json/spec.md and
      replaces <frame>/sections/ (without the screenshot it keeps the existing crops).

  figma-lens demo    --design design/<frame> --before first.png --after fixed.png [--out dir] [--crop-top px]
      Make demo.gif + before-after.png (Figma | build | diff) for a README.
`;

function parse(argv) {
  const flags = {};
  const pos = [];
  const bool = new Set(['full', 'viewport', 'adb', 'json', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (bool.has(key)) flags[key] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`--${key} needs a value`);
        flags[key] = v;
        i++;
      }
    } else pos.push(a);
  }
  return { flags, pos };
}

const num = (v, d) => (v === undefined ? d : Number(v));

function needDesign(flags) {
  if (!flags.design) throw new Error('--design design/<frame> is required');
  const dir = path.resolve(flags.design);
  if (!fs.existsSync(path.join(dir, 'spec.json'))) throw new Error(`${dir} is not a figma-lens export (no spec.json)`);
  return dir;
}

function readMeta(designDir) {
  return JSON.parse(fs.readFileSync(path.join(designDir, 'spec.json'), 'utf8')).meta;
}

function mapNear(designDir, explicit) {
  if (explicit) return loadMap(path.resolve(explicit));
  return loadMap(findMap([path.dirname(designDir), path.dirname(path.dirname(designDir))]));
}

async function takeShot(flags, designDir, out, { fullPage = !!flags.full } = {}) {
  if (flags.adb) return shotAdb({ out, serial: flags.serial });
  const meta = designDir ? readMeta(designDir) : {};
  return shotWeb({
    url: flags.url,
    width: num(flags.width, meta.width || 390),
    height: num(flags.height, meta.height || 844),
    scale: num(flags.scale, meta.scale || 2),
    out,
    fullPage,
    waitMs: num(flags.wait, 800),
    channel: flags.channel,
  });
}

function printCompare(r, flags) {
  if (flags.json) {
    console.log(JSON.stringify(r, null, 1));
  } else {
    const trend = r.previousMismatchPct != null ? ` (was ${r.previousMismatchPct}%)` : '';
    console.log(`${r.frame}: ${r.mismatchPct}% different${trend}`);
    if (Math.abs(r.heightDelta) >= 2) console.log(`  build is ${Math.abs(r.heightDelta)} units ${r.heightDelta > 0 ? 'taller' : 'shorter'} than the frame`);
    for (const g of r.regions.slice(0, 5)) {
      const layers = g.nodes.map((n) => `${n.id} "${n.name}"`).join(', ') || 'background/spacing';
      console.log(`  - ${g.box.x},${g.box.y} ${g.box.w}×${g.box.h}: ${g.mismatchPct}% → ${layers}`);
    }
    console.log(`report: ${r.reportFile}`);
    console.log(`images: ${r.files.sideBySide}`);
  }
  if (flags['fail-above'] !== undefined && r.mismatchPct > Number(flags['fail-above'])) process.exitCode = 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  const { flags, pos } = parse(rest);

  switch (cmd) {
    case 'bridge':
      startBridge({ out: flags.out, port: flags.port && Number(flags.port), map: flags.map });
      return;

    case 'shot': {
      const designDir = flags.adb ? null : needDesign(flags);
      const out = path.resolve(flags.out || 'shot.png');
      await takeShot(flags, designDir, out);
      console.log(`screenshot: ${out}`);
      return;
    }

    case 'compare': {
      const designDir = needDesign(flags);
      if (!flags.actual) throw new Error('--actual <screenshot.png> is required');
      const r = compare({
        designDir,
        actualFile: path.resolve(flags.actual),
        cropTop: num(flags['crop-top'], 0),
        cropBottom: num(flags['crop-bottom'], 0),
        outDir: flags.out && path.resolve(flags.out),
      });
      printCompare(r, flags);
      return;
    }

    case 'check': {
      const designDir = needDesign(flags);
      const outDir = path.resolve(flags.out || path.join(designDir, 'compare'));
      fs.mkdirSync(outDir, { recursive: true });
      const shot = path.join(outDir, 'actual.png');
      // Full page by default: with a frame-sized viewport, anything below the frame height is cut
      // off, so a build that is too tall never shows up as a height difference.
      await takeShot(flags, designDir, shot, { fullPage: !flags.viewport });
      const r = compare({
        designDir,
        actualFile: shot,
        cropTop: num(flags['crop-top'], 0),
        cropBottom: num(flags['crop-bottom'], 0),
        outDir,
      });
      printCompare(r, flags);
      return;
    }

    case 'map': {
      const designRoot = path.resolve(flags.design || 'design');
      const mapFile = path.resolve(flags.map || MAP_FILE);
      const r = initMap({ designRoot, mapFile });
      console.log(`map: ${r.mapFile}`);
      console.log(`added ${r.added.components.length} component(s), ${r.added.tokens.length} token(s)`);
      if (r.unmapped.components.length) console.log(`components still unmapped: ${r.unmapped.components.join(', ')}`);
      if (r.unmapped.tokens.length) console.log(`tokens still unmapped: ${r.unmapped.tokens.length}`);
      return;
    }

    case 'render': {
      const designDir = path.resolve(pos[0] || flags.design || '');
      if (!fs.existsSync(path.join(designDir, 'spec.json'))) throw new Error(`${designDir} is not a figma-lens export (no spec.json)`);
      const { meta, spec } = JSON.parse(fs.readFileSync(path.join(designDir, 'spec.json'), 'utf8'));
      const tokensAll = JSON.parse(fs.readFileSync(path.join(designDir, 'tokens.json'), 'utf8'));
      const { usage, ...tokens } = tokensAll;
      const map = mapNear(designDir, flags.map);
      const screenFile = meta.screen && path.join(designDir, meta.screen);
      const screenBuf = screenFile && fs.existsSync(screenFile) ? fs.readFileSync(screenFile) : null;
      await writeDerived(designDir, { meta, spec, tokens, usage: usage || summarizeUsage(spec), map, screenBuf });
      const parts = meta.sectionPlan.length ? `, ${meta.sectionFiles.length} section crop(s)` : '';
      console.log(`rewrote ${path.join(designDir, 'spec.md')}${parts}${map ? ` using ${map.file}` : ' (no component map found)'}`);
      return;
    }

    case 'demo': {
      const designDir = needDesign(flags);
      if (!flags.before || !flags.after) throw new Error('--before and --after screenshots are required');
      const r = makeDemo({
        designDir,
        before: path.resolve(flags.before),
        after: path.resolve(flags.after),
        outDir: flags.out && path.resolve(flags.out),
        cropTop: num(flags['crop-top'], 0),
        cropBottom: num(flags['crop-bottom'], 0),
      });
      console.log(`${r.frame}: ${r.beforePct}% → ${r.afterPct}% different`);
      console.log(`gif: ${r.gif}`);
      console.log(`png: ${r.png}`);
      return;
    }

    default:
      throw new Error(`unknown command "${cmd}" (run figma-lens help)`);
  }
}

main().catch((e) => {
  console.error(`figma-lens: ${e.message}`);
  process.exitCode = 2;
});
