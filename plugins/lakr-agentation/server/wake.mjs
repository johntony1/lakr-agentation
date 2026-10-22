// The preview's Send reaches the agent by itself, even when its turn is over (Claude Code).
//
// Run as the plugin's SessionStart and Stop hook with `async` + `asyncRewake`: it watches the project's films for
// notes the maker sent from the preview and, when one arrives, exits 2 with the notes on stderr, which Claude Code
// hands to the agent at once, starting a new turn if the session was idle. The Stop hook arms a fresh watcher
// after every turn; the newest one wins (a lock per session), and a note is announced once only. While the agent
// is itself listening with lakr_wait, that takes the note first: the watcher gives it a moment before it speaks.
//
//   node wake.mjs start|stop      (hook input JSON on stdin: session_id, cwd)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA } from './paths.mjs';

const GRACE_MS = 1500; // a lakr_wait already listening takes the note within this
const POLL_MS = 700;

const input = (() => {
	try {
		return JSON.parse(readFileSync(0, 'utf8') || '{}');
	} catch {
		return {};
	}
})();
const project = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const session = String(input.session_id || 'default').replace(/[^\w-]/g, '').slice(0, 80) || 'default';
const dir = path.join(DATA, 'wake');
mkdirSync(dir, { recursive: true });
const lock = path.join(dir, `${session}.json`);
const seenFile = path.join(dir, 'announced.json');

writeFileSync(lock, JSON.stringify({ pid: process.pid, project, at: Date.now() }));
const mine = () => {
	try {
		return JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid;
	} catch {
		return false;
	}
};
const readJSON = (f, d) => {
	try {
		return JSON.parse(readFileSync(f, 'utf8'));
	} catch {
		return d;
	}
};

/** Notes the maker sent that nobody has taken or announced yet, with the film they belong to. */
function fresh() {
	const films = path.join(project, 'lakr-films');
	if (!existsSync(films)) return [];
	const seen = new Set(readJSON(seenFile, []));
	const out = [];
	for (const slug of readdirSync(films)) {
		const meta = readJSON(path.join(films, slug, 'lakr.json'), null);
		for (const n of meta?.notes ?? []) {
			if (n.state === 'new' && n.id && !seen.has(n.id) && Date.now() - Date.parse(n.at || 0) > GRACE_MS) out.push({ ...n, slug });
		}
	}
	return out;
}

const tick = () => {
	if (!mine()) process.exit(0); // a newer watcher took over
	const notes = fresh();
	if (!notes.length) return;
	const seen = readJSON(seenFile, []);
	writeFileSync(seenFile, JSON.stringify([...seen, ...notes.map((n) => n.id)].slice(-500)));
	const lines = notes.map((n, i) => `${i + 1}. ${n.element ? `${n.element}${n.text ? ` (“${n.text}”)` : ''}` : n.clip ? `clip ${n.clip}` : 'the whole film'}${n.atSec != null ? ` at ${n.atSec} s` : ''}: ${n.words}`);
	process.stderr.write(
		`The maker just sent ${notes.length === 1 ? 'a note' : `${notes.length} notes`} from the Lakr preview (film “${notes[0].slug}”):\n${lines.join('\n')}\n\n`
		+ 'Do it now, without asking them to confirm: call lakr_notes to take the notes, change only what each one points at '
		+ '(lakr_get_timeline with the module, then lakr_put_clip), and tell them in one line per note what you changed with lakr_say. '
		+ 'Render again only if they asked for the MP4.',
	);
	rmSync(lock, { force: true });
	process.exit(2);
};
setInterval(tick, POLL_MS);
tick();
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => (mine() && rmSync(lock, { force: true }), process.exit(0)));
