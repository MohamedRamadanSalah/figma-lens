// Turns a figma-lens payload into a compact, Claude-friendly spec.md, plus a usage
// summary of the raw values (colors, type, spacing, radii, shadows) used in the frame.

import { componentTarget, tokenTarget, targetStr, MAP_FILE } from '../tools/map.js';

const num = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

// Component/token map for the render in progress (renderMarkdown is synchronous).
let MAP = null;

function tokenRef(name) {
  const t = tokenTarget(MAP, name);
  return t ? `${name} ⇒ ${targetStr(t)}` : name;
}

function eachNode(node, fn, parent = null) {
  if (!node) return;
  fn(node, parent);
  for (const c of node.children || []) eachNode(c, fn, node);
}

export function summarizeUsage(spec) {
  const maps = { colors: new Map(), typography: new Map(), spacing: new Map(), radii: new Map(), shadows: new Map() };
  const bump = (kind, value, name) => {
    const m = maps[kind];
    const e = m.get(value) || { value, count: 0, names: new Set() };
    e.count++;
    if (name) e.names.add(name);
    m.set(value, e);
  };
  const visitPaints = (list) => {
    for (const p of list || []) {
      if (p.type === 'solid') bump('colors', p.color, p.var);
      else if (p.stops) p.stops.forEach((s) => bump('colors', s.color));
    }
  };

  eachNode(spec, (n) => {
    if (n.type !== 'TEXT') visitPaints(n.fills);
    if (n.stroke) visitPaints(n.stroke.paints);
    const v = n.vars || {};
    if (n.layout) {
      if (n.layout.gap && n.layout.main !== 'SPACE_BETWEEN') bump('spacing', n.layout.gap, v.itemSpacing);
      const sides = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
      n.layout.padding.forEach((p, i) => p && bump('spacing', p, v[sides[i]]));
    }
    if (n.radius != null) {
      [...new Set([].concat(n.radius))].forEach((r) => r && bump('radii', r, v.cornerRadius || v.topLeftRadius));
    }
    for (const e of n.effects || []) {
      if (e.type.endsWith('shadow')) bump('shadows', `${e.type} ${num(e.x)},${num(e.y)} blur ${num(e.blur)} spread ${num(e.spread)} ${e.color}`, n.effectStyle);
    }
    if (n.text) {
      for (const s of n.text.segments || [n.text]) {
        if (!s.font) continue;
        bump('typography', typeKey(s), s.textStyle);
        visitPaints(s.fills);
      }
    }
  });

  const list = (m) =>
    [...m.values()].sort((a, b) => b.count - a.count).map((e) => ({ value: e.value, count: e.count, names: [...e.names] }));
  return {
    colors: list(maps.colors),
    typography: list(maps.typography),
    spacing: list(maps.spacing),
    radii: list(maps.radii),
    shadows: list(maps.shadows),
  };
}

function typeKey(s) {
  const ls = s.letterSpacing && s.letterSpacing !== 0 && s.letterSpacing !== '0%' ? ` ls ${s.letterSpacing}` : '';
  return `${s.font} ${s.style} (${s.weight}) ${num(s.size)}/${s.lineHeight}${ls}`;
}

function paintStr(p) {
  if (p.type === 'solid') return p.color + (p.var ? ` (${tokenRef(p.var)})` : '');
  if (p.type.startsWith('gradient')) {
    const angle = p.cssAngle != null ? ` ${p.cssAngle}deg` : '';
    const stops = p.stops.map((s) => `${s.color} ${Math.round(s.pos * 100)}%`).join(', ');
    return `${p.type}${angle} [${stops}]${p.opacity != null ? ` opacity ${p.opacity}` : ''}`;
  }
  if (p.type === 'image') return `image(${p.scaleMode}${p.asset ? ' ' + p.asset : ''})`;
  return p.type;
}

const paintsStr = (list) => list.map(paintStr).join(' + ');

function boxSides(v) {
  if (!Array.isArray(v)) return num(v);
  if (v.every((x) => x === v[0])) return num(v[0]);
  return v.map(num).join(',');
}

