// Lakr's cloud, for what a laptop can't do alone: the recorded sound library and music beds made at the film's
// tempo (PRD §7). Everything else in the skill is local.
//
// Sign-in uses the OAuth server Lakr already runs for its Claude connector (Supabase OAuth 2.1, consent at
// lakr.app/oauth/consent): the skill registers itself as a public client, opens the browser once, takes the code
// on a loopback redirect with PKCE, and keeps ITS OWN refresh token (never the Mac app's), so the maker signs in
// once per machine. A LAKR_TOKEN from the environment (Claude Code userConfig / Codex env) wins over all of it.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ToolError } from './mcp.mjs';
import { DATA, ROOT } from './paths.mjs';
import { openInBrowser } from './preview.mjs';

const SERVICE = process.env.LAKR_SERVICE || 'https://sonoftony2--lakr-motion-api.modal.run';
const RESOURCE = 'https://api.lakr.app/mcp';
const CALLBACK_PORTS = [45180, 45181, 45182, 45183];
const sessionFile = () => path.join(DATA, 'session.json');
// An unset Claude Code userConfig value can arrive as its own placeholder; that is no token.
const ENV_TOKEN = /^\$\{|^\s*$/.test(process.env.LAKR_TOKEN ?? '') ? null : process.env.LAKR_TOKEN.trim();

const readSession = () => {
	try {
		return JSON.parse(readFileSync(sessionFile(), 'utf8'));
	} catch {
		return {};
	}
};
const writeSession = (s) => {
	mkdirSync(DATA, { recursive: true });
	writeFileSync(sessionFile(), JSON.stringify(s, null, '\t'), { mode: 0o600 });
	try {
		chmodSync(sessionFile(), 0o600);
	} catch {}
};

let meta;
async function server() {
	if (meta) return meta;
	const pr = await (await fetch('https://api.lakr.app/.well-known/oauth-protected-resource', { signal: AbortSignal.timeout(15_000) })).json();
	const issuer = pr.authorization_servers[0];
	const u = new URL(issuer);
	meta = await (await fetch(`${u.origin}/.well-known/oauth-authorization-server${u.pathname}`, { signal: AbortSignal.timeout(15_000) })).json();
	return meta;
}

export function signedIn() {
	if (ENV_TOKEN) return { how: 'token' };
	const s = readSession();
	return s.refresh_token || (s.access_token && s.expires_at > Date.now() / 1000) ? { how: 'browser', email: s.email ?? null } : null;
}

async function refresh(s) {
	const m = await server();
	const r = await fetch(m.token_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id }),
		signal: AbortSignal.timeout(20_000),
	});
	if (!r.ok) return null;
	const t = await r.json();
	const next = { ...s, access_token: t.access_token, refresh_token: t.refresh_token ?? s.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (t.expires_in ?? 3600) };
	writeSession(next);
	return next;
}

async function token(force = false) {
	if (ENV_TOKEN) return ENV_TOKEN;
	let s = readSession();
	if (!s.access_token) return null;
	if (force || !(s.expires_at > Date.now() / 1000 + 60)) {
		if (!s.refresh_token) return null;
		s = await refresh(s);
		if (!s) return null;
	}
	return s.access_token;
}

const NEED = 'This is one of Lakr\'s cloud services and needs the maker\'s Lakr account. Call lakr_sign_in: it opens their browser once to sign in to Lakr; after that it stays signed in on this machine. Everything else (writing, previewing, checking, rendering) works without it.';

export async function api(pathAndQuery, { timeoutMs = 120_000 } = {}) {
	let t = await token();
	if (!t) throw new ToolError(NEED);
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await fetch(`${SERVICE}/${pathAndQuery}`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(timeoutMs) });
		if (r.status === 401 && attempt === 0 && !ENV_TOKEN) {
			t = await token(true);
			if (!t) break;
			continue;
		}
		if (r.status === 401) break;
		if (!r.ok) {
			const body = await r.text().catch(() => '');
			throw new ToolError(`Lakr's service said no (${r.status}): ${body.slice(0, 300)}`);
		}
		return Buffer.from(await r.arrayBuffer());
	}
	throw new ToolError('The Lakr sign-in has expired or was revoked. ' + NEED);
}

/** Public: the laws Lakr drew from 2,000+ studied launch films (no sign-in). Fresh when the service answers, else the
 *  last copy fetched on this machine, else the copy bundled with the plugin. */
export async function laws() {
	const cache = path.join(DATA, 'cache', 'laws.md');
	try {
		const r = await fetch(`${SERVICE}/v1/references/styles`, { signal: AbortSignal.timeout(45_000) });
		const fresh = r.ok ? (await r.json()).laws ?? null : null;
		if (fresh) {
			mkdirSync(path.dirname(cache), { recursive: true });
			writeFileSync(cache, fresh);
			return fresh;
		}
	} catch {}
	for (const file of [cache, path.join(ROOT, 'guide', 'LAWS.md')]) {
		try {
			return readFileSync(file, 'utf8');
		} catch {}
	}
	return null;
}

