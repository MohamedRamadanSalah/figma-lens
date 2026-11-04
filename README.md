# figma-lens

Let Claude Code (or any coding agent) **see Figma designs accurately**, **check its own result against them**, and **reuse your real widgets**, without the Figma MCP, the REST API or Dev Mode.

1. **Export:** a Figma plugin reads the frame you select. A local bridge writes everything an agent needs to implement it in Flutter or on the web for any technology.
2. **Compare-and-fix loop:** `figma-lens check` screenshots what the agent built, diffs it against the Figma render, and names the Figma layers that differ, so the agent can fix them and re-check.
3. **Component map:** `figma-lens.map.json` ties Figma components and tokens to your real code (`Button → lib/widgets/app_button.dart#AppButton`), so the agent reuses them instead of rebuilding them.

![Compare-and-fix loop: Figma | build | diff, first build vs fixed build](docs/compare-loop.gif)

*Output of `figma-lens demo` on a small test page (not a real Figma file). First frame: the first build (red bar) has the button 20px too low and the wrong color, so the diff marks it. Second frame: the fixed build (green bar), 0% different.*

```
design/<frame>/
  spec.md            compact layer tree: auto layout, sizes, colors, text, radii, shadows, components, variables
  spec.json          full data, including Figma's generated CSS per layer
  tokens.json        variables (every mode), styles, and usage counts of raw values
  screen@2x.png      full render
  sections/*.png     the page's blocks, cropped (long edge ≤ 1568 px; one huge block is split into its children)
  sections/*.md      large frames only: one layer tree per section, so the agent reads one at a time
  assets/*.svg       icons and vector art
  images/*           original bitmaps
  compare/           report.md, side-by-side.png, diff.png (written by `figma-lens check`)
figma-lens.map.json  your components/tokens → real code (project root)
```

## Why not the REST API or MCP?

- On View/Collab seats, Figma's REST API allows **6 file/image reads per month**. A plugin runs inside Figma, so it has no rate limits and needs no token.
- `getCSSAsync()` gives the plugin Dev Mode–style CSS without a Dev Mode seat.
- Everything stays on your machine.

## Setup (once)

```bash
git clone https://github.com/MohamedRamadanSalah/figma-lens
cd figma-lens
npm install
npm run build                       # type-checks and bundles plugin/dist/code.js
npm link                            # optional: makes the `figma-lens` command global
cp -r skill/figma-lens ~/.claude/skills/   # the Claude Code skill
```

In the **Figma desktop app**: Plugins → Development → **Import plugin from manifest…** → choose `plugin/manifest.json`. Development plugins can't be imported in the browser.

Screenshots of web pages use your installed **Edge or Chrome** (no browser download). Android screenshots use **adb**.

## Use

1. Start the bridge and point it at your app's repo:
   ```bash
   figma-lens bridge --out ../my-app/design
   ```
2. In Figma, select one or more frames → Plugins → Development → **Figma Lens** → **Export to Claude**. The pill turns green when the bridge is reachable.
3. Ask Claude: *"Implement design/login-screen in Flutter, then run the compare loop until it matches."*

### Compare-and-fix loop

```bash
# web, or Flutter web (flutter run -d web-server --web-port 8080)
figma-lens check --design design/home --url http://localhost:8080/

# Flutter on an Android emulator/device (crop the status bar)
figma-lens check --design design/home --adb --crop-top 96
```

Output (from the test page above):

```
Home: 19.4% different
  - 24,96 344×72: 91.6% → 1:3 "Continue button"
report: design/home/compare/report.md
images: design/home/compare/side-by-side.png
```

After the fix, the next run prints `Home: 0% different (was 19.4%)`.

- The viewport is set to the frame's width and scale automatically, and the whole page is captured, so a build that is taller than the frame is reported instead of cut off (`--viewport` captures only one frame-sized screen). Screenshots at any density are resized onto the design's pixel grid.
- `report.md` lists the biggest differing areas with the **Figma layer ids** in them, per-section scores, and whether the build is taller or shorter than the frame.
- Each run records its score in `compare/history.json`, so the agent can see progress.
- `--fail-above 3` exits with code 1 when the mismatch is above 3%, for CI.
- `figma-lens compare --design … --actual shot.png` compares a screenshot you already have.

### Component map

```bash
figma-lens map --design design      # creates/extends figma-lens.map.json with every component and token seen
```

