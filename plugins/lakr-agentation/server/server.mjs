#!/usr/bin/env node
// Lakr Agentation's MCP server — the capability layer of the agent skill (PRD Agent Skill §2.2). One server for
// Claude Code (plugin, stdio) and Codex (config.toml, stdio). Tools are labelled local or cloud in lakr_guide.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as check from './check.mjs';
import * as cloud from './cloud.mjs';
import * as store from './film.mjs';
import * as library from './library.mjs';
import { agentName, image, notify, serve, text, ToolError } from './mcp.mjs';
import * as media from './media.mjs';
import { ROOT, VERSION } from './paths.mjs';
import * as preview from './preview.mjs';
import * as render from './render.mjs';
import * as stage from './stage.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
	process.stderr.write(`Lakr Agentation needs Node 22 or newer (this is ${process.versions.node}).\n`);
	process.exit(1);
}

const doc = (name) => {
	try {
		return readFileSync(path.join(ROOT, 'guide', name), 'utf8');
	} catch {
		return '';
	}
};
const json = (v) => JSON.stringify(v, null, 1);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : undefined);
const obj = (properties = {}, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const projectDir = () => path.resolve(process.env.LAKR_PROJECT || process.cwd());

/** Anything that drives the headless player stops a running render first: they share one page. */
const onStage = async (fn) => {
	await render.stop();
	return fn();
};

let sounds;
const soundList = () => (sounds ??= JSON.parse(readFileSync(path.join(ROOT, 'library', 'sounds.json'), 'utf8')));

let waitingNow = 0;
export const agentListening = () => waitingNow > 0;
const LOCAL = 'local';
const CLOUD = 'cloud (Lakr account)';

const tools = [
	{
		name: 'lakr_guide', where: LOCAL,
		description: "Read once per session, before writing any scene: the Director's playbook (how Lakr makes a film from any prompt), the module contract (how a scene is written), Lakr's kit (@lakr/kit components), the laws from 2,000+ studied launch films, and which tools are local or cloud.",
		inputSchema: obj({ skill_version: { type: 'string', description: "the version in your skill's metadata (lets Lakr tell you if the skill is out of date)" } }),
		run: async (a) => {
			const laws = await cloud.laws();
			const where = tools.map((t) => `- ${t.name}: ${t.where}`).join('\n');
			let out = '';
			if (a.skill_version && a.skill_version !== VERSION) {
				out += `NOTE: your skill instructions are version ${a.skill_version}; this Lakr server is ${VERSION}. Tell the maker to update the Lakr Agentation plugin/skill so the two match.\n\n`;
			}
			const n = library.counts();
			out += `# Lakr Agentation ${VERSION}\n\nLibrary: ${n.films} studied launch films + ${n.pieces} motion pieces (lakr_library). Films folder: ${store.workDir()}\n\n## Tools\n${where}\n\n`;
			if (laws) out += `# THE LAWS — from Lakr's study of 2,000+ launch films (follow them)\n\n${laws}\n\n---\n\n`;
			out += doc('DIRECTOR.md') + '\n\n---\n\n' + doc('MODULE.md') + '\n\n# KIT — @lakr/kit\n\n' + doc('KIT.md');
			out += '\n\n(Recipes — lakr_recipes / lakr_use_recipe — live in Lakr\'s Mac app only; in the skill, start every film from the brief.)';
			return out;
		},
	},
	{
		name: 'lakr_new_film', where: LOCAL,
		description: 'Start a new film in the project (lakr-films/<name>/) and make it the current one. Every other tool works on the current film.',
		inputSchema: obj({
			name: { type: 'string', description: 'the film\'s name, e.g. "Acme launch"' },
			width: { type: 'number', description: '1920 default; 1080 for vertical (with height 1920) or square' },
			height: { type: 'number', description: '1080 default' },
			fps: { type: 'number', description: '30 default; 60 for very fast UI motion' },
			look: { type: 'object', description: '{palette:{ground,ink,muted,accent,surface,line,dark}, type?:{display,accent}, mood, bpm}' },
		}, ['name']),
		run: (a) => {
			const f = store.newFilm(a);
			return `Started “${f.meta.name}” (${f.film.width}×${f.film.height}, ${f.film.fps} fps) in ${f.dir}. Next: lakr_preview so the maker can watch, then lakr_library → storyboard → lakr_brief.`;
		},
	},
	{
		name: 'lakr_get_timeline', where: LOCAL,
		description: "The current film: brief, look (palette, type, bpm), tracks and clips, each module's source (or only `module`), and the maker's open notes. With `use`, switch to another film in the project; with no film yet, lists the films here.",
		inputSchema: obj({ module: { type: 'string', description: "only this module's source" }, use: { type: 'string', description: 'switch to this film (its folder name)' } }),
		run: (a) => {
			if (a.use) store.use(a.use);
			const slug = store.currentSlug();
			if (!slug) return json({ films: store.listFilms(), folder: store.workDir(), note: 'No current film — lakr_new_film starts one, or pass `use` with a name above.' });
			const f = store.open(slug);
			const film = structuredClone(f.film);
			if (a.module) film.modules = { [a.module]: film.modules[a.module] ?? null };
			return json({
				film: f.slug, folder: f.dir, films: store.listFilms(), seconds: store.duration(f.film),
				production_brief: f.meta.brief ?? 'none yet — write one with lakr_brief before planning',
				open_notes: f.meta.notes.filter((n) => n.state !== 'done'),
				preview: preview.baseURL() ?? 'not open — lakr_preview',
				timeline: film,
			});
		},
	},
	{
		name: 'lakr_library', where: LOCAL,
		description: "Lakr's library — ONE search over 2,177 studied real launch films (Linear, Apple, Stripe, Vercel, Raycast, Arc…: notes + frames) and 455 ready-made motion pieces (count-ups, liquid-glass notifications, code typing, chart races, chat reveals, lower thirds, logo outros, transitions: source + preview). Ranked by fit only. Search before the brief (the product's category and mood, every brand or film the maker names) and for anything a beat needs; `open` a result by its name for more frames or a piece's source. Borrow craft, never a brand.",
		inputSchema: obj({
			query: { type: 'string', description: 'a brand, a style, or what a moment must do' },
			open: { type: 'string', description: "a result's name (film id or piece name) — or several, comma-separated, to combine a film's look with a piece's technique" },
			n: { type: 'integer', description: 'results (default 6, max 10)' },
		}),
		run: (a) =>
			library.search(a, () => {
				const slug = store.currentSlug();
				if (!slug) return;
				const f = store.open(slug);
				if (!f.meta.studied) {
					f.meta.studied = true;
					store.save(f, 'studied', { record: false });
				}
			}),
	},
	{
		name: 'lakr_brief', where: LOCAL,
		description: "FIRST, before planning: turn the maker's words — however short, vague or misspelt — into a production brief (the Director's playbook in lakr_guide shows the template). Lakr keeps it with the film and shows `summary` in the preview tab. Search lakr_library before writing it.",
		inputSchema: obj({
			brief: { type: 'string', description: 'the full brief, markdown: FILM, VIEWER, ASSETS, LOOK, BEATS (timed, frame numbers), COPY (quoted), EVENTS, SOUND CUES, NEGATIVES' },
			summary: { type: 'string', description: '2–3 plain lines for the maker' },
		}, ['brief', 'summary']),
		run: (a) => {
			const f = store.open();
			const brief = String(a.brief ?? '').trim();
			if (brief.length < 200) throw new ToolError('brief: the whole production brief — beats with times, the exact copy in quotes, events, sound cues, negatives');
			if (!f.meta.studied) throw new ToolError("Search Lakr's library first (lakr_library): the product's category and mood, every brand or film the maker named, and any effect the film needs. Build the brief on what fits.");
			f.meta.brief = brief;
			f.meta.summary = String(a.summary ?? '').trim().slice(0, 600);
			if (f.meta.summary) store.chat(f, 'agent', f.meta.summary);
			store.save(f, 'brief');
			const fits = library.fits(brief);
			return 'Brief kept with the film (the maker sees the summary in the preview). Next: lakr_plan_timeline from its beats.'
				+ (fits.length ? `\n\nWhat else in Lakr's library fits this brief — use any that does it better than your plan (lakr_library \`open\` by name):\n${fits.join('\n')}` : '');
		},
	},
	{
		name: 'lakr_plan_timeline', where: LOCAL,
		description: 'Lay the film out as placeholder clips before writing code: the maker sees every scene as a card in the preview and can redirect. Replaces the plan\'s pending cards; clips already written stay.',
		inputSchema: obj({
			clips: { type: 'array', items: { type: 'object' }, description: '[{id, name, start, seconds, note, track?}]' },
			bpm: { type: 'number' },
			look: { type: 'object', description: '{palette:{ground,ink,muted,accent,surface,line,dark}, type?:{display,accent}, mood}' },
		}, ['clips']),
		run: (a) => {
			const f = store.open();
			if (!f.meta.brief) throw new ToolError('Write the brief first (lakr_brief): the maker\'s words refined into timed beats, exact copy, events and sound cues. Then plan from it.');
			const n = store.plan(f, a.clips, a.bpm, a.look);
			const planned = `Laid out ${n} scene${n === 1 ? '' : 's'}`;
			store.chat(f, 'agent', planned, 'act');
			store.save(f, 'plan', { line: planned });
			store.say(f.slug, `Planned ${n} scene${n === 1 ? '' : 's'} — writing them now.`);
			return `Planned — the maker sees ${n} placeholder card${n === 1 ? '' : 's'} (${store.duration(f.film).toFixed(1)} s). Now write each scene with lakr_put_clip, in order.`;
		},
	},
	{
		name: 'lakr_put_clip', where: LOCAL,
		description: "Send a module (TSX) and, optionally, the clip that shows it. Lakr compiles and plays it on its player (the preview tab updates), then replies with errors to fix — or 'playing', any on-screen element still missing a data-lakr tag, and stills at 15/50/85 % to look at.",
		inputSchema: obj({
			module: { type: 'string', description: 'module name, e.g. "opening" (one module may hold several scene exports)' },
			source: { type: 'string', description: "the module's whole TSX" },
			clip: { type: 'object', description: '{id, name, kind, start, seconds, export, note, enter?, keyframes?, props?}' },
			track: { type: 'string', description: 'scenes (default) | overlay | …' },
		}, ['module', 'source']),
		run: (a) =>
			onStage(async () => {
				const f = store.open();
				const was = a.clip?.id ? store.findClip(f.film, a.clip.id)?.clip : null;
				const { clip } = store.put(f, a.module, a.source, a.clip, a.track);
				const did = clip ? `${was && !was.pending ? 'Changed' : 'Wrote'} “${clip.name ?? clip.id}”` : `Changed ${a.module}`;
				store.chat(f, 'agent', did, 'act');
				// notes on this clip are answered by sending it
				if (clip) for (const n of f.meta.notes) if (n.clip === clip.id && n.state === 'taken') n.state = 'done';
				store.save(f, 'put', { line: did });
				store.say(f.slug, clip ? `Wrote “${clip.name ?? clip.id}”.` : `Updated module ${a.module}.`);
				const { page, moduleErrors } = await stage.load(f.film);
				const problems = [];
				if (moduleErrors[a.module]) problems.push(`module ${a.module} did not compile: ${moduleErrors[a.module]}`);
				if (!clip) {
					return problems.length ? `NOT PLAYING — fix and send the module again:\n- ${problems.join('\n- ')}` : `Module ${a.module} compiled. Clips using it play the new code.`;
				}
				const at = (p) => stage.frameOf(f.film, clip.startSec + clip.durationSec * p);
				const shots = [];
				for (const p of [0.15, 0.5, 0.85]) shots.push(await stage.still(page, f.film, at(p)));
				const thrown = (await stage.clipErrors(page))[clip.id];
				if (thrown) problems.push(`clip ${clip.id} threw while rendering: ${thrown}`);
				if (problems.length) return [text(`NOT PLAYING — fix and send the module again:\n- ${problems.join('\n- ')}`), ...shots.slice(1, 2).map((s) => image(s))];
				const bare = await stage.untagged(page, f.film, clip.id, [0.3, 0.6, 0.9].map(at));
				let reply = `Playing — “${clip.name ?? clip.id}” at ${clip.startSec.toFixed(2)}–${(clip.startSec + clip.durationSec).toFixed(2)} s.`;
				if (bare.length) {
					reply = `PLAYING, BUT NOT DONE — these are on screen without a data-lakr tag, so the maker can't click them. Give each its own data-lakr="${clip.id}:<name>" and send the clip again:\n- `
						+ bare.map((b) => `${b.what} (frame ${b.at})`).join('\n- ');
				}
				reply += `\n\nThe stills below are “${clip.name ?? clip.id}” at 15 %, 50 % and 85 % — look at them as the maker will: legible, balanced, on brand, nothing clipped or overlapping? Fix anything off before moving on.`;
				if (!preview.tabsOpen()) reply += '\n(The maker has no preview tab open — lakr_preview opens it.)';
				return [text(reply), ...shots.map((s) => image(s))];
			}),
	},
	{
		name: 'lakr_look', where: LOCAL,
		description: 'See your work: stills of one clip (default 4 across it, or `at` seconds into it) or of the whole film — exactly as the maker sees it.',
		inputSchema: obj({ clip: { type: 'string' }, at: { type: 'array', items: { type: 'number' }, description: 'seconds into the clip (or the film, without `clip`)' } }),
		run: (a) =>
			onStage(async () => {
				const f = store.open();
				const film = f.film, total = store.duration(film);
				if (!total) throw new ToolError('The film is empty — plan it and put its clips first.');
				let secs, what = 'the film';
				if (a.clip) {
					const c = store.findClip(film, a.clip)?.clip;
					if (!c) throw new ToolError(`No clip “${a.clip}”.`);
					what = `“${c.name ?? c.id}”`;
					const rel = Array.isArray(a.at) && a.at.length ? a.at.map(Number) : [0.1, 0.4, 0.7, 0.95].map((p) => p * c.durationSec);
					secs = rel.slice(0, 6).map((s) => c.startSec + Math.min(Math.max(0, s), c.durationSec - 1 / film.fps));
				} else {
					secs = Array.isArray(a.at) && a.at.length ? a.at.slice(0, 8).map(Number) : Array.from({ length: 6 }, (_, i) => (total * (i + 0.5)) / 6);
				}
				const { page, moduleErrors } = await stage.load(film);
				const out = [text(`${what} at ${secs.map((s) => `${s.toFixed(2)} s`).join(', ')} (film time):`
					+ (Object.keys(moduleErrors).length ? `\n(Modules that don't compile, drawn as errors: ${Object.keys(moduleErrors).join(', ')})` : ''))];
				for (const s of secs) out.push(image(await stage.still(page, film, stage.frameOf(film, s))));
				return out;
			}),
	},
	{
		name: 'lakr_check', where: LOCAL,
		description: "The gate before you tell the maker it's done: Lakr steps through the film (or `from`–`to` seconds) and measures what stills can't show — text cut off or crowding the edge, text colliding, type too small for a phone, words gone before they can be read, frozen stretches, clips that throw — and returns the defects worst first plus a contact sheet to score by eye. Fix the worst three, check again, up to three rounds.",
		inputSchema: obj({ from: { type: 'number', description: 'film seconds (default 0)' }, to: { type: 'number', description: 'film seconds (default the end)' } }),
		run: (a) => onStage(() => check.run(store.open().film, num(a.from), num(a.to))),
	},
	{
		name: 'lakr_preview', where: LOCAL,
		description: "Open the live preview in the maker's browser: the film playing, its timeline of scene cards, the brief. It follows every change you make. The maker can pause, click any element and type a change — those arrive as notes (lakr_notes). Returns the URL; give it to the maker.",
		inputSchema: obj({ reopen: { type: 'boolean', description: 'open a new tab even if one is already open' } }),
		run: async (a) => {
			const base = await preview.start();
			const opened = (a.reopen || !preview.tabsOpen()) && preview.openInBrowser(base + '/');
			return [
				text(`Preview: ${base}/ — ${opened ? 'opened in the maker\'s browser' : preview.tabsOpen() ? 'already open in a tab' : 'open this link in a browser'}. It shows the current film live; tell the maker they can pause, click anything and type a change, then ask you to apply their notes.`),
				{ type: 'resource_link', uri: `${base}/`, name: 'Lakr preview', mimeType: 'text/html', description: 'The live film and its timeline' },
			];
		},
	},
	{
		name: 'lakr_say', where: LOCAL,
		description: "Talk to the maker in the preview's Film column (where they watch the film): what you read in their idea, what you just did, what you need from them. Short, plain sentences. The maker answers there or in your chat.",
		inputSchema: obj({ words: { type: 'string' } }, ['words']),
		run: (a) => {
			const f = store.open();
			const words = String(a.words ?? '').trim();
			if (!words) throw new ToolError('words: what to tell the maker');
			store.chat(f, 'agent', words);
			store.save(f, 'say', { record: false });
			return preview.tabsOpen() ? 'Shown in the Film column.' : 'Kept in the Film column (no preview tab is open right now: lakr_preview opens it).';
		},
	},
	{
		name: 'lakr_wait', where: LOCAL,
		description: "Wait for the maker to direct the film from the preview tab: what they type in the Film column, a chip they press, or an element they click and ask to change. Returns their words as soon as they send something (up to `seconds`, default 45). When you finish a step and the maker is watching the preview, call this and act on what comes back; if nothing came, call it again, until they say stop or talk to you here.",
		inputSchema: obj({ seconds: { type: 'number', description: 'how long to wait in this call (max 55)' } }),
		run: async (a) => {
			const until = Date.now() + Math.min(55, Math.max(1, Number(a.seconds) || 45)) * 1000;
			const fresh = () => {
				try {
					return store.open().meta.notes.filter((n) => n.state === 'new');
				} catch {
					return [];
				}
			};
			waitingNow++;
			store.events.emit('waiting', { on: true });
			try {
				while (!fresh().length && Date.now() < until) {
					await new Promise((resolve) => {
						const t = setTimeout(resolve, Math.max(0, until - Date.now()));
						store.events.once('note', () => (clearTimeout(t), resolve()));
					});
				}
			} finally {
				waitingNow--;
				store.events.emit('waiting', { on: waitingNow > 0 });
			}
			if (!fresh().length) return 'Nothing from the maker yet. Call lakr_wait again to keep listening (or stop if they are talking to you here).';
			return tools.find((t) => t.name === 'lakr_notes').run({});
		},
	},
	{
		name: 'lakr_notes', where: LOCAL,
		description: "The maker's notes from the preview: each names the clip, the element they clicked (`<clip>:<name>`, with its text), the moment, and what they want changed. Returns the open ones and marks them taken; sending the clip with lakr_put_clip marks them done. Apply each by changing ONLY that element.",
		inputSchema: obj({ all: { type: 'boolean', description: 'include notes already taken' } }),
		run: (a) => {
			const f = store.open();
			const open = f.meta.notes.filter((n) => (a.all ? n.state !== 'done' : n.state === 'new'));
			if (!open.length) return 'No new notes. (The maker leaves them by pausing the preview, clicking an element and typing what to change.)';
			for (const n of open) if (n.state === 'new') n.state = 'taken';
			store.save(f, 'notes', { record: false });
			const lines = open.map((n, i) => `${i + 1}. ${n.element ? `${n.element}${n.text ? ` (“${n.text}”)` : ''}` : n.clip ? `clip ${n.clip}` : 'the film'}${n.atSec != null ? ` at ${n.atSec} s` : ''}: ${n.words}`);
			return `${open.length} note${open.length === 1 ? '' : 's'} from the maker:\n${lines.join('\n')}\n\nFor each: open the clip's module (lakr_get_timeline with module), change only what the note points at, keep everything else byte-identical, and send it back with lakr_put_clip. Say what you changed in one line each.`;
		},
	},
	{
		name: 'lakr_add_media', where: LOCAL,
		description: "Bring a file the maker gave you (a path they named, or a URL) into the film. Never go looking on their disk for one — a screenshot, logo, product recording, voice or sound — and place it as a clip. Pictures and recordings go full-frame on their own track unless you say `track`; scene code can show a still by its `src` too.",
		inputSchema: obj({
			path: { type: 'string', description: 'a file in the project (relative or absolute)' },
			url: { type: 'string', description: 'or an https URL to fetch' },
			kind: { type: 'string', enum: ['image', 'recording', 'audio'], description: 'what it is (guessed from the extension if left out)' },
			id: { type: 'string', description: 'clip id (default from the file name)' },
			name: { type: 'string' }, start: { type: 'number' }, seconds: { type: 'number' }, track: { type: 'string' },
			volume: { type: 'number', description: '0..1 for sound' }, place: { type: 'boolean', description: 'false = copy into media/ only, no clip' },
		}),
		run: async (a) => {
			const f = store.open();
			let src = a.path, name;
			mkdirSync(path.join(f.dir, 'media'), { recursive: true });
			if (a.url) {
				const u = new URL(a.url);
				if (!/^https?:$/.test(u.protocol)) throw new ToolError('url: http(s) only');
				name = path.basename(u.pathname) || 'download';
				const file = await media.cached(a.url, path.join(f.dir, 'media', name));
				if (!file) throw new ToolError(`Could not download ${a.url}.`);
			} else {
				if (!src) throw new ToolError('path (a file in the project) or url');
				const abs = path.resolve(projectDir(), src);
				if (!existsSync(abs) || !statSync(abs).isFile()) throw new ToolError(`No file at ${abs}.`);
				name = path.basename(abs);
				const dest = path.join(f.dir, 'media', name);
				if (path.resolve(dest) !== abs) copyFileSync(abs, dest);
			}
			const ext = path.extname(name).toLowerCase();
			const kind = a.kind ?? (['.mp4', '.mov', '.webm', '.m4v'].includes(ext) ? 'recording' : ['.wav', '.mp3', '.m4a', '.aac', '.ogg'].includes(ext) ? 'audio' : 'image');
			if (a.place === false) return `Copied to media/${name} — use src "${name}".`;
			let secs = num(a.seconds);
			if (!secs && kind !== 'image' && media.ffmpeg()) secs = (await media.seconds(path.join(f.dir, 'media', name))) || undefined;
			const id = a.id ?? (store.slugify(path.basename(name, ext)).replace(/^[^a-z]+/, '').slice(0, 30) || 'media');
			const clip = store.clipFrom({ id, name: a.name ?? path.basename(name, ext), kind, start: num(a.start) ?? 0, seconds: secs ?? 3, src: name, volume: num(a.volume) }, null, f.film);
			const at = store.findClip(f.film, clip.id);
			if (at) f.film.tracks[at.track].clips[at.index] = clip;
			else {
				const trackId = a.track ?? (kind === 'audio' ? 'sound' : 'media');
				let t = f.film.tracks.find((x) => x.id === trackId);
				if (!t) {
					t = { id: trackId, name: trackId[0].toUpperCase() + trackId.slice(1), kind: kind === 'audio' ? 'audio' : 'visual', clips: [] };
					if (t.kind === 'audio') f.film.tracks.push(t);
					else f.film.tracks.splice(Math.max(0, f.film.tracks.findIndex((x) => x.id === 'scenes')), 0, t);
				}
				t.clips.push(clip);
				t.clips.sort((x, y) => x.startSec - y.startSec);
			}
			store.chat(f, 'agent', `Added ${kind} “${clip.name}”`, 'act');
			store.save(f, 'media', { line: `Added “${clip.name}”` });
			return `Placed ${kind} “${clip.name}” as clip ${clip.id} at ${clip.startSec}–${(clip.startSec + clip.durationSec).toFixed(2)} s (src "${name}" in media/).`;
		},
	},
	{
		name: 'lakr_remove_clip', where: LOCAL,
		description: 'Take a clip (a scene, a media clip, a sound or the music) off the timeline by id. Its module stays unless no other clip uses it.',
		inputSchema: obj({ id: { type: 'string' } }, ['id']),
		run: (a) => {
			const f = store.open();
			const at = store.findClip(f.film, a.id);
			if (!at) throw new ToolError(`No clip “${a.id}”.`);
			const [c] = f.film.tracks[at.track].clips.splice(at.index, 1);
			if (c.module && !f.film.tracks.some((t) => t.clips.some((x) => x.module === c.module))) delete f.film.modules[c.module];
			f.film.tracks = f.film.tracks.filter((t) => t.clips.length || t.id === 'scenes');
			store.chat(f, 'agent', `Removed “${c.name ?? c.id}”`, 'act');
			store.save(f, 'remove', { line: `Removed “${c.name ?? c.id}”` });
			return `Removed ${c.id}.`;
		},
	},
	{
		name: 'lakr_sounds', where: LOCAL,
		description: "Lakr's sound library: 177 recorded, cleared sound effects (whoosh-short, whoosh-long, ui-click, key-type, pop, toggle, riser, reverse-swell, hit, soft-impact, shimmer, glitch, counter-tick) — each with its length, character and where its peak is. Filter by category or words. Placing one (lakr_add_sound) needs the Lakr account.",
		inputSchema: obj({ category: { type: 'string' }, query: { type: 'string', description: "words, e.g. 'soft swipe', 'bright click'" } }),
		run: (a) => {
			const words = library.terms(a.query ?? '');
			const hits = soundList()
				.filter((s) => !a.category || s.category === a.category)
				.map((s) => {
					const hay = [s.title, ...(s.words ?? []), ...(s.character ?? []), s.category].join(' ').toLowerCase();
					return { s, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) };
				})
				.filter((h) => !words.length || h.score > 0)
				.sort((x, y) => y.score - x.score)
				.slice(0, 24);
			if (!hits.length) return `No sound matches. Categories: ${[...new Set(soundList().map((s) => s.category))].join(', ')}.`;
			return hits.map(({ s }) => `${s.id} — ${s.category} — ${s.seconds.toFixed(2)} s, peak at ${s.peak_s.toFixed(2)} s — ${(s.character ?? []).join(', ')} — ${(s.words ?? []).join(' ')}`).join('\n');
		},
	},
	{
		name: 'lakr_add_sound', where: CLOUD,
		description: 'Place a library sound on the sound track. Its PEAK lands on the moment you give: a clip id + seconds into that clip, or seconds of the film. Needs the Lakr account (lakr_sign_in).',
		inputSchema: obj({
			sound: { type: 'string', description: 'the id from lakr_sounds, e.g. ws03' },
			clip: { type: 'string' }, at: { type: 'number', description: 'seconds into `clip` (or into the film)' },
			volume_db: { type: 'number', description: '0 = as recorded; −6 quieter (default −4)' },
		}, ['sound', 'at']),
		run: async (a) => {
			const s = soundList().find((x) => x.id === a.sound);
			if (!s) throw new ToolError(`No sound “${a.sound}” — lakr_sounds lists them.`);
			const f = store.open();
			let at = num(a.at) ?? 0;
			if (a.clip) {
				const c = store.findClip(f.film, a.clip)?.clip;
				if (!c) throw new ToolError(`No clip “${a.clip}”.`);
				at += c.startSec;
			}
			const file = path.join(f.dir, 'media', 'sfx', `${s.id}.wav`);
			if (!existsSync(file)) {
				const wav = await cloud.api(`v1/sfx/${encodeURIComponent(s.id)}`, { timeoutMs: 60_000 });
				mkdirSync(path.dirname(file), { recursive: true });
				writeFileSync(file, wav);
			}
			const start = Math.max(0, at - (s.peak_s ?? 0));
			let id = `sfx-${s.id}`;
			for (let k = 2; store.findClip(f.film, id); k++) id = `sfx-${s.id}-${k}`;
			const clip = { id, name: s.title, kind: 'audio', startSec: Math.round(start * 1000) / 1000, durationSec: s.seconds, src: `sfx/${s.id}.wav`, volume: Math.round(10 ** ((num(a.volume_db) ?? -4) / 20) * 1000) / 1000 };
			let t = f.film.tracks.find((x) => x.id === 'sound');
			if (!t) f.film.tracks.push((t = { id: 'sound', name: 'Sound', kind: 'audio', clips: [] }));
			t.clips.push(clip);
			t.clips.sort((x, y) => x.startSec - y.startSec);
			store.chat(f, 'agent', `Placed ${s.title} at ${at.toFixed(1)} s`, 'act');
			store.save(f, 'sound', { line: `Placed a sound at ${at.toFixed(1)} s` });
			return `Placed ${s.id} as ${id}: peak at ${at.toFixed(2)} s (starts ${start.toFixed(2)} s).`;
		},
	},
	{
		name: 'lakr_add_music', where: CLOUD,
		description: "A music bed under the whole film at its tempo (replaces the bed placed before). Calm 60–85 bpm, standard 90–110, energetic 112–128. Needs the Lakr account (lakr_sign_in).",
		inputSchema: obj({
			bpm: { type: 'number' }, mood: { type: 'string', enum: ['calm', 'standard', 'energetic'] },
			warmth: { type: 'string', enum: ['warm', 'cool'] }, volume_db: { type: 'number', description: 'default −14' },
		}),
		run: async (a) => {
			const f = store.open();
			const total = store.duration(f.film);
			if (!total) throw new ToolError('Plan the film first — the bed is made to its length.');
			const bpm = Math.round(num(a.bpm) ?? f.film.beats?.bpm ?? f.film.look?.bpm ?? 100);
			const mood = a.mood ?? (bpm <= 85 ? 'calm' : bpm >= 112 ? 'energetic' : 'standard');
			const warmth = a.warmth ?? 'cool';
			const secs = Math.ceil(total);
			const name = `bed-${bpm}-${mood}-${warmth}-${secs}.wav`;
			const file = path.join(f.dir, 'media', 'music', name);
			if (!existsSync(file)) {
				const wav = await cloud.api(`v1/music/bed?bpm=${bpm}&mood=${mood}&warmth=${warmth}&seconds=${secs}`, { timeoutMs: 180_000 });
				mkdirSync(path.dirname(file), { recursive: true });
				writeFileSync(file, wav);
			}
			f.film.tracks = f.film.tracks.filter((t) => t.id !== 'music');
			f.film.tracks.push({ id: 'music', name: 'Music', kind: 'audio', clips: [{ id: 'music', name: `Music bed · ${bpm} bpm ${mood}`, kind: 'audio', startSec: 0, durationSec: total, src: `music/${name}`, volume: Math.round(10 ** ((num(a.volume_db) ?? -14) / 20) * 1000) / 1000 }] });
			f.film.beats = { ...(f.film.beats ?? {}), bpm, beatsPerBar: f.film.beats?.beatsPerBar ?? 4 };
			store.chat(f, 'agent', `Music bed: ${bpm} bpm, ${mood}`, 'act');
			store.save(f, 'music', { line: `Music bed at ${bpm} bpm` });
			return `Music bed placed: ${bpm} bpm, ${mood}, ${warmth}, ${total.toFixed(1)} s. Land cuts on its beat (${(60 / bpm).toFixed(3)} s).`;
		},
	},
	{
		name: 'lakr_render', where: LOCAL,
		description: 'Render the current film to an MP4 in lakr-films/<film>/renders/ (headless Chrome + ffmpeg, with its sound). Runs in the background: if it replies "Rendering…", call it again to keep waiting — it carries on, never restarts. scale 0.5 for a quick draft.',
		inputSchema: obj({ scale: { type: 'number', enum: [0.5, 0.75, 1] }, wait: { type: 'number', description: 'seconds to wait in this call (≤ 50)' }, allow_pending: { type: 'boolean' } }),
		run: (a) => render.render(a),
	},
	{
		name: 'lakr_sign_in', where: CLOUD,
		description: "Sign the maker in to Lakr (once per machine) for the cloud tools — sounds and music. Opens their browser on Lakr's sign-in; waits for them. If it says it's still waiting, call it again after they finish.",
		inputSchema: obj({ sign_out: { type: 'boolean' } }),
		run: (a) => (a.sign_out ? cloud.signOut() : cloud.signIn()),
	},
];

