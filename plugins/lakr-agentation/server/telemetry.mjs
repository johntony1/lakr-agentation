// Anonymous usage counts, so we know how many people use the skill: a random install id (made here, kept in DATA),
// the version, which agent runs it, and one of three events: start, film, render. Nothing about the maker, their
// project, prompts, films or files. LAKR_TELEMETRY=0 (or DO_NOT_TRACK=1) turns it off. A ping never blocks or fails a tool.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { client } from './mcp.mjs';
import { DATA, VERSION } from './paths.mjs';

const STATS = process.env.LAKR_STATS_URL || 'https://sonoftony2--lakr-skill-stats-web.us-east.modal.run/ping';
const off = () => /^(0|false|off|no)$/i.test(process.env.LAKR_TELEMETRY ?? '') || /^(1|true)$/i.test(process.env.DO_NOT_TRACK ?? '');

let id;
function installId() {
	if (id) return id;
	const file = path.join(DATA, 'install-id');
	try {
		id = readFileSync(file, 'utf8').trim();
		if (/^[0-9a-f]{32}$/.test(id)) return id;
	} catch {}
	id = randomBytes(16).toString('hex');
	try {
		mkdirSync(DATA, { recursive: true });
		writeFileSync(file, id + '\n');
	} catch {}
	return id;
}

/** event: 'start' | 'film' | 'render' */
export function ping(event) {
	if (off()) return;
	const host = /codex/i.test(client.name) ? 'codex' : /claude/i.test(client.name) ? 'claude' : 'other';
	fetch(STATS, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id: installId(), v: VERSION, host, event }),
		signal: AbortSignal.timeout(5000),
	}).catch(() => {});
}
