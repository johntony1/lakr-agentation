// lakr_check — what a still can't tell you, measured across the whole film (a port of FilmCheck in the Mac app).
// Every half second it reads each visible piece of tagged text (where it sits, how big, how long it stays) and diffs
// the picture against the last: text cut off or crowding the edge, text on text, type a phone can't read, words gone
// before they can be read, stretches where nothing moves. Plus a contact sheet to judge by eye.
import * as store from './film.mjs';
import * as media from './media.mjs';
import { image, text } from './mcp.mjs';
import * as stage from './stage.mjs';

const js = (width) => `(() => {
  const root = document.querySelector('[data-lakr-root]'); if (!root) return null;
  const R = root.getBoundingClientRect(); if (R.width < 1) return null;
  const k = ${width} / R.width, out = [];
  for (const el of root.querySelectorAll('[data-lakr]')) {
    const words = (el.innerText || '').trim(); if (!words) continue;
    if ([...el.querySelectorAll('[data-lakr]')].some(c => (c.innerText || '').trim())) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let op = 1; for (let e = el; e && e !== root.parentElement; e = e.parentElement) { op *= parseFloat(getComputedStyle(e).opacity); if (op < 0.05) break; }
    if (!(op >= 0.6)) continue;
    const g = document.createRange(); g.selectNodeContents(el); const t = g.getBoundingClientRect();
    if (t.width < 1 || t.height < 1) continue;
    const b = el.getBoundingClientRect(), sc = el.offsetHeight ? b.height / el.offsetHeight : 1;
    out.push({ key: el.getAttribute('data-lakr'), text: words.slice(0, 50), x: (t.left - R.left) * k, y: (t.top - R.top) * k,
               w: t.width * k, h: t.height * k, fs: parseFloat(cs.fontSize) * sc * k });
  }
  return out;
})()`;

const overlap = (a, b) => {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
};

export async function run(film, from, to) {
	const W = film.width, H = film.height, fps = film.fps, total = store.duration(film);
	const a = Math.max(0, from ?? 0), b = Math.min(total, to ?? total);
	if (b <= a) return [text('Nothing to check: the film has no clips in that range yet.')];
	const { page, moduleErrors } = await stage.load(film);
	if (Object.keys(moduleErrors).length) {
		return [text('Not checkable yet — modules that do not compile:\n- ' + Object.entries(moduleErrors).map(([m, e]) => `${m}: ${e}`).join('\n- '))];
	}
	const step = Math.max(0.5, (b - a) / 90);
	const times = [];
	for (let t = a + 0.05; t < b; t += step) times.push(t);
	const seen = new Map();
	const defects = [];
	const flagged = new Set();
	const flag = (rank, id, t, line) => {
		if (flagged.has(id)) return;
		flagged.add(id);
		defects.push({ rank, at: t, line: `${t.toFixed(1)} s (frame ${Math.round(t * fps)}) — ${line}` });
	};
	const frames = [], thumbs = [];
	const canSee = !!media.ffmpeg();
	for (const t of times) {
		const f = stage.frameOf(film, t);
		await stage.settle(page, f);
		const texts = ((await page.eval(js(W))) ?? []).map((o) => ({ key: o.key, text: o.text ?? '', r: { x: o.x, y: o.y, w: o.w, h: o.h }, size: o.fs }));
		for (const x of texts) {
			const { r } = x, q = `“${x.text.slice(0, 32)}” (${x.key})`;
			if (r.x < -2 || r.y < -2 || r.x + r.w > W + 2 || r.y + r.h > H + 2) flag(0, `cut|${x.key}`, t, `${q} is cut off by the frame edge`);
			else if (r.x < W * 0.04 || r.y < H * 0.04 || r.x + r.w > W * 0.96 || r.y + r.h > H * 0.96) flag(4, `edge|${x.key}`, t, `${q} crowds the edge — keep a 5 % margin`);
			const phone = (x.size * 360) / W;
			if (phone < 8.5) flag(3, `small|${x.key}`, t, `${q} is ${Math.round(x.size)} px — ${phone.toFixed(1)} px on a phone, too small to read`);
			const s = seen.get(x.key) ?? { text: x.text, first: t, total: 0 };
			s.total += step;
			s.text = x.text;
			seen.set(x.key, s);
		}
		for (let i = 0; i < texts.length; i++)
			for (let j = i + 1; j < texts.length; j++) {
				const p = texts[i], q = texts[j];
				if (overlap(p.r, q.r) > 0.15 * Math.min(p.r.w * p.r.h, q.r.w * q.r.h)) {
					flag(1, `hit|${[p.key, q.key].sort().join('+')}`, t, `“${p.text.slice(0, 24)}” (${p.key}) overlaps “${q.text.slice(0, 24)}” (${q.key})`);
				}
			}
		const still = await stage.still(page, film, f, 320, 70);
		frames.push(still);
		if (canSee) thumbs.push(await media.gray(still));
	}
	const errors = await stage.clipErrors(page);
	for (const [clip, message] of Object.entries(errors)) flag(0, `throw|${clip}`, 0, `clip ${clip} throws while rendering: ${message}`);
	// read before it goes: ~200 words a minute, plus a beat to find it
	for (const [key, s] of seen) {
		const words = s.text.split(/\s+/).filter(Boolean).length;
		const need = 0.5 + words * 0.3;
		if (words >= 2 && s.total + step < need && s.first + s.total < b - 0.5) {
			flag(2, `read|${key}`, s.first, `“${s.text.slice(0, 32)}” (${key}) is readable for ~${s.total.toFixed(1)} s; its ${words} words need ${need.toFixed(1)} s`);
		}
	}
	// nothing moving for 2.5 s is a frozen frame, not a hold
	let run = 0;
	for (let i = 1; i < thumbs.length; i++) {
		run = media.diff(thumbs[i], thumbs[i - 1]) < 0.0035 ? run + 1 : 0;
		if (run * step >= 2.5 && i < thumbs.length - 1) {
			flag(2, `still|${Math.floor(times[i] / 5)}`, times[i] - run * step, `nothing moves for ${(run * step).toFixed(1)} s — give the hold an ambient idle (slow push 1.00→1.03, drift, breathing) or cut sooner`);
		}
	}
	defects.sort((x, y) => x.rank - y.rank || x.at - y.at);
	let report = `Checked ${a.toFixed(1)}–${b.toFixed(1)} s every ${step.toFixed(1)} s: `;
	report += defects.length
		? `${defects.length} defect${defects.length === 1 ? '' : 's'}, worst first:\n- ${defects.slice(0, 12).map((d) => d.line).join('\n- ')}\n\nFix the worst three with scoped edits (location · observed · change · what stays fixed), re-send those clips, then lakr_check again — up to three rounds.`
		: 'no measurable defects. Still judge the contact sheet below by eye against the brief.';
	if (!canSee) report += '\n\n(ffmpeg is not installed, so frozen stretches were not measured and there is no contact sheet.)';
	const out = [text(report)];
	const sheet = canSee ? await media.contactSheet(frames, 6, 24) : null;
	if (sheet) {
		out.push(text(`Contact sheet, left to right then down, ${((b - a) / Math.min(frames.length, 24)).toFixed(1)} s apart — score hook in 2 s, phone readability, motion, variety, brand, story 1–10:`));
		out.push(image(sheet));
	}
	return out;
}