// What the maker types in the preview reaches a Claude Code session started with channels on, at once — unless
// the agent is already listening with lakr_wait, which hands it over itself.
store.events.on('note', (n) => {
	if (waitingNow > 0) return;
	const where = n.element ? ` (they clicked ${n.element}${n.text ? `, “${n.text}”` : ''}${n.atSec != null ? ` at ${n.atSec} s` : ''})` : '';
	const meta = { kind: n.element ? 'pointed' : 'direction' };
	if (n.element) meta.element = String(n.element).replace(/[^A-Za-z0-9_]/g, '_');
	notify('notifications/claude/channel', {
		content: `The maker, in the Lakr preview${where}: ${n.words}\n\nCall lakr_notes to take it, do it (change only what they pointed at), tell them what you did with lakr_say, then lakr_wait to keep listening.`,
		meta,
	});
});

serve({
	name: 'lakr',
	version: VERSION,
	instructions:
		'Lakr Agentation: make and edit films (launch films, demos, motion pieces) with Lakr\'s engine. Read lakr_guide once before writing any scene. '
		+ 'Order: lakr_new_film → lakr_preview (give the maker the URL) → lakr_library → agree a storyboard in words → lakr_brief → lakr_plan_timeline → '
		+ 'lakr_put_clip per scene (read its stills) → lakr_check (fix, ≤3 rounds) → lakr_render. Edits: lakr_notes / lakr_wait, change only the element pointed at. '
		+ 'Material comes only from the maker, the internet and lakr_library: never search their computer or project unless they say where to look.',
	tools,
});
