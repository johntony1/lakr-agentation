// The film on Lakr's player in headless Chrome: load it, learn what broke, step to any frame, take stills.
import { createHash } from 'node:crypto';
import * as chrome from './chrome.mjs';
import * as store from './film.mjs';
import * as preview from './preview.mjs';

let loaded = null; // hash of the film the page holds

const hash = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Put `film` on the headless player (only if it changed) and report compile problems. */
export async function load(film) {
	const base = await preview.start();
	const p = await chrome.page({ url: `${base}/player/index.html`, width: film.width, height: film.height });
	const playable = store.playable(film, base);
	const h = hash(playable);
	if (loaded === h) return { page: p, moduleErrors: {}, fresh: false };
	await p.eval('window.__lakrMsgs.length = 0, true');
	await p.eval(`window.lakr.setTimeline(${JSON.stringify(playable)}), true`);
	const moduleErrors = {};
	const t0 = Date.now();
	for (;;) {
		const msgs = (await p.eval('window.__lakrMsgs.slice()')) ?? [];
		for (const m of msgs) if (m.type === 'moduleError') moduleErrors[m.module] = m.message;
		const err = msgs.find((m) => m.type === 'error');
		if (err) throw new Error(`the player refused the film: ${err.message}`);
		if (msgs.some((m) => m.type === 'ready') || Date.now() - t0 > 10_000) break;
		await sleep(80);
	}
	loaded = h;
	return { page: p, moduleErrors, fresh: true };
}

export const frameOf = (film, sec) => Math.max(0, Math.min(Math.round(sec * film.fps), Math.round(store.duration(film) * film.fps) - 1));

export async function settle(p, frame) {
	await p.eval(`window.lakr.settle(${frame | 0})`, 30_000);
}

/** clipError messages since the last call. */
export async function clipErrors(p) {
	const msgs = (await p.eval('(() => { const m = window.__lakrMsgs.filter(x => x.type === "clipError"); window.__lakrMsgs = window.__lakrMsgs.filter(x => x.type !== "clipError"); return m; })()')) ?? [];
	const out = {};
	for (const m of msgs) out[m.clip] = m.message;
	return out;
}

export async function still(p, film, frame, width = 960, quality = 84) {
	await settle(p, frame);
	return chrome.screenshot(p, { width: film.width, height: film.height, scale: width / film.width, quality });
}

export async function untagged(p, film, clipId, frames) {
	const seen = new Map();
	for (const f of frames) {
		await settle(p, f);
		const list = (await p.eval(`window.lakr.untagged(${JSON.stringify(clipId)})`)) ?? [];
		for (const u of list) if (!seen.has(u.what)) seen.set(u.what, { what: u.what, at: f });
	}
	return [...seen.values()];
}
