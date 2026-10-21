// ffmpeg for everything pictures and sound: frames out of reference films, contact sheets, the grey thumbnails
// lakr_check compares, and the render's encode + mix. Uses the ffmpeg on PATH (or LAKR_FFMPEG).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from './mcp.mjs';

let found;
export function ffmpeg() {
	if (found !== undefined) return found;
	const tries = [process.env.LAKR_FFMPEG, 'ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].filter(Boolean);
	found = tries.find((c) => spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0) ?? null;
	return found;
}
export function needFFmpeg(what) {
	const f = ffmpeg();
	if (!f) throw new ToolError(`${what} needs ffmpeg, and it isn't installed. Install it (macOS: brew install ffmpeg · Linux: apt install ffmpeg · Windows: winget install ffmpeg), or set LAKR_FFMPEG.`);
	return f;
}

/** Run ffmpeg; resolve stdout as a Buffer. */
export function run(args, { input, timeoutMs = 120_000 } = {}) {
	const bin = needFFmpeg('This');
	return new Promise((resolve, reject) => {
		const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
		const out = [];
		let err = '';
		const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
		p.stdout.on('data', (d) => out.push(d));
		p.stderr.on('data', (d) => (err += d));
		p.on('error', reject);
		p.on('close', (code) => {
			clearTimeout(timer);
			code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed (${code}): ${err.slice(-500)}`));
		});
		if (input) p.stdin.end(input);
		else p.stdin.end();
	});
}

export async function seconds(src) {
	const r = await new Promise((resolve) => {
		const p = spawn(needFFmpeg('Reading a video'), ['-hide_banner', '-i', src], { stdio: ['ignore', 'ignore', 'pipe'] });
		let err = '';
		p.stderr.on('data', (d) => (err += d));
		p.on('close', () => resolve(err));
		p.on('error', () => resolve(''));
	});
	const m = r.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
	return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

/** `count` evenly spaced frames of a video (file or URL), as JPEGs `width` wide. */
export async function frames(src, count, width = 768) {
	const secs = await seconds(src);
	if (!secs) return [];
	const shots = await Promise.all(Array.from({ length: count }, (_, k) =>
		run(['-ss', ((secs * (k + 0.5)) / count).toFixed(2), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { timeoutMs: 30_000 }).catch(() => null)));
	return shots.filter((j) => j && j.length);
}

/** 32×18 grey pixels of a JPEG — enough to tell whether anything moved. */
export async function gray(jpeg) {
	try {
		return await run(['-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0', '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', 'pipe:1'], { input: jpeg, timeoutMs: 15_000 });
	} catch {
		return Buffer.alloc(0);
	}
}

export const diff = (a, b) => {
	if (!a.length || a.length !== b.length) return 1;
	let s = 0;
	for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
	return s / a.length / 255;
};

/** Frames tiled left to right then down, 320 px each. */
export async function contactSheet(jpegs, columns = 6, max = 24) {
	if (!jpegs.length) return null;
	const pick = jpegs.length <= max ? jpegs : Array.from({ length: max }, (_, i) => jpegs[Math.floor((i * jpegs.length) / max)]);
	const dir = mkdtempSync(path.join(os.tmpdir(), 'lakr-sheet-'));
	try {
		pick.forEach((j, i) => writeFileSync(path.join(dir, `${String(i + 1).padStart(4, '0')}.jpg`), j));
		const cols = Math.min(columns, pick.length), rows = Math.ceil(pick.length / cols);
		const out = path.join(dir, 'sheet.jpg');
		await run(['-y', '-i', path.join(dir, '%04d.jpg'), '-vf', `scale=320:-2,tile=${cols}x${rows}:padding=4:margin=4:color=0x1f1f1f`, '-frames:v', '1', '-q:v', '4', out]);
		return readFileSync(out);
	} catch {
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Fetch a URL into the cache once; null on failure. */
export async function cached(url, file) {
	if (existsSync(file)) return file;
	mkdirSync(path.dirname(file), { recursive: true });
	try {
		const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
		if (!r.ok) return null;
		const tmp = file + '.part';
		writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
		renameSync(tmp, file);
		return file;
	} catch {
		return null;
	}
}