function layoutStr(L) {
  const out = [L.mode];
  if (L.main === 'SPACE_BETWEEN') out.push('gap auto');
  else if (L.gap) out.push(`gap ${num(L.gap)}`);
  if (L.padding.some((p) => p)) out.push(`pad ${boxSides(L.padding)}`);
  out.push(`main:${L.main}`, `cross:${L.cross}`);
  if (L.wrap) out.push(`wrap${L.rowGap != null ? ` rowGap ${num(L.rowGap)}` : ''}`);
  if (L.grid) out.push(`grid ${L.grid.rows}x${L.grid.cols} gaps ${L.grid.rowGap}/${L.grid.colGap}`);
  return out.join(' ');
}

function effectStr(e) {
  if (e.type.endsWith('shadow')) return `${e.type} ${num(e.x)},${num(e.y)} blur ${num(e.blur)} spread ${num(e.spread)} ${e.color}`;
  if (e.radius != null) return `${e.type} ${num(e.radius)}`;
  return e.type;
}

function quote(s) {
  return '"' + String(s).replace(/\r?\n/g, '\\n') + '"';
}

function textStyleStr(s) {
  const parts = [typeKey(s)];
  const color = (s.fills || []).map(paintStr).join(' + ');
  if (color) parts.push(color);
  if (s.case) parts.push(`case ${s.case}`);
  if (s.decoration) parts.push(`decoration ${s.decoration}`);
  if (s.textStyle) parts.push(`[style ${s.textStyle}]`);
  return parts.join(' ');
}

function textStr(t) {
  const parts = [quote(t.characters)];
  if (t.font) parts.push(textStyleStr(t));
  if (t.align && t.align !== 'LEFT') parts.push(`align ${t.align}`);
  if (t.autoResize) parts.push(`resize ${t.autoResize}`);
  if (t.truncate) parts.push(`ellipsis${t.maxLines ? ` maxLines ${t.maxLines}` : ''}`);
  return parts.join(' · ');
}

function nodeLine(n, parent) {
  const parts = [`\`${n.id}\` ${n.type} ${quote(n.name)} ${num(n.box.w)}×${num(n.box.h)}`];
  const parentAuto = parent && parent.layout;
  if (parent && n.rel && (!parentAuto || n.absolute)) parts.push(`@${num(n.rel.x)},${num(n.rel.y)}`);
  if (n.absolute) parts.push('absolute');
  if (n.sizing && (n.sizing.h !== 'FIXED' || n.sizing.v !== 'FIXED')) parts.push(`w:${n.sizing.h} h:${n.sizing.v}`);
  if (n.grow) parts.push(`grow ${n.grow}`);
  for (const [k, label] of [['minWidth', 'minW'], ['maxWidth', 'maxW'], ['minHeight', 'minH'], ['maxHeight', 'maxH']]) {
    if (n[k] != null) parts.push(`${label} ${num(n[k])}`);
  }
  if (n.constraints && (n.constraints.h !== 'MIN' || n.constraints.v !== 'MIN')) {
    parts.push(`pin ${n.constraints.h}/${n.constraints.v}`);
  }
  if (n.layout) parts.push(layoutStr(n.layout));
  if (n.rotation) parts.push(`rotate ${num(n.rotation)}°`);
  if (n.opacity != null) parts.push(`opacity ${n.opacity}`);
  if (n.blend) parts.push(`blend ${n.blend}`);
  if (n.fills && n.type !== 'TEXT') parts.push(`bg ${paintsStr(n.fills)}${n.fillStyle ? ` [style ${n.fillStyle}]` : ''}`);
  if (n.stroke) {
    const dash = n.stroke.dash ? ` dashed ${n.stroke.dash.join(',')}` : '';
    parts.push(`border ${boxSides(n.stroke.weight)} ${paintsStr(n.stroke.paints)} ${String(n.stroke.align || '').toLowerCase()}${dash}`);
  }
  if (n.radius != null) parts.push(`radius ${boxSides(n.radius)}${n.smoothing ? ` smoothing ${n.smoothing}` : ''}`);
  if (n.effects) parts.push(n.effects.map(effectStr).join(' + ') + (n.effectStyle ? ` [style ${n.effectStyle}]` : ''));
  if (n.mask) parts.push('MASK');
  if (n.component) {
    const c = n.component;
    let s = c.definition ? `defines component ${c.name}` : `component ${c.name}`;
    if (c.variant) s += ` {${c.variant}}`;
    if (c.props) s += ` props{${Object.entries(c.props).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}}`;
    if (MAP && !c.definition) {
      const t = componentTarget(MAP, c.name);
      s += t ? ` ⇒ USE ${targetStr(t)}` : ' ⇒ (not in map)';
    }
    parts.push(s);
  }
  if (n.asset) parts.push(`→ ${n.asset}`);
  if (n.vars) parts.push(`vars{${Object.entries(n.vars).map(([k, v]) => `${k}=${tokenRef(v)}`).join(', ')}}`);
  if (n.text) parts.push(textStr(n.text));
  return parts.join(' · ');
}

