// The film on disk, in the Lakr IR (motion/src/timeline/types.ts — the same TimelineFilm the Mac app edits).
//
//   <work>/lakr-films/<slug>/film.json   the IR: tracks of clips, modules of TSX
//   <work>/lakr-films/<slug>/lakr.json   what is not the film: brief, notes from the preview, library searched
//   <work>/lakr-films/<slug>/media/      pictures, recordings, sounds the film uses (src paths are relative to here)
//   <work>/lakr-films/<slug>/renders/    exports
//
// One film is "current" (<work>/lakr-films/.current) so every tool works on it without naming it.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ToolError } from './mcp.mjs';

export const events = new EventEmitter();
events.setMaxListeners(50);

// Claude Code hands the project as LAKR_PROJECT (${CLAUDE_PROJECT_DIR}); Codex starts the server in it.
export const workDir = () =>
	path.resolve(process.env.LAKR_FILMS_DIR || path.join(process.env.LAKR_PROJECT || process.cwd(), 'lakr-films'));

const readJSON = (file, fallback) => {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
};
const writeJSON = (file, value) => {
	const tmp = file + '.tmp';
	writeFileSync(tmp, JSON.stringify(value, null, '\t'));
	renameSync(tmp, file); // atomic: the preview never reads half a film
};

export const slugify = (s) =>
	String(s || 'film').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'film';

export const defaultLook = (title = 'Film') => ({
	title,
	bpm: 100,
	mood: 'standard',
	palette: { ground: '#F4F3EF', ink: '#121214', muted: '#6B6B70', accent: '#FF6A3D', surface: '#FFFFFF', line: 'rgba(0,0,0,0.08)', dark: false },
});

export const blankFilm = ({ title, width = 1920, height = 1080, fps = 30 } = {}) => ({
	kind: 'timeline',
	version: 1,
	fps,
	width,
	height,
	look: defaultLook(title),
	modules: {},
	tracks: [{ id: 'scenes', name: 'Scenes', kind: 'visual', clips: [] }],
	beats: { bpm: 100, beatsPerBar: 4 },
});

export const duration = (film) =>
	Math.max(0, ...film.tracks.flatMap((t) => t.clips.map((c) => (c.startSec ?? 0) + (c.durationSec ?? 0))));

export const findClip = (film, id) => {
	for (let t = 0; t < film.tracks.length; t++) {
		const i = film.tracks[t].clips.findIndex((c) => c.id === id);
		if (i >= 0) return { track: t, index: i, clip: film.tracks[t].clips[i] };
	}
	return null;
};

export const listFilms = () => {
	const dir = workDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, 'film.json')))
		.map((d) => d.name);
};

export function currentSlug() {
	const dir = workDir();
	const named = (() => {
		try {
			return readFileSync(path.join(dir, '.current'), 'utf8').trim();
		} catch {
			return '';
		}
	})();
	if (named && existsSync(path.join(dir, named, 'film.json'))) return named;
	const films = listFilms();
	return films.length === 1 ? films[0] : null;
}

export function open(slug = currentSlug()) {
	if (!slug) throw new ToolError('No film yet. Start one with lakr_new_film (a name, and the size if it is not 1920×1080).');
	const dir = path.join(workDir(), slug);
	const film = readJSON(path.join(dir, 'film.json'), null);
	if (!film) throw new ToolError(`No film “${slug}” in ${workDir()}. lakr_new_film starts one; lakr_get_timeline lists the films here.`);
	const meta = readJSON(path.join(dir, 'lakr.json'), {});
	meta.notes ??= [];
	return { slug, dir, film, meta };
}

let version = 0;
const MAX_HISTORY = 40;

// Undo / redo and "your agent's changes": per film, in <film>/.history.json, so they survive a restart.
//   past/future: whole films (the IR) before/after each change; turn: what the agent changed since the maker
//   last pressed Keep (the film before it, and the lines saying what it did).
const historyFile = (f) => path.join(f.dir, '.history.json');
export const history = (f) => readJSON(historyFile(f), null) ?? { past: [], future: [], turn: null };
const writeHistory = (f, h) => {
	h.past = h.past.slice(-MAX_HISTORY);
	h.future = h.future.slice(-MAX_HISTORY);
	writeJSON(historyFile(f), h);
};

