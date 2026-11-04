---
name: figma-lens
description: Implement UI from Figma designs with pixel accuracy using figma-lens exports (design/<frame>/spec.md, tokens.json, screenshots, SVG icons) — no Figma MCP or Dev Mode needed. Use whenever the user asks to build, implement, match or fix a screen/component "from Figma", mentions a design/ folder or figma-lens export, or wants Flutter or web (HTML/CSS/React/Tailwind) code that matches a Figma frame.
---

# figma-lens: build UI that matches Figma

figma-lens is a Figma plugin plus a local bridge. The user selects frames in Figma desktop and clicks **Export to Claude**. The bridge writes one folder per frame:

```
design/
  INDEX.md                  ← list of all exported frames (start here)
  <frame>/
    spec.md                 ← READ FIRST: compact layer tree with exact values (an overview for large frames)
    spec.json               ← full data (+ per-layer CSS from Figma) when spec.md is not enough
    tokens.json             ← variables (all modes), styles, usage counts of raw values
    screen@2x.png           ← full render (2x by default)
    sections/NN-name.png    ← crops of the page's blocks (long edge ≤ 1568 px; very tall ones in parts -1, -2…)
    sections/NN-name.md     ← large frames only: that section's layer tree
    assets/*.svg            ← icons/vector art, ready to use
    images/*                ← original bitmaps used as image fills
    compare/                ← written by `figma-lens check` (report.md, side-by-side.png, diff.png)
figma-lens.map.json         ← (project root) Figma component/token → real code in this project
```

The `figma-lens` command is the CLI from the figma-lens repo (`npm link` there makes it global; otherwise run `node <figma-lens>/bin/figma-lens.js …`). Run `figma-lens help` for all commands.

## If there is no export yet

1. Start the bridge for the user's project and keep it running (in the background):
   `figma-lens bridge --out <project>/design`.
2. Ask the user to select the frame(s) in Figma desktop → Plugins → Development → Figma Lens → **Export to Claude**.
3. Read `design/INDEX.md` to confirm it arrived.

Never guess a design from a description when an export is possible. Ask for the export.

## Workflow

1. **Read `spec.md` fully.** Note the frame size, the layout tree, the variables and styles, and the assets. If it starts with **"Large frame: the layer tree is split per section"**, follow "Large frames" below instead of reading every section file up front.
2. **Look at the images.** Read `sections/*.png` one by one for detail. Don't open `screen@2x.png` for a tall page (it gets downscaled to mush and weighs down every later request); for a normal screen use it only for the overall picture. Values always come from the spec, never from measuring pixels.
3. **Use the component map** (see "Component map" below). Every `⇒ USE …` in spec.md is mandatory: use that widget/component and its prop mapping, and use mapped tokens (`(color/primary ⇒ AppColors.primary)`) instead of raw values. For items marked `(not in map)`, search the codebase for the existing theme and widgets (Flutter `ThemeData`, `AppColors`, `TextTheme`, spacing constants, `lib/widgets`; web CSS variables, Tailwind config, `src/components`). Use raw values only when no token exists, and tell the user which ones you added.
4. **Reuse components.** A layer marked `component Button {Type=Primary}` should use the project's existing Button widget or component with matching props. Build a new one only if none exists, make it reusable, and add it to the map.
5. **Build top-down, following the tree.** Auto layout maps to Row/Column/flex (tables below). Only `@x,y` layers (no auto layout, or `absolute`) need Stack/Positioned or absolute positioning.
6. **Use the exported files.** Put `assets/*.svg` and `images/*` into the project's asset folder and reference them. Never redraw icons and never substitute a different icon set.
7. **Copy text exactly** from `"…"` in spec.md, including case, punctuation and Arabic/RTL strings. Text with several `run` lines needs rich text (TextSpan / nested spans).
8. **Verify with the compare-and-fix loop** (below). Don't declare a screen done from reading code; prove it with a screenshot diff.

## Large frames (long landing pages, HTML imports)

Every image you open stays in the conversation and is re-sent with every later request. A few full-width crops of a tall page can make the session slow or fail outright. So:

- **One section at a time.** Read `sections/NN-name.md`, look at its crop(s), build that section, then move to the next. Don't load all crops first.
- **One image per turn**, and only the crop you are working on. If you need your own crop (e.g. a detail), make it ≤ 800 px wide.
- **Write the page in parts** (one edit per section) instead of one huge file write.
- **Export from older figma-lens?** If `sections/` holds a single crop of the whole page or spec.md is over ~40 KB, run `figma-lens render design/<frame>` first: it re-crops the sections and splits the spec.
- In the compare loop, look at `side-by-side.png` only when the report's regions aren't enough, since it is as tall as the page.

## Compare-and-fix loop

