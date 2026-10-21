# The module contract — writing a Lakr timeline film

A Lakr film is a **timeline**: tracks of clips, each clip a React component placed in time. You write the
components (modules of TSX); Lakr places, plays, checks and renders them. The maker watches every clip appear in the
preview tab as you send it.

## A module

```tsx
import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Words, Ground, usePalette, E, SPR, spr } from '@lakr/kit';

export const Opening = () => {
	const p = usePalette();
	const f = useCurrentFrame(); // frames from THIS clip's start, at the film's fps
	return (
		<Ground>
			<div data-lakr="opening:headline"><Words text="Start from a sentence." at={6} size={140} /></div>
		</Ground>
	);
};
```

- Imports only from `react`, `remotion` (AbsoluteFill, Sequence, Series, Loop, Freeze, interpolate,
  interpolateColors, spring, Easing, random, useCurrentFrame, useVideoConfig) and `@lakr/kit` (the KIT below).
- Named exports; a clip names its module and export. One module may hold several scenes.
- No network, storage, timers, Date, Math.random (use `random(seed)`), window/document, raw <img>/<video>.
  Pictures and recordings come in as clips (`lakr_add_media`) or through kit components that take a `src`.
- Every element the maker may want to change carries `data-lakr="<clipId>:<name>"`.
- A clip animates from its own frame 0; where it sits in the film is the timeline's business, never the code's.

## Motion — the vocabulary (never linear by default)

| name     | use                                                        |
|----------|------------------------------------------------------------|
| enter    | things arriving: fast then a long settle (ease-out, `E.out`) — the default |
| settle   | a physical landing, no overshoot (spring, `SPR.firm`/`SPR.soft`) |
| snap     | a decisive lock into place, small overshoot (`SPR.snap`)   |
| emphasis | a hit: anticipation + a little overshoot (back-out)        |
| exit     | leaving: slow start, accelerating out (`E.exit`)           |
| drift    | a move between two on-screen places (`E.smooth`)           |

Time in seconds × fps (`useVideoConfig().fps`). Land cuts and hits on the beat: one beat = 60 / bpm seconds.

## Clips (lakr_put_clip / lakr_plan_timeline)

`{id, name, kind: "scene"|"figma"|"text"|"image", start, seconds, module, export, note, enter?, keyframes?}`
- `enter`: a join from the kit over the previous clip on the same track —
  `{kind: "push"|"zoom-through"|"mask-circle"|"whip"|"focus-pull"|"flash"|"cut"…, seconds?: 0.3–0.7, at?: {x,y}}`.
- `keyframes`: the clip as a layer — `[{property: "x"|"y"|"opacity"|"scale"|"rotate"|"blur", t: seconds, value, easing: "enter"…}]`.
- `track`: "scenes" (default) for full-frame scenes; overlays (a caption, a frame over a scene) go on their own track
  ABOVE ("overlay"). Sound goes on "sound" / "music".

## The maker's own motion (clip.elements)

The maker can animate any element by hand in Lakr's Mac editor. That motion lives on the clip as
`elements: { "<element>": { keyframes: [{property, t, value, easing}], look?: {font, size, weight, color, tracking} } }`
— keyed by the part of the `data-lakr` key after `<clip>:` — and is applied ON TOP of your code. Keep `data-lakr`
keys stable when you rewrite a clip so their motion still lands; Lakr keeps `elements` when you send the clip again
without them. Keep words in one string per element (`<Words text="…">`), so a retype edits one place.

## Every visible thing is tagged — and you look at what you made

- Tag every element the viewer can see with its own `data-lakr="<clipId>:<name>"`: each line of words, the logo,
  each card / button / chip / screenshot, each icon group. Clear, stable names (`headline`, `subline`, `cta`, `logo`,
  `card-1`, `screen`…). `lakr_put_clip` lists anything on screen without a tag — tag it and send the clip again.
- `lakr_put_clip` answers with stills of the clip; `lakr_look` shows any clip (or the whole film) at any moment.
  Check them like the maker will — legible, balanced, on brand, nothing clipped or overlapping — and fix what's off.