// cut: Map(node id → section stem). Those subtrees are written to their own file instead.
function treeLines(n, parent, depth, out, cut = null) {
  const pad = '  '.repeat(depth);
  out.push(`${pad}- ${nodeLine(n, parent)}`);
  if (cut && depth > 0 && cut.has(n.id)) {
    out.push(`${pad}  - … ${countNodes(n) - 1} layers inside: see \`${cut.get(n.id)}.md\``);
    return;
  }
  if (n.text && n.text.segments) {
    for (const s of n.text.segments) out.push(`${pad}    - run ${quote(s.text)}: ${textStyleStr(s)}`);
  }
  for (const c of n.children || []) treeLines(c, n, depth + 1, out, cut);
}

function countNodes(n) {
  let c = 0;
  eachNode(n, () => c++);
  return c;
}

// Trees longer than this get one spec file per section, so the agent can read one section at a time.
export const SPLIT_LINES = 400;

function usageLines(title, list, limit = 25) {
  if (!list.length) return [];
  const out = [`**${title}**`];
  for (const e of list.slice(0, limit)) {
    out.push(`- ${e.value} ×${e.count}${e.names.length ? ` — ${e.names.join(', ')}` : ''}`);
  }
  if (list.length > limit) out.push(`- …${list.length - limit} more in tokens.json`);
  out.push('');
  return out;
}

function fmtVarValue(v) {
  if (v && typeof v === 'object' && v.alias) return `→${v.alias}`;
  return JSON.stringify(v);
}

function componentMapLines(spec, map) {
  const used = new Map();
  eachNode(spec, (n) => {
    if (n.component && !n.component.definition) used.set(n.component.name, (used.get(n.component.name) || 0) + 1);
  });
  if (!used.size) return [];
  const out = ['## Component map'];
  if (!map) {
    out.push(`No \`${MAP_FILE}\` found. Create one with \`figma-lens map --design <design dir>\` and point each component at your real widget, so it gets reused instead of rebuilt.`);
    out.push('');
    return out;
  }
  out.push(`From \`${map.file}\`. **Always use the mapped code** for these components; do not rebuild them.`);
  const missing = [];
  for (const [name, count] of [...used.entries()].sort((a, b) => b[1] - a[1])) {
    const t = componentTarget(map, name);
    if (t) out.push(`- ${name} ×${count} ⇒ ${targetStr(t)}`);
    else missing.push(`${name} ×${count}`);
  }
  if (missing.length) {
    out.push('');
    out.push(`**Not mapped yet:** ${missing.join(', ')}. Find the existing widget in the codebase (or create a reusable one), add it to the map, then run \`figma-lens render <this folder>\`.`);
  }
  out.push('');
  return out;
}

export function renderMarkdown(payload, usage, map = null) {
  MAP = map;
  try {
    return renderMarkdownInner(payload, usage, map);
  } finally {
    MAP = null;
  }
}

