// lakr_library — ONE library: Lakr's 2,177 studied launch films and HyperFrames' 455 motion pieces (Apache-2.0),
// searched together and ranked only by fit. A port of FilmLibrary / FilmReferences / FilmBlocks in the Mac app
// (AgentTimeline.swift), with the same yardstick, so the skill and the app pick the same references.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as media from './media.mjs';
import { image, text, ToolError } from './mcp.mjs';
import { DATA, ROOT } from './paths.mjs';

const load = (file, fallback) => {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
};
let films, pieces;
const allFilms = () => (films ??= load(path.join(ROOT, 'library', 'launch_refs.json'), []));
const allPieces = () => (pieces ??= load(path.join(ROOT, 'library', 'hyperframes', 'index.json'), []));

const STOP = new Set(['a', 'an', 'the', 'and', 'of', 'for', 'with', 'my', 'make', 'video', 'film', 'like', 'style', 'me',
	'launch', 'app', 'it', 'to', 'in', 'on', 'that', 'this', 'some', 'want', 'need', 'lol']);
export const terms = (q) => String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));

const brandHit = (brand, t) =>
	!!brand && t.some((w) => brand === w || brand.startsWith(w + ' ') || brand.startsWith(w + '.') || brand.replaceAll(' ', '') === w);

/** Same yardstick for both: words hit in the name/brand count most, then tags/style, then the description. */
export function find(query, n) {
	const t = terms(query);
	if (!t.length) return [];
	const hits = [];
	for (const r of allFilms()) {
		const brand = (r.brand ?? '').toLowerCase();
		const style = [r.style, r.category, r.label].filter(Boolean).join(' ').toLowerCase();
		const note = (r.note ?? '').toLowerCase();
		let s = brandHit(brand, t) ? 100 : 0;
		for (const w of t) s += style.includes(w) ? 4 : note.includes(w) ? 2 : 0;
		if (s < 4) continue;
		if ((r.note?.length ?? 0) >= 30 && !(r.note ?? '').includes('(skim)')) s += 1;
		s += Math.min(1, (r.like_rate ?? 0) * 10);
		hits.push({ type: 'film', item: r, score: s });
	}
	for (const i of allPieces()) {
		const name = `${i.name} ${i.title}`.toLowerCase(), tags = (i.tags ?? []).join(' ').toLowerCase();
		const about = `${i.description} ${i.prompt}`.toLowerCase();
		let s = 0;
		for (const w of t) s += name.includes(w) ? 6 : tags.includes(w) ? 4 : about.includes(w) ? 2 : 0;
		if (s < 4) continue;
		hits.push({ type: 'piece', item: i, score: s + (i.kind === 'block' ? 0.5 : 0) });
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, n);
}

async function filmFrames(r, count) {
	const file = await media.cached(`https://cdn.launchvideos.gallery/videos/${r.id}.mp4`, path.join(DATA, 'cache', 'references', `${r.id}.mp4`));
	return file && media.ffmpeg() ? media.frames(file, count) : [];
}
async function pieceFrames(i, count) {
	if (!i.video) return [];
	const file = await media.cached(i.video, path.join(DATA, 'cache', 'blocks', `${i.name}.mp4`));
	return file && media.ffmpeg() ? media.frames(file, count) : [];
}

function openPiece(i) {
	const src = path.join(ROOT, 'library', 'hyperframes', 'src');
	let out = `# ${i.title} — ${i.kind} by ${i.author ?? 'HyperFrames'} (Apache-2.0)\n${i.description}\n`;
	if (i.prompt) out += `\nThe prompt that made it:\n${i.prompt}\n`;
	if (i.template) {
		try {
			out += `\n## Its editing contract\n${readFileSync(path.join(src, i.template), 'utf8')}\n`;
		} catch {}
	}
	for (const h of i.html ?? []) {
		let s;
		try {
			s = readFileSync(path.join(src, h), 'utf8');
		} catch {
			continue;
		}
		if (s.length > 40_000) s = s.slice(0, 40_000) + '\n…(cut — the rest repeats the pattern)';
		out += `\n## ${h}\n\`\`\`html\n${s}\n\`\`\`\n`;
	}
	return out + '\nRebuild this in your module: same staging, timing and easing, driven by useCurrentFrame — your film\'s palette, type and copy. Never paste GSAP.';
}

