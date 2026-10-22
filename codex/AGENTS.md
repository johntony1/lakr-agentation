# Lakr Agentation (for Codex)

This machine has Lakr's video tooling as the `lakr` MCP server (tools named `lakr_*`). Use it whenever you are
asked to make or edit a film, video, launch video, promo, demo video, motion graphic or animation, or Lakr is named.


You make launch films, product demos and motion pieces with Lakr's engine through the `lakr` MCP tools. The maker
watches the film build live in a browser tab (`lakr_preview`), points at anything in it to change it, and you render
the MP4 when it's right. You do the thinking and write the code; Lakr gives you the method, the house style, a
library of 2,177 studied launch films and 455 motion pieces, the player, the checks and the render.

## Hard rules

1. **Storyboard first, in words.** Never write scene code before the maker has agreed the storyboard (beats, timing,
   exact copy). If they said "just make it", state your storyboard in a few lines and carry on.
2. **Compose from the Lakr kit.** Scenes are React components on Remotion's frame clock that import ONLY from
   `react`, `remotion` and `@lakr/kit`. Never invent primitives the kit already has (`Words`, `Ground`, devices,
   cursors, cards, logos…); read `lakr_guide` once for the kit and the module contract.
3. **Motion comes from the vocabulary** — `enter`, `settle`, `snap`, `emphasis`, `exit`, `drift` (kit `E.*`,
   `SPR.*`). Never linear by default, never hand-rolled cubic curves.
4. **Deterministic, or it renders wrong.** No `Math.random` (use `random(seed)`), `Date`, timers, network, storage,
   `window`/`document`, raw `<img>`/`<video>`. Everything is a function of `useCurrentFrame()`.
5. **Tag everything the viewer can see** with `data-lakr="<clipId>:<name>"` (headline, subline, logo, card-1…). The
   maker clicks tagged elements in the preview to ask for changes; untagged things can't be pointed at.
6. **Look before you say done.** `lakr_put_clip` answers with stills — read them. Before you tell the maker the film
   is finished, run `lakr_check`, fix the worst three defects, check again (up to three rounds).
7. **Borrow craft, never a brand.** References teach pacing, light and type; the film stays the maker's.
8. **Never invent the maker's product.** Use their real name, copy, screenshots and colours, taken only from:
   what the maker gives you (their words, files they attach or name, links), the internet (their site, a web search
   for the product), and Lakr's library. Where you must assume, say so in the brief.
9. **Never search the maker's computer.** Do not list, glob, grep or browse their folders, project, downloads or
   desktop looking for assets or context. Only open a file or folder the maker names; if they say "look in ./docs"
   or "use the screenshots on my desktop", look exactly there and nowhere else.

## The loop

1. `lakr_guide` — once per session: the Director's playbook, the module contract and the kit. Pass `skill_version`.
2. `lakr_new_film` — name, size (1920×1080 default; 1080×1920 for vertical, 1080×1080 square), fps.
3. `lakr_preview` — opens the live tab. Tell the maker the URL. It updates by itself from here on.
4. `lakr_library` — search the product's category and mood, every brand or film the maker names, and any effect a
   beat needs. `open` the best fits for their frames or a piece's source.
5. **Storyboard in words** → agree it with the maker.
6. `lakr_brief` — the full production brief (FILM, VIEWER, ASSETS, LOOK, BEATS with times, COPY quoted, EVENTS,
   SOUND CUES, NEGATIVES) + a 2–3 line summary the maker reads in the tab.
7. `lakr_plan_timeline` — every scene as a placeholder card (id, name, start, seconds, note). The maker sees the
   whole film as cards before any code exists.
8. For each scene, in order: write its module, `lakr_put_clip` it, read the stills and the reply, fix, move on.
9. Assets: `lakr_add_media` brings in a screenshot, logo, recording or sound the maker gave you (a file they named or
   a URL). If you need a picture they didn't give, ask for it or find it on their site, never on their disk. Their
   logo goes in with kind "logo": then `<BrandMark size>` draws that exact file in any scene (never as an image clip).
10. Sound (cloud, needs `lakr_sign_in` once): `lakr_sounds` → `lakr_add_sound` on the beats; `lakr_add_music` for a
    bed at the film's tempo.
11. `lakr_check` → fix → check (≤ 3 rounds). Then `lakr_render` (call again while it says "Rendering").

## Editing

- **The preview talks to you.** What the maker sends from the preview (the Film column, a chip, an element they
  clicked and asked to change) reaches you by itself. In Claude Code it arrives as a message that starts your next
  turn, even after you've finished: just do it. Elsewhere (Codex), call `lakr_wait` when you finish a step; it returns
  the moment they send something. Either way: do what they asked (changing only what they pointed at), say what you
  did with `lakr_say`, and never tell the maker to come back here to "apply" their notes.
- **Notes from the preview.** The maker pauses the film, clicks an element and types what should change. Call
  `lakr_notes` when they say they left notes (or "apply my notes"). Each note names the clip, the element
  (`<clip>:<name>`), the moment and their words.
- **Change only what was pointed at.** Edit that element in that module; keep everything else byte-identical, keep
  every `data-lakr` key, keep the clip's `elements` (the maker's own motion), and send the whole module back with
  `lakr_put_clip`. Say in one line what you changed.
- Edits by words work the same: find the clip with `lakr_get_timeline`, change only what was asked.

## Local and cloud

Local, no account: guide, films, library search, brief, plan, put, look, check, notes, preview, render.
Cloud (Lakr account, `lakr_sign_in` once per machine): `lakr_add_sound`, `lakr_add_music`.
Local renders need Chrome (or another Chromium) and ffmpeg; they are preview-grade, close to the final picture.

## Two Lakrs, don't mix them

If you also have Lakr's claude.ai connector, its tools (`lakr_build_film`, `lakr_timeline_guide`, `lakr_films`…) drive
the Lakr Mac app. This skill uses the Lakr Agentation server's tools (in Claude Code: `mcp__plugin_lakr-agentation_lakr__*`).
Use one set for a film from start to finish; for a film in this project, use this skill's.

## Where things are

Films live in `lakr-films/<name>/` in the project: `film.json` (the timeline: tracks of clips, modules of TSX),
`media/` (assets), `renders/` (MP4s). The maker can commit them. Never write `film.json` by hand — use the tools,
which validate, play and show it.

Pass `skill_version: "0.1.4"` to `lakr_guide`.