/**
 * All spec markdown files for an export: [{file, text}]. Normally just spec.md; for large trees
 * (more than SPLIT_LINES lines) with a section plan, spec.md becomes an overview whose tree stops at
 * each section, and every section gets `<stem>.md` next to its crop(s).
 */
export function renderSpecFiles(payload, usage, map = null) {
  const { meta, spec } = payload;
  const plan = (meta.sectionPlan || []).filter((s) => s.stem);
  const full = [];
  treeLines(spec, null, 0, full);
  if (full.length <= SPLIT_LINES || plan.length < 2) return [{ file: 'spec.md', text: renderMarkdown(payload, usage, map) }];

  const parents = new Map();
  const nodes = new Map();
  eachNode(spec, (n, p) => {
    nodes.set(n.id, n);
    parents.set(n.id, p);
  });
  const sections = plan.filter((s) => nodes.has(s.id) && s.id !== spec.id);
  if (sections.length < 2) return [{ file: 'spec.md', text: renderMarkdown(payload, usage, map) }];
  const cut = new Map(sections.map((s) => [s.id, s.stem]));

  MAP = map;
  try {
    const files = [{ file: 'spec.md', text: renderMarkdownInner(payload, usage, map, cut) }];
    for (const s of sections) {
      const n = nodes.get(s.id);
      const crops = (meta.sectionFiles || []).filter((f) => f.id === s.id).map((f) => `\`${f.file}\``);
      const out = [
        `# ${meta.nodeName} › ${s.name}`,
        '',
        `Section \`${s.id}\` at ${num(s.box.x)},${num(s.box.y)} ${num(s.box.w)}×${num(s.box.h)} in the frame. Part of \`spec.md\` (read its "How to read this", variables and assets first).`,
        crops.length ? `Crop: ${crops.join(', ')}.` : 'No crop for this section (see the warnings in spec.md).',
        '',
        '## Layer tree',
      ];
      treeLines(n, parents.get(s.id), 0, out);
      out.push('');
      files.push({ file: `${s.stem}.md`, text: out.join('\n') });
    }
    return files;
  } finally {
    MAP = null;
  }
}

function cropLine(s, meta) {
  const px = s.px && s.px !== meta.scale ? ` (${s.px}px per unit)` : '';
  return `\`${s.file}\` — ${quote(s.name)} at ${num(s.box.x)},${num(s.box.y)} ${num(s.box.w)}×${num(s.box.h)}${px}`;
}