/** Write the film. `by` = who changed it ('agent' | 'maker'); `line` = what the agent did, for its changes card. */
export function save(f, why = 'changed', { by = 'agent', line = null, record = true } = {}) {
	mkdirSync(f.dir, { recursive: true });
	const file = path.join(f.dir, 'film.json');
	const before = readJSON(file, null);
	const changed = !before || JSON.stringify(before) !== JSON.stringify(f.film);
	if (record && changed && before) {
		const h = history(f);
		h.past.push({ film: before, why, by, at: Date.now() });
		h.future = [];
		if (by === 'agent') {
			h.turn ??= { base: before, lines: [], at: Date.now() };
			if (line) h.turn.lines.push(line);
		}
		writeHistory(f, h);
	} else if (record && by === 'agent' && line) {
		const h = history(f);
		if (h.turn) {
			h.turn.lines.push(line);
			writeHistory(f, h);
		}
	}
	writeJSON(file, f.film);
	f.meta.updatedAt = new Date().toISOString();
	writeJSON(path.join(f.dir, 'lakr.json'), f.meta);
	version++;
	events.emit('film', { slug: f.slug, version, why });
}

function restore(f, film, why) {
	f.film = film;
	writeJSON(path.join(f.dir, 'film.json'), f.film);
	writeJSON(path.join(f.dir, 'lakr.json'), f.meta);
	version++;
	events.emit('film', { slug: f.slug, version, why });
}

export function undo(f) {
	const h = history(f);
	const last = h.past.pop();
	if (!last) return false;
	h.future.push({ film: f.film, why: last.why, by: last.by, at: Date.now() });
	writeHistory(f, h);
	restore(f, last.film, 'undo');
	return true;
}

export function redo(f) {
	const h = history(f);
	const next = h.future.pop();
	if (!next) return false;
	h.past.push({ film: f.film, why: next.why, by: next.by, at: Date.now() });
	writeHistory(f, h);
	restore(f, next.film, 'redo');
	return true;
}

/** The maker keeps (or takes back) everything the agent changed since the last Keep. */
export function settleTurn(f, keep) {
	const h = history(f);
	const turn = h.turn;
	h.turn = null;
	if (!turn) return null;
	if (!keep) {
		h.past.push({ film: f.film, why: 'undo-turn', by: 'maker', at: Date.now() });
		h.future = [];
	}
	writeHistory(f, h);
	if (!keep) restore(f, turn.base, 'undo-turn');
	else events.emit('film', { slug: f.slug, version: ++version, why: 'keep' });
	return turn;
}

/** A line in the Film column: the agent talking (lakr_say), the agent's actions, or the maker's directions. */
export function chat(f, from, text, kind = 'say') {
	f.meta.chat ??= [];
	f.meta.chat.push({ from, kind, text: String(text).slice(0, 4000), at: Date.now() });
	f.meta.chat = f.meta.chat.slice(-120);
}

export const say = (slug, words) => events.emit('status', { slug, words, at: Date.now() });
export const filmVersion = () => version;

export function newFilm({ name, width, height, fps, look }) {
	const title = String(name || 'Untitled film').trim();
	let slug = slugify(title);
	const dir0 = workDir();
	mkdirSync(dir0, { recursive: true });
	for (let n = 2; existsSync(path.join(dir0, slug, 'film.json')); n++) slug = `${slugify(title)}-${n}`;
	const dir = path.join(dir0, slug);
	mkdirSync(path.join(dir, 'media'), { recursive: true });
	const film = blankFilm({ title, width: num(width) ?? 1920, height: num(height) ?? 1080, fps: num(fps) ?? 30 });
	if (look && typeof look === 'object') mergeLook(film, look);
	const f = { slug, dir, film, meta: { name: title, createdAt: new Date().toISOString(), notes: [] } };
	save(f, 'new');
	writeFileSync(path.join(dir0, '.current'), slug);
	return f;
}

export function use(slug) {
	const f = open(slugify(slug));
	writeFileSync(path.join(workDir(), '.current'), f.slug);
	events.emit('film', { slug: f.slug, version: ++version, why: 'switched' });
	return f;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : undefined);

export function mergeLook(film, look) {
	const { palette, type, ...rest } = look;
	film.look = { ...film.look, ...rest };
	if (palette && typeof palette === 'object') film.look.palette = { ...film.look.palette, ...palette };
	if (type && typeof type === 'object') film.look.type = { ...(film.look.type ?? {}), ...type };
	if (num(rest.bpm)) film.beats = { ...(film.beats ?? {}), bpm: num(rest.bpm), beatsPerBar: film.beats?.beatsPerBar ?? 4 };
}

const ID = /^[a-z][a-zA-Z0-9_-]{0,40}$/;
const KINDS = ['scene', 'figma', 'text', 'image', 'recording', 'audio'];