After building a screen, compare the real result against Figma and fix what differs:

1. **Run the build** showing that screen:
   - Web: start the dev server and open the route.
   - Flutter web: `flutter run -d web-server --web-port 8080`, then use that URL.
   - Flutter Android: run the app on an emulator/device and navigate to the screen.
2. **Check it:**
   - Web / Flutter web: `figma-lens check --design design/<frame> --url http://localhost:<port>/<route>`
     (the viewport is set to the frame's width and scale automatically, and the whole page is captured, so a
     build taller than the frame shows up as "N units taller"). For an app screen that scrolls on purpose and
     whose frame shows one screenful, add `--viewport`.
   - Android: `figma-lens check --design design/<frame> --adb --crop-top <status bar px> [--crop-bottom <nav bar px>]`
     (status bar ≈ 24–48 dp × device density; crop it so only the app content is compared).
3. **Read `design/<frame>/compare/report.md`** (mismatch %, the biggest differing areas and the Figma layer ids in each) and **look at `compare/side-by-side.png`** (Figma | build | diff, red = different).
4. **Fix top-down**: height or spacing differences first (they shift everything below), then sizes, colors, typography, radii, shadows. Look up each listed layer id in spec.md for the exact values.
5. **Re-run the check.** The report shows the previous score, so you can see progress.
6. **Stop** when mismatch is ≤ 3% (text anti-aliasing never reaches 0) or when two runs in a row stop improving. Then report the final score and anything you could not match, and why (missing font, platform rendering, dynamic data).

Rules: fix the real code, never game the diff (no screenshots or images of the design inside the app). Use the same data/text as the design when checking (mock data if needed), otherwise text differences dominate the score.

## Component map

`figma-lens.map.json` (project root) maps Figma components and tokens to this project's code:

```json
{
  "components": {
    "Button": { "flutter": "lib/widgets/app_button.dart#AppButton", "web": "src/components/Button.tsx#Button", "props": { "Label": "label", "Type": "variant" } },
    "Icon/*": "SvgPicture.asset('assets/icons/<name>.svg')"
  },
  "tokens": { "color/primary": { "flutter": "AppColors.primary", "web": "var(--color-primary)" } }
}
```

- No map yet → run `figma-lens map --design design`. It adds every component and token from the exports with empty values (`""`).
- **Fill it yourself**: search the codebase for each component (by name, by look, by props) and each token value; write `path#Symbol` (or an expression). Leave `""` only when nothing exists yet. `"Prefix/*"` matches a whole family (icons).
- After editing the map, run `figma-lens render design/<frame>` so spec.md shows the `⇒ USE` arrows. The bridge also applies the map on every new export.
- When you create a new reusable widget for an unmapped component, add it to the map.

## Reading spec.md

- Units are design px, which equal CSS px and Flutter logical px. Never multiply by the screenshot scale.
- `row|column gap G pad t,r,b,l main:X cross:Y` is auto layout. `pad 16` means all four sides are 16. `gap auto` means space-between.
- `w:FILL h:HUG` gives sizing on each axis: FIXED (exact size shown), HUG (wrap content) or FILL (take available space).
- `@x,y` is the position inside the parent. `absolute` means an absolutely positioned child inside an auto layout. `pin H/V` gives constraints (MIN = left/top, MAX = right/bottom, STRETCH = both, CENTER, SCALE).
- `bg A + B` lists paints bottom → top. `(name)` is a Figma variable and `[style name]` is a Figma style.
- Colors are `#RRGGBB` or `#RRGGBBAA` (alpha last).
- Text uses the format `"chars" · Family Style (weight) size/lineHeight color`. lineHeight is px, % or auto. `ls` is letter spacing in px, or in % of the font size.
- `radius 12` sets every corner. `radius tl,tr,br,bl` sets each corner. `smoothing` is iOS-style corner smoothing; approximate it, or ignore it in Flutter unless a squircle package is in use.
- `drop-shadow x,y blur B spread S color`, `inner-shadow`, `layer-blur R`, `background-blur R`.
- `→ assets/x.svg` means the layer is an icon. Use the SVG at the listed size.
- `vars{itemSpacing=space/md}` means the layer property is bound to that variable. Use the token.

## Flutter mapping