function renderMarkdownInner(payload, usage, map, cut = null) {
  const { meta, spec, tokens = {} } = payload;
  const out = [];
  out.push(`# ${meta.nodeName}`);
  out.push('');
  out.push(`Figma file **${meta.file}** · page **${meta.page}** · node \`${meta.nodeId}\` (${meta.nodeType}) · ${num(meta.width)}×${num(meta.height)} · exported ${meta.exportedAt} by figma-lens ${meta.version}`);
  out.push('');
  out.push(`Screenshot: \`${meta.screen}\` (scale ${meta.scale}x — divide pixel sizes by ${meta.scale} to get design units).`);
  if (cut) {
    out.push('');
    out.push(`**Large frame: the layer tree is split per section.** Read this file once (no full tree here), then work one section at a time: read its \`.md\`, look at its crop(s), build it, then move on.`);
    for (const s of meta.sectionPlan.filter((p) => cut.has(p.id))) {
      const crops = (meta.sectionFiles || []).filter((f) => f.id === s.id).map((f) => f.file.replace(/^sections\//, ''));
      out.push(`- \`${s.stem}.md\` — ${quote(s.name)} at ${num(s.box.x)},${num(s.box.y)} ${num(s.box.w)}×${num(s.box.h)}${crops.length ? ` · crop ${crops.join(', ')}` : ''}`);
    }
  } else if (meta.sectionFiles && meta.sectionFiles.length) {
    out.push('Section crops (read these for detail):');
    for (const s of meta.sectionFiles) out.push(`- ${cropLine(s, meta)}`);
  }
  out.push('');
  out.push('## How to read this');
  out.push('- Units are design px = CSS px = Flutter logical px. Never scale them by the screenshot factor.');
  out.push('- `@x,y` = position inside the parent; shown only where the parent has no auto layout (or the child is absolute).');
  out.push('- Auto layout: `row|column gap N pad t,r,b,l main:… cross:…`. `w:/h:` sizing is FIXED, HUG (fit content) or FILL (fill parent).');
  out.push('- Paints are listed bottom → top. Colors are `#RRGGBB` or `#RRGGBBAA`. Names in parentheses are Figma variables; `[style …]` are Figma styles — prefer the matching token in code over the raw value.');
  out.push('- Text: `Family Style (weight) size/lineHeight`; lineHeight in px, % or auto; `ls` = letter spacing (px, or % of font size).');
  out.push('- `→ assets/x.svg` = this layer is an icon/vector exported as SVG; use the file, do not redraw it.');
  out.push('');

  if (meta.truncated) out.push('> ⚠ Layer limit reached — this tree is incomplete. Export smaller frames.\n');
  if (meta.warnings && meta.warnings.length) {
    out.push('## Warnings');
    for (const w of meta.warnings) out.push(`- ${w}`);
    out.push('');
  }

  out.push(...componentMapLines(spec, map));

  const cols = Object.entries(tokens.variables || {});
  if (cols.length) {
    out.push('## Variables used');
    for (const [col, data] of cols) {
      out.push(`**${col}** (modes: ${(data.modes || []).join(', ') || 'default'})`);
      for (const [name, v] of Object.entries(data.vars || {})) {
        const vals = Object.entries(v.values || {}).map(([mode, val]) => `${mode} ${fmtVarValue(val)}`).join(' · ');
        const code = v.code ? ` code ${JSON.stringify(v.code)}` : '';
        const t = tokenTarget(MAP, name);
        out.push(`- \`${name}\` ${v.type}: ${vals}${code}${t ? ` ⇒ ${targetStr(t)}` : ''}`);
      }
      out.push('');
    }
  }

  const styles = Object.entries(tokens.styles || {});
  if (styles.length) {
    out.push('## Styles used');
    for (const [name, s] of styles) {
      let desc = s.type;
      if (s.type === 'text') desc = `text ${s.font} ${s.style} ${num(s.size)}/${s.lineHeight} ls ${s.letterSpacing}`;
      else if (s.type === 'paint') desc = `paint ${paintsStr(s.paints || [])}`;
      else if (s.type === 'effect') desc = `effect ${(s.effects || []).map(effectStr).join(' + ')}`;
      const t = tokenTarget(MAP, name);
      out.push(`- \`${name}\`: ${desc}${t ? ` ⇒ ${targetStr(t)}` : ''}`);
    }
    out.push('');
  }

  out.push('## Raw values in this frame (most used first)');
  out.push(...usageLines('Colors', usage.colors));
  out.push(...usageLines('Typography', usage.typography));
  out.push(...usageLines('Spacing (gap/padding)', usage.spacing));
  out.push(...usageLines('Corner radii', usage.radii));
  out.push(...usageLines('Shadows', usage.shadows));

  const assets = [];
  eachNode(spec, (n) => {
    if (n.asset) assets.push(`- \`${n.asset}\` ${num(n.box.w)}×${num(n.box.h)} — ${quote(n.name)}${n.component ? ` (${n.component.name})` : ''}`);
    for (const p of n.fills || []) if (p.type === 'image' && p.asset) assets.push(`- \`${p.asset}\` — image fill of ${quote(n.name)} (${p.scaleMode})`);
  });
  if (assets.length) {
    out.push('## Assets');
    out.push(...[...new Set(assets)]);
    out.push('');
  }

  out.push(cut ? '## Layer tree (overview; each section continues in its own file)' : '## Layer tree');
  const lines = [];
  treeLines(spec, null, 0, lines, cut);
  out.push(...lines);
  out.push('');
  return out.join('\n');
}