export async function search(args, onStudied) {
	const names = (Array.isArray(args.open) ? args.open : String(args.open ?? '').split(/[,+]/)).map((s) => String(s).trim()).filter(Boolean);
	if (names.length > 1) {
		let out = [];
		for (const n of names.slice(0, 4)) out = out.concat(await search({ open: n }, onStudied));
		const fs = names.filter((n) => allFilms().some((r) => r.id === n)), ps = names.filter((n) => allPieces().some((i) => i.name === n));
		if (fs.length && ps.length) {
			out.push(text(`COMBINE: build ${ps.join(' and ')}'s mechanics (staging, timing, easing, the event it shows) in the look of the film${fs.length > 1 ? 's' : ''} above — their palette discipline, type scale, light, camera and pacing — with this film's own copy and product. Neither is pasted: the piece gives the move, the film gives the world it happens in.`));
		}
		return out;
	}
	if (names.length === 1) {
		const name = names[0];
		const piece = allPieces().find((i) => i.name === name);
		if (piece) {
			onStudied?.();
			return [text(openPiece(piece)), ...(await pieceFrames(piece, 6)).map((j) => image(j))];
		}
		const r = allFilms().find((x) => x.id === name);
		if (r) {
			onStudied?.();
			return [text(`${r.brand ?? '?'} — ${r.style ?? ''} — ${r.note ?? ''}\n${r.url ?? ''}`), ...(await filmFrames(r, 8)).map((j) => image(j))];
		}
		throw new ToolError(`Nothing called “${name}” — search with \`query\` and open a result by the name it shows.`);
	}
	const query = String(args.query ?? '').trim();
	if (!query) throw new ToolError('query: a brand, a style, or what a moment must do ("linear", "tilted UI glow", "money count up")');
	onStudied?.();
	const n = Math.min(10, Math.max(1, Number(args.n) || 6));
	const hits = find(query, n);
	if (!hits.length) return [text(`Nothing in Lakr's library fits “${query}”. Look it up on the web if you can, or build it from the playbook.`)];
	const lines = [`${hits.length} from Lakr's library for “${query}”, best fit first. A film = a real launch to borrow look and pacing from (never its brand); a piece = one technique with its source. \`open\` any by its name for more:`];
	hits.forEach((h, k) => {
		if (h.type === 'film') {
			const r = h.item;
			const stats = [r.seconds && `${Math.round(r.seconds)} s`, r.cuts_per_s && `${r.cuts_per_s.toFixed(2)} cuts/s`, r.sound].filter(Boolean).join(' · ');
			lines.push(`${k + 1}. film ${r.id} — ${r.brand ?? '?'} — ${r.style ?? ''} — ${stats}\n   ${(r.note ?? '').slice(0, 300)}`);
		} else {
			const i = h.item;
			lines.push(`${k + 1}. piece ${i.name} — ${i.title}${i.seconds ? `, ${Math.round(i.seconds)} s` : ''} — ${i.description}`);
		}
	});
	// a film's look × a piece's technique, looked for past the top results (a brand's films can fill every slot)
	const wide = find(query, 60);
	const topFilm = wide.find((h) => h.type === 'film')?.item;
	const topPieces = wide.filter((h) => h.type === 'piece').slice(0, 2).map((h) => h.item);
	if (topFilm && topPieces.length) {
		lines.push(`\nUse together: the look of film ${topFilm.id} (${topFilm.brand ?? '?'}) × the technique of ${topPieces.map((p) => `piece ${p.name}`).join(' / ')} — lakr_library open "${topFilm.id}, ${topPieces[0].name}"`);
	}
	const out = [text(lines.join('\n'))];
	// fetched side by side: a first search downloads three reference films
	const shown = await Promise.all(hits.slice(0, 3).map((h) => (h.type === 'film' ? filmFrames(h.item, 4) : pieceFrames(h.item, 3)).catch(() => [])));
	hits.slice(0, 3).forEach((h, k) => {
		if (!shown[k].length) return;
		out.push(text(h.type === 'film' ? `film ${h.item.id} (${h.item.brand ?? ''}), in order:` : `piece ${h.item.name}, in order:`));
		for (const j of shown[k]) out.push(image(j));
	});
	return out;
}

/** The closest studied films/pieces to a written brief (offered back after lakr_brief). */
export function fits(brief, n = 5) {
	return find(brief, n).map((h) =>
		h.type === 'film'
			? `- film ${h.item.id} — ${h.item.brand ?? '?'} — ${h.item.style ?? ''} — ${(h.item.note ?? '').slice(0, 180)}`
			: `- piece ${h.item.name} — ${(h.item.description ?? '').slice(0, 160)}`);
}

export const counts = () => ({ films: allFilms().length, pieces: allPieces().length });
