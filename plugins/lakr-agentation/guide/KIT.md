# @lakr/kit — the premium kit (API reference for film code)

Film code is ONE TSX module. It may import only:
- `react` (default `React`, hooks),
- `remotion`: `AbsoluteFill, Sequence, Series, Loop, Freeze, interpolate, interpolateColors, spring, Easing, random, useCurrentFrame, useVideoConfig` — nothing else,
- `@lakr/kit` (below).
It must `export const Shots = { <shotId>: Component, … }` — one component per plan shot, keyed by the plan's shot ids.
Each shot component renders full-frame (the host gives it an `AbsoluteFill`, the shot's own frame clock starting at 0, and its cues).
The frame number is the only clock: no timers, no Date, no Math.random (use `rand(seed)`), no fetch/window/document, no `<img>/<video>/<style>/<script>/<a>/<input>`, no `src`/`href`/`ref`/`dangerouslySetInnerHTML`, no URLs or `url(...)` in strings (`url(#id)` for SVG defs is fine). Draw everything with divs, text and inline SVG (`svg, path, rect, circle, line, g, defs, linearGradient, radialGradient, stop, clipPath, mask, filter, feGaussianBlur`).
The canvas is the film's size (1920×1080 for 16:9; 1080×1920 for 9:16). Times in the kit are **frames** of the shot unless a prop says seconds; get frames from cues (`useCue`) or `useSec()(seconds)`.

## Timing
- `useShot()` → `{ frame, fps, width, height, t (s), durationInFrames, seconds, progress (0..1) }`.
- `useCue(id)` → `{ at, frames, since, on, progress }` — `at` = the shot-local frame the plan's cue fires on; `frames` = its length (type/count/draw); `progress` 0..1 over it. **Drive every interaction from its cue** (the sound is placed from the same cue).
- `useSec()` → `(seconds) => frames`.
- `usePalette()` → `{ ground, ink, muted, accent, accent2?, surface, line, dark }`; `useFilm()` → `{ palette, font, plan }`.

## Motion (speed-ramped; nothing linear, nothing bouncy on UI)
- `EASE.out` (THE move: rush then long settle) · `EASE.inOut` (camera between framings) · `EASE.in` (leaving / rushing into the lens) · `EASE.soft` (drifts) · `EASE.snap` (UI state changes) · `EASE.ramp` (SPEED RAMP: rush → near-freeze → hit; Camera key `ease: 'ramp'` into a hero).
- `ramp(frame, a, b, from=0, to=1, ease=EASE.out)` clamped. `keys(frame, [[f, v], …], ease)` keyframes. `springIn(frame, fps, start, 'ui'|'soft'|'pop')` 0→1. `stagger(i, fps, ms=50)`. `clamp01`, `mix(a,b,t)`, `rand(seed)`.

## Ground & light
- `<Ground tone?="ground"|"surface"|"dark"|hex light?=0.5 vignette?=0>` — FIRST child of every shot: the neutral ground + a soft top light.
- `<Glow x y size color? color2? opacity?=0.35>` — a soft colour bloom (px, centre) BEHIND a focal element. ≤ 1 per shot.
- `<Grain amount?=0.12>` — film grain, optional.

## Camera & 3D
- `<Camera keys={[{at: seconds, x?, y?, zoom?, rx?, ry?, rz?, focus?: {x,y,w,h}, fill?: 0.8, ease?: 'out'|'inOut'|'in'|'soft'|'snap'}, …]} blur?=true drift?=0.015>` — films its children (laid out at full frame size). `focus` frames a px box of the content (macro on the element in use → pull out → push into the next). Values carry from the previous key; zoom interpolates in log space; motion blur is measured from the move. `drift` keeps holds alive.
- `<Stage3D perspective?>` + `<Plane x y w h z? rx? ry? rz? shadow? radius?>` — UI planes in depth (fly over a tilted dashboard, a deck of cards). Put the Stage3D inside a Camera to move through it.

## Look — grounds and finishes (pick per act; the film's look is a DESIGN SYSTEM, not effects)
- `<Ground look?='plain'|'paper'|'spot'|'mesh'|'reeded' tone? …>` — `paper` warm light with a soft falloff (calm, editorial); `spot` Apple's dark stage, one top light + floor glow (the hero object); `mesh` the brand as vivid drifting light (ClickUp; type on it is white); `reeded` fluted glass over a sliding brand gradient (one statement on it). `tone="accent"` = the brand colour full-frame.
- `<GlowEdge radius?>` — a card's gradient rim + soft accent bloom (on dark / spot / mesh). `<Reflect>` — a floor reflection under an object on `spot`/dark.
- `SPACE` {xs 8, s 16, m 24, l 32, xl 48, xxl 64, xxxl 96, margin 120} and `TYPE` {ui 24, label 32, line 64, title 96, statement 176, display 240} — USE THESE NUMBERS for every gap, padding, margin and film-word size.
- The host lays a fine grain + vignette over the whole film (no need to add one).

## Compositions — finished frames (USE THESE for the product; the references' design, not a screenshot on a flat ground)
- `<Hero3D w h side?='right'|'left'|'center' scale? rx?=9 ry? at?>{<the app screen at its natural px size>}</Hero3D>` — the app as an object in space: tilted, lit along its top edge, an accent light pool under it, drifting ~4° and running off the frame. The ONE establishing shot of the whole app (words, if any, in the free side's top third).
- `<Lift w h scale?=2.4 behind={<the app screen>} x? y? at?>{<one component>}</Lift>` — one component (a row, a card, a picker, a toast) lifted out of its app at 2–3×, the app blurred and dimmed behind it, deep shadow + hairline + accent glow. The default way to show a FEATURE: every feature shot is a Lift or a Camera macro, never the full app small.
- `<Smash text at? size?=0.42 accent? align?>` — ONE word at 35–50 % of the frame height, allowed to bleed off, landing in 6 frames with an echo, then pushing. Once or twice a film, on the beat (the turn, or the payoff) — the scale contrast the references have and plain captions never do.

## Carry — the story moves through ONE object (times in these six are SECONDS from the shot start; px positions)
- `<Morph states={[{at, w, h, r?, fill?, x?, y?, border?, content?}, …]} dur?=0.28>` — ONE container becomes the next thing (pill → spinner → check → card → toggle): size, radius, fill, position tween; old content blurs out, new blurs in. The film's STORY OBJECT: give it 3+ states across the film.
- `<Connector from={{x,y}} to={{x,y}} at dur? curve?=0.22 comet?>` — a dot draws a curve from one element to the next and lands with a pulse (comet: a sparkle with a trail). Links "said" → "done", the last line → the logo. Full-frame layer.
- `<WordSwap words={[…]} at every?=0.9 size? before? after?>` — one slot in a sentence cycles words (up-and-blur out, rise-and-unblur in); the sentence reflows. Instead of a list of captions.
- `<ScatterRegroup from to at dur? size?>` — letters scatter and regroup into the next word (shared letters travel).
- `<PunchIn at={[s…]} scales?=[1,3.2,1] focus?>{full-frame child}</PunchIn>` — matched punch-in hard cuts on the beat: the same element re-framed ×1 → ×3 → ×1.
- `<Echo vx vy copies?=3>` — trailing echo copies along a move instead of blur (fast slides, flying cards).
- `<Cursor>` is now big (≈ 3.7 % of the height) and presses (0.9) on clicks — the click lands ON the element and its state changes that frame.

## Layout — the key object is centred; words never share space with it
- `<Center y?>` — the key object, centred.
- `<Stack words={…} band?=0.22 below?>` — words in a top (or bottom) band, the object centred in the rest.
- `<Split words={…} split?=0.38 wordsRight?>` — words in a column, the object centred in the other.
- `<Flank left={…} right={…} objectWidth?=0.4>` — "see · object · what".
- `<Canvas w h fit?>` — a fixed px canvas (a rebuilt screen in its own pixels, e.g. 1600×1000), centred and scaled to fit the safe area.
Use these for EVERY shot that has words + an object; free absolute positioning only inside a Canvas/component.

## UI atoms (rebuild the product's screens; pass the product's own hex colours)
`<Text size weight color tracking mono align lh>` · `<Window w h title? dark? bg? sidebar? sidebarWidth? chrome?>` · `<Card w h pad radius glass bg shadow="soft"|"lifted"|"float"|"dark"|"none" border>` · `<Pill tone="accent"|"muted"|"good"|"warn"|"bad"|hex solid? dashed? icon? size>` · `<Button variant="primary"|"accent"|"secondary"|"ghost"|"danger" icon? iconRight? pressed={0..1} size>` · `<Avatar name size color?>` · `<Checkbox checked={0..1}>` · `<Toggle on={0..1}>` · `<Input w value placeholder icon caret focus={0..1} right>` · `<Divider vertical?>` · `<Row gap align justify>` · `<Col gap align>` · `<Icon name size color stroke>` with names: search plus minus check x chevron-down chevron-right chevron-left chevron-up arrow-right arrow-up arrow-up-right send home chart bar-chart line-chart pie users user settings bell calendar file mail star sparkle play pause mic more more-vertical filter download upload link lock globe cart box tag truck card grid list zap clock trend-up trend-down edit trash copy eye heart message image folder inbox refresh layers bolt dollar percent sun moon paperclip at command sidebar logout external-link bookmark shield cloud code terminal video wand. `SHADOW.soft|lifted|float|dark`.
Every atom takes `id` (element-addressable) and `style`.

## Builds & type (one entrance grammar: rise + unblur + fade, overlapping)
- `<Reveal at from?="up"|"down"|"left"|"right"|"scale"|"blur"|"none" dist? dur? out?>` one element (out = frame it leaves).
- `<Build at gap?=60(ms) from? direction?="column"|"row" spacing?>` children enter one after another, overlapping.
- `<Pop at origin?>` small things popping (pills, bubbles, toasts) — the one allowed overshoot.
- `<Typewriter text at cps?=18 size weight color caret?>`; `typed(text, frame, at, fps, cps)` for your own fields (seconds to type = length / cps → the plan's `type` cue seconds).
- `<Counter to from? at dur? format="int"|"money"|"pct"|"compact"|"decimal" decimals prefix suffix size weight color>`.
- FILM TYPE is the display face (Inter Tight, tight tracking — set by the kit; the product's UI keeps its own font via `<Text>`). Two sizes only: a SENTENCE 64–88 px or a STATEMENT 160–280 px. Nothing in between, never under 56 px for film words.
- `<Words text at size?=72 entrance?="mask"|"rise"|"blur"|"letters" gap? weight? color emphasis={['word']} gradient? align maxWidth out lh>` — a sentence. `mask` (default): each word rises from behind its own baseline — the Apple build. `letters`: per-letter blur-in. `blur`: words resolve from a soft blur. `out` = the frame they sink back.
- `<Statement text at size?=200 entrance? emphasis gradient align>` — one to three HUGE words, weight 700, line by line through the mask. Let it bleed off the frame on purpose for a hero word (size so the word is wider than the frame, overflow is clipped by the shot).
- `<Brackets text at cps? size?=96>` — ‹ word › typing between opening brackets (ClickUp's "‹ everything. ›").
- `<Scatter text at mode="out"|"in" dur spread size>` — words fly apart / gather (word transitions inside a shot).
- `<Swap words={[…]} at={[f1, f2]} size>` — one word rolling through alternatives.
- `<TrackLine text at dur size>` — a long line the camera tracks along.

## Charts (draw, don't appear) — real numbers from the recording
`<LineChart series={[[…],[…]]} w h at dur? colors area grid stroke labels min max dot>` · `<BarChart values w h at gap labels color dimColor highlight={i} radius horizontal>` · `<Donut segments={[{value, color}]} size thickness at dur arc={360|270|180}>{centre}</Donut>` · `<Progress value={0..1} w h at dur color>` · `<Sparkline values w h at color>`.

## Pointer & attention
- `<Cursor path={[{at: frame, x, y, click?}, …]} kind="arrow"|"hand" appear? leave? size?>` — px in its parent's coordinates (put it inside the component it moves over, so it rides the camera). A click presses it and rings a ripple; change the clicked element's state on that SAME frame (use the click's cue frame).
- `<Spotlight x y w h radius amount={0..1}>` — dims everything but one element.

## Brand mark & real 3D
- `<BrandMark size id?>` — THE logo. With the maker's logo file it renders that file (`size` = its height in px; width follows the logo's aspect); without one, the plan's traced `plan.logo` as flat vector. Put it on screen where a `logo-wipe` join starts (its `at`), so the logo BECOMES the wipe. Never draw a logo yourself (no letter in a coloured square, no lookalike).
- `<Mark3D w h at? spin? depth?>` — the logo as a glossy, lit 3D object (three.js): the file's own outline extruded, its artwork on the front face (an app-icon logo becomes a glossy 3D tile); it swings in and lands at `at`. The outro lockup: `<Mark3D w={300} h={300} at={hit.at}/>` beside a ≥ 140 px wordmark.
- `<Orb3D w h kind="sphere"|"torus"|"knot"|"capsule"|"cube" color? at? float?>` — a glossy 3D accent object (≤ 2 shots; they cost render time).

## Light & media
- `<LightSweep at dur width strength radius>{element}</LightSweep>` — a sheen across a card/logo.
- `<Flash at dur color color2>` — a full-bleed accent hit (≤ once a film).
- `<Still id="k3" crop={{x,y,w,h}} w h radius>` — a crop (0..1 of the frame) of one of the recording's KEYFRAMES (ids given with the images) — for photos/artwork that can't be redrawn. Prefer redrawing UI.
- `<Recording from={seconds} crop w h radius>` — the real recording, muted (rarely: authenticity moments).

## Transitions (in the PLAN, not in code)
- Object-carried (prefer): `expand`/`collapse` (from/to box), `zoom-through` (at), `logo-wipe` (at), `mask-circle` (at), `flood` (at + to, color), `tile-expand` (from — the box bursts to the frame, the rest shatters into tiles), `card-flip` (count — one card flips into many), `implode` (at — collapses to a dot that opens into the next), `card-stack`, `iris`.
- Rhythm / ground changes: `whip-in` (dir, 0.25 s — a hard ground change with a smear), `stripes`, `liquid` (a wave rises with the next ground), `echo` (dir — a push with echo trails), `bloom` (the hero reveal).
Shot i's `transition` says how it ARRIVES; the host renders it over the overlap: `zoom-through` (the camera rushes INTO `at` — the element on screen there — and the next shot settles back from close), `expand` (container transform — the next shot grows out of `from` box of this one: a card/field becomes the screen), `collapse` (this shot shrinks into `to` box of the next), `mask-circle` (a circle grows from `at`, e.g. the click point), `push` / `whip` (`dir` left|right|up|down, motion-blurred), `focus-pull` (defocus into the next — make both grounds the same colour), `light-sweep`, `flash` (accent hit, ≤ 1), `logo-wipe` (the traced brand mark grows from `at` over the frame; its inside is the next shot — required at least once when plan.logo is set), `cut` (only on a hard beat/match; ≤ 2 a film).
After-Effects-grade joins — pick each for what the MOMENT means, never by rote, and vary them:
`split` (the frame cracks open down the middle and the halves fly apart — a reveal, "and then…"; `dir` up/down = a horizontal crack), `slats` (the next shot arrives in staggered blinds — a list, a set of features, rhythm; `dir` sets order/orientation), `cube` (both shots are faces of one turning cube — side-by-side alternatives, before → after, one product → another; `dir` left/right), `card-stack` (keynote: the shot shrinks into a card and falls back, the next rises as a card and opens — moving to the next chapter / feature), `glass` (a frosted-glass band sweeps across and the shot changes behind it — calm, premium, light grounds), `spin` (spin-zoom through `at` — energetic, a hard turn in the story), `glitch` (a short digital tear — AI / dev / tech accent, ≤ once a film), `iris` (the next shot opens through a shape from `at`: `shape` rounded = an app opening, diamond, pill). Design each shot's first and last frames for its joins: the element an `expand` grows from must be on screen, at that box, at the end of the previous shot.