// ── sign-in ────────────────────────────────────────────────────────────────────

let pending = null; // {promise, url}

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function listen() {
	for (const port of CALLBACK_PORTS) {
		const s = await new Promise((resolve) => {
			const srv = http.createServer();
			srv.once('error', () => resolve(null));
			srv.listen(port, '127.0.0.1', () => resolve(srv));
		});
		if (s) return { srv: s, uri: `http://127.0.0.1:${port}/callback` };
	}
	throw new ToolError(`Ports ${CALLBACK_PORTS.join(', ')} are all busy, so the sign-in can't come back. Close what uses them, or set LAKR_TOKEN.`);
}

async function client(m, uri) {
	const s = readSession();
	if (s.client_id && s.redirect_uri === uri) return s.client_id;
	const r = await fetch(m.registration_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			client_name: 'Lakr Agentation (agent skill)', redirect_uris: [uri], grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'], token_endpoint_auth_method: 'none', client_uri: 'https://lakr.app',
		}),
		signal: AbortSignal.timeout(20_000),
	});
	if (!r.ok) throw new ToolError(`Lakr's sign-in server would not register the skill (${r.status}): ${(await r.text()).slice(0, 200)}`);
	const c = await r.json();
	writeSession({ ...s, client_id: c.client_id, redirect_uri: uri });
	return c.client_id;
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0d0d0f;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:420px;text-align:center}b{color:#FF6A3D;font-size:22px;display:block;margin-bottom:8px}</style>
<main><b>${title}</b>${body}</main>`;

async function begin() {
	const m = await server();
	const { srv, uri } = await listen();
	const clientId = await client(m, uri);
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash('sha256').update(verifier).digest());
	const state = b64url(randomBytes(16));
	const url = new URL(m.authorization_endpoint);
	for (const [k, v] of Object.entries({
		response_type: 'code', client_id: clientId, redirect_uri: uri, code_challenge: challenge, code_challenge_method: 'S256',
		state, scope: 'openid email offline_access', resource: RESOURCE,
	})) url.searchParams.set(k, v);
	const promise = new Promise((resolve, reject) => {
		const timer = setTimeout(() => (srv.close(), reject(new ToolError('The sign-in was not finished within 10 minutes. Call lakr_sign_in to try again.'))), 600_000);
		srv.on('request', async (req, res) => {
			const q = new URL(req.url, uri).searchParams;
			if (!req.url.startsWith('/callback')) return res.writeHead(404).end();
			if (q.get('state') !== state) return res.writeHead(400, { 'content-type': 'text/html' }).end(PAGE('That link is stale', 'Go back to your agent and sign in again.'));
			if (q.get('error')) {
				res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE('Not connected', 'You can close this tab.'));
				clearTimeout(timer);
				srv.close();
				return reject(new ToolError(`The sign-in was declined (${q.get('error')}).`));
			}
			try {
				const r = await fetch(m.token_endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: uri, client_id: clientId, code_verifier: verifier, resource: RESOURCE }),
				});
				if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
				const t = await r.json();
				let email = null;
				try {
					email = JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url').toString()).email ?? null;
				} catch {}
				writeSession({ ...readSession(), access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (t.expires_in ?? 3600), email });
				res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE('Lakr is connected', 'Your agent can use Lakr\'s sounds and music now. You can close this tab.'));
				resolve(email);
			} catch (e) {
				res.writeHead(500, { 'content-type': 'text/html' }).end(PAGE('Something went wrong', 'Go back to your agent and try again.'));
				reject(new ToolError(`The sign-in could not finish: ${e.message}`));
			} finally {
				clearTimeout(timer);
				srv.close();
			}
		});
	});
	return { promise, url: url.toString() };
}

export async function signIn({ wait = 45 } = {}) {
	const who = signedIn();
	if (who && !pending) return `Already signed in to Lakr${who.email ? ` as ${who.email}` : ''}${who.how === 'token' ? ' (LAKR_TOKEN)' : ''}.`;
	if (!pending) {
		pending = await begin();
		pending.promise.catch(() => {}).finally(() => setTimeout(() => (pending = null), 0));
		openInBrowser(pending.url);
	}
	const url = pending.url;
	const result = await Promise.race([pending.promise.then((email) => ({ email })), new Promise((r) => setTimeout(() => r(null), Math.min(55, wait) * 1000))]);
	if (!result) return `Waiting for the maker to sign in. Their browser opened Lakr's sign-in; if it didn't, give them this link:\n${url}\nCall lakr_sign_in again once they say they're done.`;
	return `Signed in to Lakr${result.email ? ` as ${result.email}` : ''}. Sounds and music work now.`;
}

export function signOut() {
	const s = readSession();
	writeSession({ client_id: s.client_id, redirect_uri: s.redirect_uri });
	return 'Signed out of Lakr on this machine.';
}

export const sessionPath = () => (existsSync(sessionFile()) ? sessionFile() : null);