```json
{
  "components": {
    "Button": { "flutter": "lib/widgets/app_button.dart#AppButton", "web": "src/components/Button.tsx#Button", "props": { "Label": "label", "Type": "variant" } },
    "Icon/*": "SvgPicture.asset('assets/icons/<name>.svg')"
  },
  "tokens": { "color/primary": { "flutter": "AppColors.primary", "web": "var(--color-primary)" } }
}
```

Fill the empty values yourself, or let Claude find your widgets and fill them. spec.md then shows `component Button {Type=Primary} ⇒ USE flutter: lib/widgets/app_button.dart#AppButton · props Label→label`, colors like `#5B5BD6 (color/primary ⇒ AppColors.primary)`, and a list of components that are **not mapped yet**. The bridge applies the map on every export; `figma-lens render design/<frame>` refreshes an existing spec.md after you edit the map. `"Prefix/*"` keys match a whole family, such as icons.

### Demo for your own README

```bash
figma-lens demo --design design/login-screen --before first-build.png --after fixed-build.png
```

This writes `demo/demo.gif` (first build → fixed build) and `demo/before-after.png`. Each frame is Figma | build | diff; the bars are blue = Figma, red = first build, green = fixed build, pink = diff.

## All commands

| Command | What it does |
|---|---|
| `figma-lens bridge [--out design] [--port 4141] [--map file]` | Receives exports from the plugin |
| `figma-lens check --design <dir> (--url <url> \| --adb)` | Screenshot + compare in one step |
| `figma-lens shot --design <dir> --url <url>` / `--adb --out shot.png` | Screenshot only |
| `figma-lens compare --design <dir> --actual <png>` | Compare an existing screenshot |
| `figma-lens map [--design design] [--map file]` | Create/extend the component map |
| `figma-lens render <dir> [--map file]` | Regenerate spec.md, section crops and section specs (after editing the map or updating figma-lens) |
| `figma-lens demo --design <dir> --before <png> --after <png>` | GIF + before/after image |

Common flags: `--crop-top/--crop-bottom <px>` (phone status/nav bars), `--fail-above <pct>`, `--full` (full-page web screenshot), `--wait <ms>`, `--channel msedge|chrome`, `--serial <adb device>`, `--json`.

## Plugin and bridge options

| Plugin option | Effect |
|---|---|
| Screenshot scale | 1x / 2x / 3x PNG render (default 2x) |
| Include CSS per layer | adds Figma's CSS to `spec.json` (first 800 layers) |
| Section crops | the bridge crops the page's blocks out of the screenshot (and splits spec.md per section for large frames) |

| Bridge flag / env | Default |
|---|---|
| `--out <dir>` / `FIGMA_LENS_OUT` | `./design` |
| `--port <n>` / `FIGMA_LENS_PORT` | `4141`. If you change it, also change `devAllowedDomains` in the manifest and the URL in the plugin. |
| `--map <file>` | `figma-lens.map.json` in the out dir or its parent |
| `FIGMA_LENS_ALLOW_ANY_ORIGIN=1` | off. The bridge accepts only the plugin (origin `null`), figma.com and non-browser clients. |

## Safety

- The bridge listens on loopback only (127.0.0.1 and ::1), never on your LAN.
- It writes only inside the out dir, rejects path traversal, and never replaces a folder it didn't create (`.figma-lens.json` marker). Frames with the same name get separate folders.
- Web pages open in your browser can't post to it (Origin check).
- A broken map file never blocks an export; spec.md shows a warning instead.

## What gets exported

Auto layout (direction, gap, padding, alignment, wrap, grid), sizing (FIXED/HUG/FILL), absolute positions and constraints, fills (solid, gradients with angle and endpoints, images), strokes, per-corner radii, shadows and blurs, opacity and blend, text (characters, font, weight, size, line height, letter spacing, case, decoration, mixed-style runs, truncation), component and variant names and properties, bound variables with values for every mode, styles. Hidden layers are skipped. Vector-only groups become one SVG, deduplicated by content.

## Development

```bash
npm test        # builds the plugin, then runs all tests (node:test)
npm run watch   # rebuild the plugin on change
```

## Roadmap

- Listening mode: the plugin stays open and the agent pulls frames itself (by name or Figma link).
- Numbered overlay image that links each box on the screenshot to its layer id.
- Token export to Style Dictionary (CSS variables, Tailwind config, Flutter `ThemeData`).

## License

MIT