| Figma | Flutter |
|---|---|
| column / row | `Column` / `Row` (use `spacing: G` on Flutter ≥ 3.27, otherwise `SizedBox` gaps) |
| wrap, rowGap R | `Wrap(spacing: G, runSpacing: R)` |
| pad t,r,b,l | `Padding(padding: EdgeInsets.fromLTRB(l, t, r, b))`. Watch the order. |
| main MIN / CENTER / MAX / SPACE_BETWEEN | `MainAxisAlignment.start / center / end / spaceBetween` |
| cross MIN / CENTER / MAX / BASELINE | `CrossAxisAlignment.start / center / end / baseline` (baseline needs `textBaseline`) |
| HUG on main axis | `mainAxisSize: MainAxisSize.min` |
| FILL on parent's main axis | `Expanded` (or `Flexible`); `grow N` sets `flex: N` |
| FILL on parent's cross axis | `CrossAxisAlignment.stretch` on the parent, or `SizedBox(width: double.infinity)` |
| FIXED w×h | `SizedBox(width: w, height: h)` |
| `@x,y` / absolute | `Stack` + `Positioned(left: x, top: y)`; use `pin` for right/bottom |
| bg solid | `BoxDecoration(color: Color(0xAARRGGBB))`. Move alpha to the front: `#11223380` → `0x80112233`. |
| gradient-linear from/to | `LinearGradient(begin: Alignment(fx*2-1, fy*2-1), end: Alignment(tx*2-1, ty*2-1), colors, stops)` using `from`/`to` in spec.json |
| radius | `BorderRadius.circular(r)` or `BorderRadius.only(...)` |
| border W color inside | `Border.all(width: W, color: …)` (inside is Flutter's default; center/outside need `strokeAlign`) |
| drop-shadow x,y blur B spread S | `BoxShadow(offset: Offset(x, y), blurRadius: B, spreadRadius: S, color: …)` |
| background-blur R | `ClipRRect` + `BackdropFilter(filter: ImageFilter.blur(sigmaX: R/2, sigmaY: R/2))` |
| opacity | `Opacity` (or color alpha for paints) |
| text size/lineHeight | `TextStyle(fontSize: size, height: lineHeight / size)`. For %: `height: pct/100`. Set `leadingDistribution: TextLeadingDistribution.even` to match Figma's vertical centering. |
| weight 600 | `FontWeight.w600` |
| ls px / ls % | `letterSpacing: px` / `letterSpacing: size * pct / 100` |
| ellipsis maxLines N | `maxLines: N, overflow: TextOverflow.ellipsis` |
| align CENTER | `textAlign: TextAlign.center`. For RTL screens, use `TextAlign.start` and `EdgeInsetsDirectional`. |
| assets/x.svg | `SvgPicture.asset('assets/…/x.svg', width:, height:)` (flutter_svg) |
| image fill FILL / FIT | `Image.asset(fit: BoxFit.cover / BoxFit.contain)` |

## Web (CSS / Tailwind / React) mapping

| Figma | CSS |
|---|---|
| column / row | `display:flex; flex-direction: column / row; gap: Gpx` |
| wrap, rowGap R | `flex-wrap: wrap; column-gap: G; row-gap: R` |
| pad t,r,b,l | `padding: t r b l` (same order as CSS) |
| main MIN / CENTER / MAX / SPACE_BETWEEN | `justify-content: flex-start / center / flex-end / space-between` |
| cross MIN / CENTER / MAX / BASELINE | `align-items: flex-start / center / flex-end / baseline` |
| HUG | `width/height: fit-content` (or just auto) |
| FILL (main axis) | `flex: 1 1 0; min-width: 0` |
| FILL (cross axis) | `align-self: stretch` |
| FIXED | `width: Wpx; height: Hpx; flex-shrink: 0` |
| `@x,y` / absolute | parent `position: relative`; child `position:absolute; left:x; top:y` (use `pin` for right/bottom) |
| colors `#RRGGBBAA` | valid CSS as is |
| gradient-linear `Ndeg` | `linear-gradient(Ndeg, c1 p1%, c2 p2%)` |
| drop-shadow | `box-shadow: x y B S color` (inner-shadow adds `inset`) |
| layer-blur / background-blur R | `filter: blur(R/2 px)` / `backdrop-filter: blur(R/2 px)` |
| text | `font: weight size/lineHeight family; letter-spacing` (ls % → `pct/100 em`) |
| ellipsis maxLines N | `display:-webkit-box; -webkit-line-clamp:N; -webkit-box-orient:vertical; overflow:hidden` |
| assets/x.svg | `<img src>` or inline SVG; keep the exported size |

`spec.json` also has Figma's own generated CSS (`css`) for most layers. Use it to cross-check the CSS values; tokens and layout structure still come from the tree above.

## Rules

- Spec values beat what you see in the image. When they conflict, trust the spec and mention the conflict.
- Don't round or "improve" values (14 stays 14, not 16) unless the user asks for normalization to tokens.
- Hidden layers are not exported. Don't invent states (hover, error, empty) that aren't in the export; ask for those frames.
- Flag missing fonts. If the font family isn't bundled in the project, say so and tell the user what to add (pubspec fonts / @font-face).
- For several breakpoints or states, ask the user to export each frame. Each one becomes its own folder.
