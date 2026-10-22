// The live preview (PRD §4): a local web server the maker opens in their browser while the agent works.
// It serves Lakr's player and an editor shell around it — the film, its timeline of scene cards, the brief —
// and pushes every change the agent makes to the open tab over Server-Sent Events, so the tab is always the film.
// Clicking an element in the paused film and typing a change leaves a NOTE for the agent (lakr_notes).
//
// The same server feeds the headless Chrome the agent's stills, checks and renders come from (chrome.mjs).
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as store from './film.mjs';
import { agentName } from './mcp.mjs';
import { DATA, ROOT } from './paths.mjs';

const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
	'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2',
	'.woff': 'font/woff', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
	'.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.txt': 'text/plain; charset=utf-8',
};

// Captures every message the player posts (the app's WKWebView bridge, here a plain array) before player.js runs,
// and forwards it to the editor shell when the player is framed in it.
const SHIM = `<script>
window.__lakrMsgs = [];
window.webkit = { messageHandlers: { lakr: { postMessage: function (m) {
  window.__lakrMsgs.push(m); if (window.__lakrMsgs.length > 400) window.__lakrMsgs.splice(0, 200);
  if (m && m.type === 'loaded') window.__lakrLoaded = true;
  try { if (window.parent !== window) window.parent.postMessage({ lakr: m }, location.origin); } catch (e) {}
} } } };
</script>`;

let server = null;
let base = null;
const clients = new Set();

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
	res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
	res.end(body);
};
const json = (res, value, code = 200) => send(res, code, JSON.stringify(value), 'application/json');

function serveFile(req, res, file) {
	let st;
	try {
		st = statSync(file);
	} catch {
		return send(res, 404, 'not found');
	}
	if (!st.isFile()) return send(res, 404, 'not found');
	const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
	const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
	if (range) {
		// media seeks with ranges; video won't scrub without them
		const start = range[1] ? +range[1] : 0;
		const end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
		res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
		return createReadStream(file, { start, end }).pipe(res);
	}
	res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
	createReadStream(file).pipe(res);
}

/** A path under `root`, or null if the request tries to climb out of it. */
const inside = (root, rel) => {
	const p = path.resolve(root, '.' + path.sep + decodeURIComponent(rel));
	return p === root || p.startsWith(root + path.sep) ? p : null;
};

