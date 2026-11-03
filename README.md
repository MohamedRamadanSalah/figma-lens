# figma-lens

Let Claude Code (or any coding agent) **see Figma designs accurately** without the Figma MCP, the REST API or Dev Mode.

A Figma plugin reads the frame you select. A local bridge writes everything an agent needs to implement it pixel-accurately, in Flutter or on the web:

```
design/<frame>/
  spec.md            compact layer tree: auto layout, sizes, colors, text, radii, shadows, components, variables
  spec.json          full data, including Figma's generated CSS per layer
  tokens.json        variables (every mode), styles, and usage counts of raw values
  screen@2x.png      full render
  sections/*.png     top-level blocks cropped at full resolution
  assets/*.svg       icons and vector art
  images/*           original bitmaps
```

## Why not the REST API or MCP?

- On View/Collab seats, Figma's REST API allows **6 file/image reads per month**. A plugin runs inside Figma, so it has no rate limits and needs no token.
- `getCSSAsync()` gives the plugin Dev Mode–style CSS without a Dev Mode seat.
- Everything stays on your machine.

## Setup (once)

```bash
npm install
npm run build          # type-checks and bundles plugin/dist/code.js
```

In the **Figma desktop app**: Plugins → Development → **Import plugin from manifest…** → choose `plugin/manifest.json`. Development plugins can't be imported in the browser.

## Use

1. Start the bridge and point it at your app's repo:
   ```bash
   npm run bridge                                   # writes ./design
   node bridge/server.js --out ../my-app/design     # or straight into a project
   ```
2. In Figma, select one or more frames → Plugins → Development → **Figma Lens** → **Export to Claude**. The pill turns green when the bridge is reachable.
3. Ask Claude: *"Implement design/login-screen in Flutter"*.

Install the Claude Code skill so Claude knows how to read the export and map it to Flutter or CSS:

```bash
# per user
cp -r skill/figma-lens ~/.claude/skills/
# or per project
cp -r skill/figma-lens <project>/.claude/skills/
```

## Options

| Plugin option | Effect |
|---|---|
| Screenshot scale | 1x / 2x / 3x PNG render (default 2x) |
| Include CSS per layer | adds Figma's CSS to `spec.json` (first 800 layers) |
| Section crops | the bridge crops top-level blocks out of the screenshot |

| Bridge flag / env | Default |
|---|---|
| `--out <dir>` / `FIGMA_LENS_OUT` | `./design` |
| `--port <n>` / `FIGMA_LENS_PORT` | `4141`. If you change it, also change `devAllowedDomains` in the manifest and the URL in the plugin. |
| `FIGMA_LENS_ALLOW_ANY_ORIGIN=1` | off. The bridge accepts only the plugin (origin `null`), figma.com and non-browser clients. |

## Safety

- The bridge listens on loopback only (127.0.0.1 and ::1), never on your LAN.
- It writes only inside the out dir, rejects path traversal, and refuses to replace a folder it didn't create (`.figma-lens.json` marker).
- Web pages open in your browser can't post to it (Origin check).

## What gets exported

Auto layout (direction, gap, padding, alignment, wrap, grid), sizing (FIXED/HUG/FILL), absolute positions and constraints, fills (solid, gradients with angle and endpoints, images), strokes, per-corner radii, shadows and blurs, opacity and blend, text (characters, font, weight, size, line height, letter spacing, case, decoration, mixed-style runs, truncation), component and variant names and properties, bound variables with values for every mode, styles. Hidden layers are skipped. Vector-only groups become one SVG, deduplicated by content.

## Development

```bash
npm test        # bridge tests (node:test)
npm run watch   # rebuild the plugin on change
```

## Roadmap

- Visual diff loop: screenshot the implementation (Playwright for web, emulator/golden for Flutter), diff it against `screen@2x.png`, write a heatmap, and let the agent iterate.
- Numbered overlay image that links each box on the screenshot to its layer id.
- Token export to Style Dictionary (CSS variables, Tailwind config, Flutter `ThemeData`).

## License

MIT
