// lakr_render — the film to an MP4 on this machine: every frame drawn by Lakr's player in headless Chrome
// (seek → settle → screenshot), piped into ffmpeg, with the film's sound clips and recordings mixed in.
// Preview-grade per PRD §7: a local Mac/Linux render is close to, not bit-identical with, the cloud's.
//
// A render outlives one tool call (Codex stops waiting after 60 s): it runs in the background and every
// lakr_render call either starts it, waits on it, or returns the finished file.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import * as chrome from './chrome.mjs';
import * as store from './film.mjs';
import * as media from './media.mjs';
import { ToolError } from './mcp.mjs';
import * as stage from './stage.mjs';

let job = null; // {key, file, frame, total, done, error, startedAt, promise}

function encoder(bin) {
	const list = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
	if (/\blibx264\b/.test(list)) return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17'];
	if (/\bh264_videotoolbox\b/.test(list)) return ['-c:v', 'h264_videotoolbox', '-b:v', '16M'];
	return ['-c:v', 'mpeg4', '-q:v', '2'];
}

/** Every sound the film makes: audio clips and recordings, each placed and trimmed. */
function sounds(f) {
	const out = [];
	const local = (src) => {
		if (!src) return null;
		if (/^https?:/i.test(src)) return src;
		const file = path.resolve(f.dir, 'media', src.replace(/^\.?\/?(media\/)?/, ''));
		return existsSync(file) ? file : null;
	};
	for (const t of f.film.tracks) {
		if (t.muted || t.hidden) continue;
		for (const c of t.clips) {
			if (c.pending || !(c.kind === 'audio' || c.kind === 'recording')) continue;
			const src = local(c.src);
			if (!src || (c.volume ?? 1) <= 0) continue;
			out.push({ src, start: c.startSec, secs: c.durationSec, trim: c.trimStartSec ?? 0, speed: c.speed ?? 1, volume: c.volume ?? 1 });
		}
	}
	return out;
}

async function work(f, j, scale) {
	const film = f.film;
	const W = Math.round((film.width * scale) / 2) * 2, H = Math.round((film.height * scale) / 2) * 2;
	const { page, moduleErrors } = await stage.load(film);
	if (Object.keys(moduleErrors).length) {
		throw new ToolError('Not rendering — modules that do not compile:\n- ' + Object.entries(moduleErrors).map(([m, e]) => `${m}: ${e}`).join('\n- '));
	}
	const bin = media.needFFmpeg('Rendering');
	const snd = sounds(f);
	const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(film.fps), '-c:v', 'mjpeg', '-i', 'pipe:0'];
	for (const s of snd) args.push('-ss', s.trim.toFixed(3), '-t', (s.secs * s.speed).toFixed(3), '-i', s.src);
	const total = store.duration(film);
	if (snd.length) {
		const parts = snd.map((s, i) => {
			const tempo = s.speed !== 1 ? `atempo=${Math.min(2, Math.max(0.5, s.speed))},` : '';
			const ms = Math.round(s.start * 1000);
			return `[${i + 1}:a]${tempo}volume=${s.volume},adelay=${ms}|${ms}[a${i}]`;
		});
		args.push('-filter_complex', `${parts.join(';')};${snd.map((_, i) => `[a${i}]`).join('')}amix=inputs=${snd.length}:normalize=0,apad[aout]`);
		args.push('-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
	}
	args.push(...encoder(bin), '-pix_fmt', 'yuv420p', '-vf', `scale=${W}:${H}`, '-t', total.toFixed(3), '-movflags', '+faststart', j.file + '.part.mp4');
	const enc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
	let err = '';
	enc.stderr.on('data', (d) => (err += d));
	const closed = new Promise((resolve) => enc.on('close', resolve));
	const write = (buf) => new Promise((resolve, reject) => (enc.stdin.write(buf, (e) => (e ? reject(e) : resolve()))));
	try {
		for (j.frame = 0; j.frame < j.total; j.frame++) {
			if (j.cancelled) throw new ToolError('Render stopped: the film changed while it was rendering. Call lakr_render again.');
			await stage.settle(page, j.frame);
			await write(await chrome.screenshot(page, { width: film.width, height: film.height, scale, quality: 94 }));
		}
	} finally {
		enc.stdin.end();
	}
	const code = await closed;
	if (code !== 0) throw new Error(`ffmpeg could not encode the film: ${err.slice(-600)}`);
	renameSync(j.file + '.part.mp4', j.file);
}

