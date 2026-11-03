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
    spec.md                 ← READ FIRST: compact layer tree with exact values
    spec.json               ← full data (+ per-layer CSS from Figma) when spec.md is not enough
    tokens.json             ← variables (all modes), styles, usage counts of raw values
    screen@2x.png           ← full render (2x by default)
    sections/NN-name.png    ← crops of the top-level blocks at full resolution
    assets/*.svg            ← icons/vector art, ready to use
    images/*                ← original bitmaps used as image fills
```

## If there is no export yet

1. Start the bridge for the user's project and keep it running:
   `node <figma-lens>/bridge/server.js --out <project>/design` (or `npm run bridge` inside figma-lens; it writes `./design`).
2. Ask the user to select the frame(s) in Figma desktop → Plugins → Development → Figma Lens → **Export to Claude**.
3. Read `design/INDEX.md` to confirm it arrived.

Never guess a design from a description when an export is possible. Ask for the export.

## Workflow

1. **Read `spec.md` fully** (it is small). Note the frame size, the layout tree, the variables and styles, and the assets.
2. **Look at the images.** Read `sections/*.png` one by one for detail. Use `screen@2x.png` only for the overall picture, because large images are downscaled when you view them. Values always come from the spec, never from measuring pixels.
3. **Map tokens before writing code.** Search the codebase for the existing theme (Flutter `ThemeData`, `AppColors`, `TextTheme`, spacing constants; web CSS variables, Tailwind config). Map each Figma variable or style to the existing token with the same value or name. Use raw values only when no token exists, and tell the user which ones you added.
4. **Reuse components.** A layer marked `component Button {Type=Primary}` should use the project's existing Button widget or component with matching props. Build a new one only if none exists.
5. **Build top-down, following the tree.** Auto layout maps to Row/Column/flex (tables below). Only `@x,y` layers (no auto layout, or `absolute`) need Stack/Positioned or absolute positioning.
6. **Use the exported files.** Put `assets/*.svg` and `images/*` into the project's asset folder and reference them. Never redraw icons and never substitute a different icon set.
7. **Copy text exactly** from `"…"` in spec.md, including case, punctuation and Arabic/RTL strings. Text with several `run` lines needs rich text (TextSpan / nested spans).
8. **Verify.** Run the app or page at the frame's width and compare it section by section with the crops: spacing, sizes, colors, fonts, radii, shadows, alignment, text wrapping. Fix the differences. Report anything you could not match (missing font, unsupported effect).

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
