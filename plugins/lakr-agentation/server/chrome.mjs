// Headless Chrome over the DevTools protocol, with nothing installed: Node ≥ 22's own WebSocket talks to the
// Chrome (or Chromium / Edge / Brave) already on the machine. It loads Lakr's player page from the local server,
// so what the agent's stills, lakr_check and the render see is exactly what the preview tab plays.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from './mcp.mjs';

const CANDIDATES = {
	darwin: [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
		'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
		'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
		'/Applications/Arc.app/Contents/MacOS/Arc',
	],
	linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'],
	win32: [
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	],
};

export function findChrome() {
	if (process.env.LAKR_CHROME && existsSync(process.env.LAKR_CHROME)) return process.env.LAKR_CHROME;
	return (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p)) ?? null;
}

class Page {
	constructor(ws) {
		this.ws = ws;
		this.seq = 0;
		this.waiting = new Map();
		ws.addEventListener('message', (ev) => {
			const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
			const w = msg.id !== undefined && this.waiting.get(msg.id);
			if (!w) return;
			this.waiting.delete(msg.id);
			if (msg.error) w.reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`.trim()));
			else w.resolve(msg.result);
		});
		ws.addEventListener('close', () => {
			for (const w of this.waiting.values()) w.reject(new Error('Chrome went away'));
			this.waiting.clear();
		});
	}
	send(method, params = {}, timeoutMs = 60_000) {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.waiting.set(id, {
				resolve: (v) => (clearTimeout(timer), resolve(v)),
				reject: (e) => (clearTimeout(timer), reject(e)),
			});
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	/** Evaluate an expression in the page (awaiting promises) and return its JSON value. */
	async eval(expression, timeoutMs = 60_000) {
		const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result?.value;
	}
}

let browser = null; // { proc, page, profile, url, size }

export async function page({ url, width, height, ready = '!!(window.lakr && window.__lakrLoaded)' }) {
	if (browser && browser.proc.exitCode === null) {
		if (browser.size !== `${width}x${height}`) {
			await browser.page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
			browser.size = `${width}x${height}`;
		}
		if (browser.url !== url) {
			await load(browser.page, url, ready);
			browser.url = url;
		}
		return browser.page;
	}
	const exe = findChrome();
	if (!exe) {
		throw new ToolError('Lakr needs Chrome (or Chromium, Edge, Brave) to see and render the film, and found none. Install Google Chrome, or set LAKR_CHROME to a Chromium-based browser.');
	}
	const profile = mkdtempSync(path.join(os.tmpdir(), 'lakr-chrome-'));
	const proc = spawn(exe, [
		'--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
		'--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
		'--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
		'--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb', 'about:blank',
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	const endpoint = await new Promise((resolve, reject) => {
		let err = '';
		const timer = setTimeout(() => reject(new Error('Chrome did not start in 20 s')), 20_000);
		proc.stderr.on('data', (d) => {
			err += d;
			const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
			if (m) {
				clearTimeout(timer);
				resolve(m[1]);
			}
		});
		proc.on('exit', (code) => reject(new Error(`Chrome exited (${code}): ${err.slice(-400)}`)));
	});
	const port = new URL(endpoint).port;
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const target = targets.find((t) => t.type === 'page');
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', () => reject(new Error('could not attach to Chrome')), { once: true });
	});
	const p = new Page(ws);
	await p.send('Page.enable');
	await p.send('Runtime.enable');
	await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
	await p.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 1 } });
	await load(p, url, ready);
	browser = { proc, page: p, profile, url, size: `${width}x${height}` };
	return p;
}

async function load(p, url, ready) {
	await p.send('Page.navigate', { url });
	const t0 = Date.now();
	while (Date.now() - t0 < 20_000) {
		const ok = await p.eval(ready).catch(() => false);
		if (ok) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`the page did not load: ${url}`);
}

export async function screenshot(p, { width, height, scale = 1, format = 'jpeg', quality = 86 }) {
	const r = await p.send('Page.captureScreenshot', {
		format, ...(format === 'jpeg' ? { quality } : {}),
		clip: { x: 0, y: 0, width, height, scale }, captureBeyondViewport: false, fromSurface: true,
	});
	return Buffer.from(r.data, 'base64');
}

export function close() {
	if (!browser) return;
	try {
		browser.proc.kill('SIGKILL');
	} catch {}
	try {
		rmSync(browser.profile, { recursive: true, force: true });
	} catch {}
	browser = null;
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(sig, () => {
		close();
		if (sig !== 'exit') process.exit(0);
	});
}