const label = (j) => `${Math.round((100 * j.frame) / j.total)} % (frame ${j.frame} of ${j.total}, ${Math.round((Date.now() - j.startedAt) / 1000)} s in)`;

export async function render(args) {
	const f = store.open();
	const scale = [0.5, 0.75, 1].includes(Number(args.scale)) ? Number(args.scale) : 1;
	if (!store.duration(f.film)) throw new ToolError('The film is empty — plan it and put its clips first.');
	const pending = f.film.tracks.flatMap((t) => t.clips.filter((c) => c.pending).map((c) => c.id));
	if (pending.length && !args.allow_pending) {
		throw new ToolError(`These scenes are still placeholder cards: ${pending.join(', ')}. Write them with lakr_put_clip first (or pass allow_pending: true for a draft).`);
	}
	const key = createHash('sha1').update(JSON.stringify(f.film) + scale).digest('hex').slice(0, 10);
	if (job && job.key !== key && !job.done) job.cancelled = true;
	if (!job || job.key !== key || (job.done && job.error)) {
		const dir = path.join(f.dir, 'renders');
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
		const j = { key, slug: f.slug, file: path.join(dir, `${f.slug}-${stamp}${scale < 1 ? `-${Math.round(scale * 100)}` : ''}.mp4`), frame: 0,
			total: Math.max(1, Math.round(store.duration(f.film) * f.film.fps)), done: false, error: null, startedAt: Date.now() };
		j.promise = work(f, j, scale)
			.then(() => {
				j.done = true;
				const g = store.open(j.slug);
				g.meta.renders = [{ file: path.relative(g.dir, j.file), at: new Date().toISOString(), seconds: store.duration(g.film), scale }, ...(g.meta.renders ?? [])].slice(0, 10);
				store.save(g, 'render');
				store.say(j.slug, `Rendered ${path.basename(j.file)}`);
			})
			.catch((e) => {
				j.done = true;
				j.error = e;
				store.say(j.slug, j.cancelled ? 'Render stopped' : 'The render failed');
			});
		job = j;
		store.say(f.slug, 'Rendering the film…');
	}
	const wait = Math.min(50, Math.max(0, Number(args.wait ?? 45))) * 1000;
	await Promise.race([job.promise, new Promise((r) => setTimeout(r, wait))]);
	if (job.error) throw job.error instanceof ToolError ? job.error : new ToolError(`The render failed: ${job.error.message ?? job.error}`);
	if (!job.done) return `Rendering — ${label(job)}. Call lakr_render again to keep waiting (it carries on in the background; it does not restart).`;
	const mb = (statSync(job.file).size / 1e6).toFixed(1);
	return `Rendered: ${job.file} (${mb} MB, ${(job.total / f.film.fps).toFixed(1)} s, ${Math.round((Date.now() - job.startedAt) / 1000)} s to render). Preview-grade local render — the maker can open it from the preview tab.`;
}

/** The headless page is shared: anything else that needs it stops a running render first (and waits for it). */
export async function stop() {
	if (!job || job.done) return false;
	job.cancelled = true;
	await job.promise;
	return true;
}

/** For the preview's Export button. */
export function status() {
	if (!job) return null;
	return { running: !job.done, pct: Math.round((100 * job.frame) / job.total), file: job.done && !job.error ? job.file : null, error: job.error ? String(job.error.message ?? job.error) : null, slug: job.slug };
}