/** {id, name, kind, start, seconds, export, …} → a clip; fields not sent keep the existing clip's values (AgentTimeline.swift). */
export function clipFrom(c, module, existing) {
	if (!c || typeof c !== 'object') throw new ToolError('clip: an object {id, name, start, seconds, export, note}');
	if (typeof c.id !== 'string' || !ID.test(c.id)) throw new ToolError('clip.id: lowercase start, letters/digits/-/_ (it becomes the data-lakr prefix)');
	const old = existing ? findClip(existing, c.id)?.clip : null;
	const clip = old ? structuredClone(old) : { id: c.id, kind: 'scene', startSec: 0, durationSec: 3 };
	delete clip.pending;
	if (module) clip.module = module;
	if (typeof c.name === 'string') clip.name = c.name;
	if (KINDS.includes(c.kind)) clip.kind = c.kind;
	const start = num(c.start ?? c.startSec), secs = num(c.seconds ?? c.durationSec);
	if (start !== undefined) clip.startSec = Math.max(0, start);
	if (secs !== undefined) clip.durationSec = Math.max(0.2, secs);
	for (const k of ['export', 'note', 'src']) if (typeof c[k] === 'string') clip[k] = c[k];
	for (const k of ['enter', 'props', 'cues', 'figma']) if (c[k] !== undefined) clip[k] = c[k];
	for (const k of ['trimStartSec', 'speed', 'volume']) if (num(c[k]) !== undefined) clip[k] = num(c[k]);
	if (typeof c.drift === 'boolean') clip.drift = c.drift;
	if (Array.isArray(c.keyframes)) {
		clip.keyframes = c.keyframes
			.filter((k) => k && typeof k.property === 'string' && num(k.t) !== undefined && num(k.value) !== undefined)
			.map((k) => ({ property: k.property, t: num(k.t), value: num(k.value), ...(k.easing !== undefined ? { easing: k.easing } : {}) }));
	}
	if (c.elements && typeof c.elements === 'object') {
		if (Object.keys(c.elements).length) clip.elements = c.elements;
		else delete clip.elements;
	}
	return clip;
}

function placeClip(film, clip, trackId) {
	const at = findClip(film, clip.id);
	if (at) {
		film.tracks[at.track].clips[at.index] = clip;
		return;
	}
	const id = trackId || (clip.kind === 'audio' ? 'sound' : 'scenes');
	let t = film.tracks.findIndex((x) => x.id === id);
	if (t < 0) {
		const track = { id, name: id[0].toUpperCase() + id.slice(1), kind: clip.kind === 'audio' ? 'audio' : 'visual', clips: [] };
		// visual tracks above the scenes go in front (index 0 = top); sound goes at the bottom
		if (track.kind === 'audio') film.tracks.push(track);
		else film.tracks.unshift(track);
		t = film.tracks.indexOf(track);
	}
	film.tracks[t].clips.push(clip);
	film.tracks[t].clips.sort((a, b) => a.startSec - b.startSec);
}

export function plan(f, items, bpm, look) {
	if (!Array.isArray(items) || !items.length) throw new ToolError('clips: [{id, name, start, seconds, note, track?}]');
	if (look && typeof look === 'object') mergeLook(f.film, look);
	if (num(bpm)) mergeLook(f.film, { bpm: num(bpm) });
	for (const t of f.film.tracks) t.clips = t.clips.filter((c) => !c.pending);
	let added = 0;
	for (const it of items) {
		if (typeof it?.id !== 'string' || !ID.test(it.id) || findClip(f.film, it.id)) continue;
		placeClip(f.film, {
			id: it.id, name: it.name, kind: 'scene',
			startSec: Math.max(0, num(it.start ?? it.startSec) ?? 0),
			durationSec: Math.max(0.3, num(it.seconds ?? it.durationSec) ?? 3),
			note: it.note, pending: true,
		}, it.track);
		added++;
	}
	return added;
}

export function put(f, module, source, clipArgs, track) {
	if (typeof module !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(module)) throw new ToolError('module: a short name like "scenes" or "opening"');
	if (typeof source !== 'string' || !source.trim() || source.length > 160_000) throw new ToolError("source: the module's TSX (under 160 kB)");
	const before = f.film.modules[module]?.source;
	f.film.modules[module] = { source };
	let clip = null;
	if (clipArgs) {
		clip = clipFrom(clipArgs, module, f.film);
		placeClip(f.film, clip, track);
	}
	return { clip, before };
}

/** What the tab and the headless renderer play: media paths made into URLs the local server serves. */
export function playable(film, base) {
	const out = structuredClone(film);
	const fix = (src) => (typeof src === 'string' && src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/')
		? `${base}/media/${src.replace(/^\.?\/?(media\/)?/, '').split('/').map(encodeURIComponent).join('/')}` : src);
	for (const t of out.tracks) for (const c of t.clips) if (c.src) c.src = fix(c.src);
	if (out.logo) out.logo = fix(out.logo);
	if (out.footage) out.footage = fix(out.footage);
	for (const s of out.stills ?? []) s.src = fix(s.src);
	// a placeholder card is not yet code: the player draws nothing for it, the preview's timeline shows the card
	return out;
}
