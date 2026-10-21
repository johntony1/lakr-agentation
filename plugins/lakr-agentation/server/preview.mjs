// The live preview (PRD §4): a local web server the maker opens in their browser while the agent works.
// It serves Lakr's player and an editor shell around it — the film, its timeline of scene cards, the brief —
// and pushes every change the agent makes to the open tab over Server-Sent Events, so the tab is always the film.
// Clicking an element in the paused film and typing a change leaves a NOTE for the agent (lakr_notes).
//
// The same server feeds the headless Chrome the agent's stills, checks and renders come from (chrome.mjs).
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as store from './film.mjs';
import { ROOT } from './paths.mjs';

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
		notes: f.meta.notes.filter((n) => n.state !== 'done').slice(-30),
		renders: f.meta.renders ?? [],
		version: store.filmVersion(),
	};
}

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
	if (p === '/api/film') return json(res, snapshot());
	if (p === '/api/events') {
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
		res.write('retry: 1000\n\n');
		clients.add(res);
		req.on('close', () => clients.delete(res));
		return;
	}
	if (p === '/api/notes' && req.method === 'POST') {
		if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, 'json only');
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
				store.save(f, 'note');
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