const readBody = (req) =>
	new Promise((resolve, reject) => {
		let b = '';
		req.on('data', (d) => {
			b += d;
			if (b.length > 200_000) req.destroy();
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(b || '{}'));
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});

/** The film as the tab needs it: the playable IR plus what surrounds it. */
export function snapshot() {
	const slug = store.currentSlug();
	if (!slug) return { film: null, films: store.listFilms(), workDir: store.workDir() };
	const f = store.open(slug);
	return {
		slug,
		name: f.meta.name ?? slug,
		film: store.playable(f.film, base),
		duration: store.duration(f.film),
		brief: f.meta.summary ?? null,
		fullBrief: f.meta.brief ?? null,
		notes: f.meta.notes.filter((n) => n.state !== 'done').slice(-30),
		renders: f.meta.renders ?? [],
		chat: (f.meta.chat ?? []).slice(-80),
		turn: (() => {
			const h = store.history(f);
			return { lines: h.turn?.lines ?? [], open: !!h.turn, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
		})(),
		agent: agentName(),
		listening,
		films: store.listFilms(),
		render: renderStatus?.() ?? null,
		version: store.filmVersion(),
	};
}

let renderStatus = null;
let renderStart = null;
import('./render.mjs').then((m) => {
	renderStatus = m.status;
	renderStart = m.render;
});

function handle(req, res) {
	const url = new URL(req.url, 'http://x');
	const p = url.pathname;
	// only this machine's browser talks to us (DNS-rebinding guard: a page elsewhere can't aim a name at 127.0.0.1)
	const host = (req.headers.host ?? '').split(':')[0];
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 403, 'forbidden');

	if (p === '/' || p === '/index.html') return serveFile(req, res, path.join(ROOT, 'preview', 'index.html'));
	if (p.startsWith('/preview/')) {
		const file = inside(path.join(ROOT, 'preview'), p.slice('/preview/'.length));
		return file ? serveFile(req, res, file) : send(res, 403, 'forbidden');
	}
	if (p === '/player/' || p === '/player/index.html') {
		const html = readFileSync(path.join(ROOT, 'player', 'index.html'), 'utf8').replace('<script src=', SHIM + '\n<script src=');
		return send(res, 200, html, 'text/html; charset=utf-8');
	}
	if (p.startsWith('/player/')) {
		const file = inside(path.join(ROOT, 'player'), p.slice('/player/'.length));
		return file ? serveFile(req, res, file) : send(res, 403, 'forbidden');
	}
	// the player resolves relative media with staticFile → /player/public/…; the film's own media live per film
	if (p.startsWith('/media/') || p.startsWith('/renders/')) {
		const slug = store.currentSlug();
		if (!slug) return send(res, 404, 'no film');
		const dir = path.join(store.workDir(), slug, p.startsWith('/media/') ? 'media' : 'renders');
		const file = inside(dir, p.replace(/^\/(media|renders)\//, ''));
		return file ? serveFile(req, res, file) : send(res, 403, 'forbidden');
	}
	if (p === '/preview/fonts.css') {
		// Inter, from the player's own bundle (hashed file names): the editor's type
		let css = '';
		try {
			for (const f of readdirSync(path.join(ROOT, 'player', 'assets'))) {
				const m = f.match(/^inter-latin-(\d{3})-normal-.*\.woff2$/);
				if (m) css += `@font-face{font-family:"Inter";font-weight:${m[1]};font-style:normal;font-display:swap;src:url(/player/assets/${f}) format("woff2")}\n`;
			}
		} catch {}
		return send(res, 200, css, 'text/css; charset=utf-8');
	}
	if (p === '/api/film') return json(res, snapshot());
	if (req.method === 'POST' && p.startsWith('/api/') && req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, 'json only');
	if (req.method === 'POST' && ['/api/undo', '/api/redo', '/api/turn', '/api/look', '/api/clip', '/api/remove', '/api/render', '/api/use'].includes(p)) {
		return readBody(req)
			.then(async (b) => {
				if (p === '/api/use') {
					store.use(String(b.slug ?? ''));
					return json(res, { ok: true });
				}
				const f = store.open();
				if (p === '/api/undo') return json(res, { ok: store.undo(f) });
				if (p === '/api/redo') return json(res, { ok: store.redo(f) });
				if (p === '/api/turn') {
					const turn = store.settleTurn(f, !!b.keep);
					if (turn && !b.keep) {
						const g = store.open();
						const what = turn.lines.length ? turn.lines.join('; ') : 'the last changes';
						g.meta.notes.push({ id: `n${Date.now().toString(36)}`, words: `I undid your last changes (${what}). Ask me what to do instead, or try another way.`, element: null, clip: null, atSec: null, state: 'new', at: new Date().toISOString() });
						store.chat(g, 'maker', 'Undid your changes', 'act');
						store.save(g, 'note', { record: false });
					}
					return json(res, { ok: !!turn });
				}
				if (p === '/api/render') {
					if (!renderStart) return json(res, { error: 'not ready' }, 503);
					renderStart({ scale: [0.5, 1].includes(b.scale) ? b.scale : 1, wait: 0, allow_pending: true }).catch(() => {});
					return json(res, { ok: true });
				}
				const at = store.findClip(f.film, String(b.clip ?? ''));
				if (!at) return json(res, { error: 'no such clip' }, 404);
				if (p === '/api/remove') {
					const [c] = f.film.tracks[at.track].clips.splice(at.index, 1);
					if (c.module && !f.film.tracks.some((t) => t.clips.some((x) => x.module === c.module))) delete f.film.modules[c.module];
					store.chat(f, 'maker', `Deleted “${c.name ?? c.id}”`, 'act');
					store.save(f, 'maker', { by: 'maker' });
					return json(res, { ok: true });
				}
				if (p === '/api/clip') {
					if (typeof b.volume === 'number') at.clip.volume = Math.max(0, Math.min(2, b.volume));
					if (typeof b.name === 'string' && b.name.trim()) at.clip.name = b.name.trim().slice(0, 80);
					store.save(f, 'maker', { by: 'maker' });
					return json(res, { ok: true });
				}
				// /api/look: the inspector paints an element's font / size / weight / colour / tracking (elements.<el>.look)
				const el = String(b.element ?? '').split(':').slice(1).join(':') || String(b.element ?? '');
				if (!el) return json(res, { error: 'element' }, 400);
				const clip = at.clip;
				clip.elements ??= {};
				const cur = { ...(clip.elements[el]?.look ?? {}) };
				for (const [k, v] of Object.entries(b.look ?? {})) {
					if (!['font', 'size', 'weight', 'color', 'tracking'].includes(k)) continue;
					if (v === null || v === '') delete cur[k];
					else cur[k] = String(v).slice(0, 60);
				}
				clip.elements[el] = { ...(clip.elements[el] ?? {}), look: cur };
				if (!Object.keys(cur).length) delete clip.elements[el].look;
				if (!Object.keys(clip.elements[el]).length) delete clip.elements[el];
				if (!Object.keys(clip.elements).length) delete clip.elements;
				store.save(f, 'look', { by: 'maker' });
				return json(res, { ok: true });
			})
			.catch((e) => json(res, { error: String(e?.message ?? e) }, 400));
	}
	if (p === '/api/events') {
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
		res.write('retry: 1000\n\n');
		clients.add(res);
		req.on('close', () => clients.delete(res));
		return;
	}
	if (p === '/api/notes' && req.method === 'POST') {
		return readBody(req)
			.then((b) => {
				const words = String(b.words ?? '').trim().slice(0, 2000);
				if (!words) return json(res, { error: 'say what to change' }, 400);
				const f = store.open();
				const note = {
					id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
					words,
					element: typeof b.element === 'string' ? b.element.slice(0, 120) : null,
					clip: typeof b.clip === 'string' ? b.clip.slice(0, 60) : (typeof b.element === 'string' ? b.element.split(':')[0] : null),
					atSec: typeof b.atSec === 'number' ? Math.round(b.atSec * 100) / 100 : null,
					rect: b.rect && typeof b.rect === 'object' ? b.rect : null,
					text: typeof b.text === 'string' ? b.text.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
					state: 'new',
					at: new Date().toISOString(),
				};
				f.meta.notes.push(note);
				store.chat(f, 'maker', note.element ? `${note.element}: ${words}` : words, 'note');
				store.save(f, 'note', { record: false });
				store.events.emit('note', note);
				json(res, note);
			})
			.catch(() => json(res, { error: 'bad request' }, 400));
	}
	if (p.startsWith('/api/notes/') && req.method === 'DELETE') {
		const f = store.open();
		const id = p.slice('/api/notes/'.length);
		f.meta.notes = f.meta.notes.filter((n) => n.id !== id);
		store.save(f, 'note');
		return json(res, { ok: true });
	}
	return send(res, 404, 'not found');
}

const broadcast = (event, data) => {
	const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const c of clients) c.write(line);
};
store.events.on('film', (e) => broadcast('film', e));
store.events.on('status', (e) => broadcast('status', e));
// The agent hears the preview when it is waiting in lakr_wait, or (Claude Code) when the plugin's wake hook is armed
// for this project: that one starts a turn by itself as soon as a note is sent (wake.mjs).
let listening = false, waiting = false;
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
};
export function hookArmed() {
	const dir = path.join(DATA, 'wake'), here = path.resolve(process.env.LAKR_PROJECT || process.cwd());
	if (!existsSync(dir)) return false;
	return readdirSync(dir).some((f) => {
		if (!f.endsWith('.json') || f === 'announced.json') return false;
		try {
			const w = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
			return path.resolve(w.project) === here && alive(w.pid);
		} catch {
			return false;
		}
	});
}
const relisten = () => {
	const on = waiting || hookArmed();
	if (on !== listening) broadcast('listening', { on: (listening = on) });
};
store.events.on('waiting', (e) => {
	waiting = !!e.on;
	relisten();
});
setInterval(relisten, 2000).unref();
setInterval(() => broadcast('ping', {}), 25_000).unref();

/** Start (once) and return the base URL. Tries a stable port first so a reopened tab finds it again. */
export async function start() {
	if (base) return base;
	const want = Number(process.env.LAKR_PREVIEW_PORT) || 4517;
	for (let port = want; port < want + 20; port++) {
		const ok = await new Promise((resolve) => {
			const s = http.createServer(handle);
			s.once('error', () => resolve(null));
			s.listen(port, '127.0.0.1', () => resolve(s));
		});
		if (ok) {
			server = ok;
			server.unref?.();
			base = `http://127.0.0.1:${port}`;
			return base;
		}
	}
	// every stable port is taken (several agents at once): any free one
	server = await new Promise((resolve) => {
		const s = http.createServer(handle);
		s.listen(0, '127.0.0.1', () => resolve(s));
	});
	base = `http://127.0.0.1:${server.address().port}`;
	return base;
}

export const baseURL = () => base;
export const tabsOpen = () => clients.size;

/** Open the preview in the maker's default browser. */
export function openInBrowser(url) {
	if (process.env.LAKR_NO_BROWSER) return false;
	const [cmd, args] =
		process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
	try {
		spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
		return true;
	} catch {
		return false;
	}
}

export const exists = () => existsSync(path.join(ROOT, 'preview', 'index.html'));
