// Drives web.descript.com in the Chrome window opened by launch.sh, over CDP on port 9333.
// Every command connects, does one thing, prints what it saw and disconnects.
// Usage: node descript.mjs <command> [args]   (commands listed at the bottom)
import { scriptRows, tok, lcs, wordDiff, planCuts, draftRows } from './plan.mjs';
import { chromium } from 'playwright';

const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
// Two chats can each finish a reel in its own window of this Chrome. DESCRIPT_PROJECT (the project id from the
// project link) picks the window; with it unset and more than one project open, nothing runs rather than guess.
const tabs = b.contexts()[0].pages().filter(x => x.url().includes('web.descript.com'));
const want = process.env.DESCRIPT_PROJECT;
const p = want ? tabs.find(x => x.url().includes(want)) : tabs.length === 1 ? tabs[0] : null;
if (!p) {
  console.log(want ? `no Descript tab open on ${want}` : tabs.length ? 'more than one Descript project open; set DESCRIPT_PROJECT to the project id' : 'no web.descript.com tab');
  for (const t of tabs) console.log('  open:', t.url());
  process.exit(1);
}
const wait = ms => p.waitForTimeout(ms);
const [cmd, ...args] = process.argv.slice(2);
await p.evaluate(() => { for (const el of [document.scrollingElement, document.body, document.documentElement]) if (el && el.scrollTop) el.scrollTop = 0; });
// never work on a playing timeline: positions and frames drift while it plays
if ((await p.locator('[data-testid="play-button"]').getAttribute('aria-label').catch(() => null)) === 'Pause') { await p.click('[data-testid="play-button"]'); await p.waitForTimeout(500); }

// "00:57.2 / 01:08.2" -> { now, total }
async function timecode() {
  const t = await p.evaluate(() => (document.body.innerText.replace(/\s+/g, ' ').match(/(\d?\d:\d\d) ?\. ?(\d) ?\/ ?(\d?\d:\d\d) ?\. ?(\d)/) || []).slice(1));
  return { now: `${t[0]}.${t[1]}`, total: `${t[2]}.${t[3]}` };
}
async function blocks() {
  return p.evaluate(() => [...document.querySelectorAll('[aria-label="Project Transcript"] [data-block=true]')].map(d => [d.getAttribute('data-block-key'), d.innerText]));
}
// ruler labels -> seconds-to-pixels
async function ruler() {
  return p.evaluate(() => {
    const tl = document.querySelector('[data-testid="timeline-zoom-control"]')?.getBoundingClientRect();
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) {
      const t = n.textContent.trim();
      // tick labels are m:ss, m:ss.s or, zoomed right in on a short video, m:ss.ss; the playhead's own tag (00:33) sits on
      // the ruler too and is skipped
      if (!/^\d:\d\d(\.\d{1,2})?$/.test(t)) continue;
      const r = n.parentElement.getBoundingClientRect();
      if (tl && r.y > tl.y + 15 && r.y < tl.y + 60 && r.x < 1230) out.push([t.split(':').reduce((a, x) => a * 60 + +x, 0), r.x + r.width / 2, r.y + r.height / 2]);
    }
    out.sort((a, c) => a[0] - c[0]);
    if (out.length < 2) return null;
    const [a, c] = [out[0], out[out.length - 1]];
    const pps = (c[1] - a[1]) / (c[0] - a[0]);
    return { pps, x0: a[1] - a[0] * pps, y: a[2], last: c[0] };
  });
}
// a wheel over the side panel at its end scrolls the whole page, which throws every later click out; put it back
async function unscrollPage() { await p.evaluate(() => { for (const el of [document.scrollingElement, document.body, document.documentElement]) if (el && el.scrollTop) el.scrollTop = 0; }); }
async function zoom(dir, n) { await unscrollPage(); for (let i = 0; i < n; i++) { await p.getByRole('button', { name: dir === 'in' ? 'Zoom In' : 'Zoom Out' }).click(); await wait(250); } }
async function toStart() { const r = await ruler(); await p.mouse.move(600, r ? r.y + 60 : 700); await p.mouse.wheel(-100000, 0); await wait(400); }
// zoom out until the whole composition is on screen, then scroll to 0
async function fit() {
  const total = (await timecode()).total.split(':').reduce((a, x) => a * 60 + +x, 0);
  for (let i = 0; i < 12; i++) {
    await toStart();
    const r = await ruler();
    if (r && r.x0 + total * r.pps < 1215) return r;
    await zoom('out', 1);
  }
  return ruler();
}
async function seek(sec) { const r = await ruler(); await p.mouse.click(r.x0 + sec * r.pps, r.y); await wait(500); return timecode(); }
async function clips() {
  // Descript marked a clip timeline-clip-<id> until 9 Oct 2026, then timeline-clip with the id in data-tau-id; both are read
  return p.evaluate(() => [...document.querySelectorAll('[data-testid^="timeline-clip"]')].map(e => { const r = e.getBoundingClientRect(); return { id: e.getAttribute('data-tau-id') || e.getAttribute('data-testid').replace('timeline-clip-', ''), x: +r.x.toFixed(1), w: +r.width.toFixed(1), y: Math.round(r.y), name: e.textContent.trim().slice(0, 30) }; }));
}
async function gaps() {
  return p.evaluate(() => [...document.querySelectorAll('.Wordbar__FullGap')].map(e => { const r = e.getBoundingClientRect(); return { s: parseFloat(e.querySelector('.Wordbar__FullGap__TimeIndicator')?.textContent), x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
}
async function panel(name) {
  // the rail button carries data-selected="true" while its panel is open; clicking an open one closes it
  const btn = p.locator('button[data-selected]').filter({ hasText: new RegExp(`^${name}$`) }).last();
  if ((await btn.getAttribute('data-selected')) !== 'true') { await btn.click(); await wait(1000); }
}
// a timeline clip is only safe to grab when its row is above the script track; below it you grab the script
// layer rows scrolled out of the pane are not in the page, and a short clip zoomed out renders as a marker with no id;
// scroll the layer pane top to bottom until the clip appears
async function findClip(id) {
  const el = p.locator(`[data-testid="timeline-clip-${id}"], [data-testid="timeline-clip"][data-tau-id="${id}"]`);
  for (let i = 0; i < 30 && !(await el.count()); i++) {
    await p.evaluate(i => { const s = document.querySelector('[data-testid="timeline-pin-area"]'); if (s) s.scrollTop = i * 40; }, i);
    await wait(150);
  }
  return (await el.count()) > 0;
}
async function safeBox(id) {
  const el = p.locator(`[data-testid="timeline-clip-${id}"], [data-testid="timeline-clip"][data-tau-id="${id}"]`);
  if (!(await findClip(id))) { console.log(`no clip ${id} on screen; zoom in or scroll to it`); process.exit(1); }
  // bring the clip's row into the visible layer pane (vertical scroll only; the timeline's horizontal position is left alone)
  await p.evaluate(id => { const pane = document.querySelector('[data-testid="timeline-pin-area"]'); const e = document.querySelector(`[data-testid="timeline-clip-${id}"], [data-testid="timeline-clip"][data-tau-id="${id}"]`); if (!pane || !e) return; const a = pane.getBoundingClientRect(), c = e.getBoundingClientRect(); if (c.y < a.y + 5 || c.y + c.height > a.y + a.height - 5) pane.scrollTop += c.y - a.y - (a.height - c.height) / 2; }, id);
  await wait(300);
  // no scrollIntoView: it scrolls the timeline smoothly, and a ruler read mid-scroll puts the clip seconds out
  let r = await el.boundingBox();
  for (let i = 0; i < 10; i++) { await wait(200); const r2 = await el.boundingBox(); if (Math.abs(r2.x - r.x) < 0.1 && Math.abs(r2.y - r.y) < 0.1) break; r = r2; }
  const top = await p.evaluate(() => document.querySelector('.Timeline__MainScript').getBoundingClientRect().y);
  if (!r || r.y + 12 >= top - 2) { console.log(`REFUSE: clip ${id} sits under the script track; make the layer pane taller (drag the divider above the script down)`); process.exit(1); }
  return r;
}
// a clip's start in seconds, measured zoomed in where a pixel is about 5ms (zoomed out a pixel is 60ms)
async function measure(id, near) {
  await fit(); let r = await ruler(), approx = near === undefined ? 0 : +near;
  if (await findClip(id)) { const c = await safeBox(id); r = await ruler(); approx = (c.x - 2 - r.x0) / r.pps; }
  await zoom('in', 4); await toStart(); r = await ruler();
  await p.mouse.move(600, r.y + 60); await p.mouse.wheel(Math.max(0, r.x0 + approx * r.pps - 600), 0); await wait(800);
  const c = await safeBox(id); r = await ruler();
  return (c.x - 2 - r.x0) / r.pps;
}

// the value in a Properties field, read from the input on the same row as its label
async function readField(label) {
  return p.evaluate(l => {
    const lab = [...document.querySelectorAll('div,span,label')].find(e => e.children.length === 0 && e.textContent.trim() === l && e.getBoundingClientRect().x > 1235 && e.getBoundingClientRect().y > 90);
    if (!lab) return null; const r = lab.getBoundingClientRect();
    const inp = [...document.querySelectorAll('input')].map(i => [i, i.getBoundingClientRect()]).filter(([i, q]) => Math.abs(q.y + q.height / 2 - (r.y + r.height / 2)) < 12 && q.x > r.x && q.x < r.x + 160).sort((a, z) => a[1].x - z[1].x)[0];
    return inp ? inp[0].value : null;
  }, label);
}
// set a field typed as m:ss.s (the zoom popup's Start and End), found by label
async function timeField(label, sec) {
  const pos = await p.evaluate(l => { const lab = [...document.querySelectorAll('div,span,label')].filter(e => e.children.length === 0 && e.textContent.trim() === l && e.getBoundingClientRect().x > 1100).pop(); if (!lab) return null; const r = lab.getBoundingClientRect(); return [r.y + r.height / 2]; }, label);
  if (!pos) throw new Error('no ' + label);
  const m = Math.floor(sec / 60), ss = (sec - m * 60).toFixed(1).padStart(4, '0');
  await p.mouse.click(1510, pos[0]); await p.keyboard.press('Meta+a'); await p.keyboard.type(`${m}:${ss}`); await p.keyboard.press('Enter'); await wait(700);
}
// a panel section's heading position (Animation, Audio, Size and position), scrolling the panel to find it
async function heading(name) {
  for (const dy of [0, 3000, -6000]) {
    if (dy) { await p.mouse.move(1372, 500); await p.mouse.wheel(0, dy); await wait(500); await unscrollPage(); }
    const r = await p.evaluate(n => { const e = [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && e.textContent.trim() === n && e.getBoundingClientRect().x > 1235 && e.getBoundingClientRect().x < 1300); if (!e) return null; const q = e.getBoundingClientRect(); return q.y > 60 && q.y < 880 ? { x: q.x, y: q.y + q.height / 2 } : null; }, name);
    if (r) return r;
  }
  throw new Error('no heading ' + name);
}
async function clickText(text, { exact = true, minX = 0, last = false } = {}) {
  const loc = p.getByText(text, { exact });
  const n = await loc.count();
  for (let i = 0; i < n; i++) { const k = last ? n - 1 - i : i; const r = await loc.nth(k).boundingBox(); if (r && r.x >= minX && r.width > 0) { await p.mouse.click(r.x + r.width / 2, r.y + r.height / 2); await wait(700); return true; } }
  throw new Error('no text ' + text);
}
// a text layer's track on the timeline (the cover line, the captions), found by its label
async function textTrack(label) {
  return p.evaluate(l => { const e = [...document.querySelectorAll('[data-testid="timeline-track"]')].find(t => t.textContent.includes(l)); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, label);
}
function zoomKeyframeY() {
  // the zoom's keyframe diamonds sit on the line between the script's word chips and its waveform
  return p.evaluate(() => { const w = [...document.querySelectorAll('[class*="Wordbar__Word"]')].map(e => e.getBoundingClientRect()).filter(r => r.height > 8)[0]; return w ? w.y + w.height + 1 : null; });
}
// zoom the timeline in and scroll so <sec> sits mid-screen; returns the ruler
async function focus(sec) {
  await fit(); await zoom('in', 4); await toStart(); let r = await ruler();
  await p.mouse.move(600, r.y + 60); await p.mouse.wheel(Math.max(0, r.x0 + sec * r.pps - 600), 0); await wait(700);
  return ruler();
}
// select a layer by its name in the Scene's Layers list (Script, Bold: Two words, the cover line's text)
// alt: a pattern the selected title may match instead, for a layer Descript names after its source file
async function selectLayer(name, alt) {
  const ok = t => String(t).startsWith(name.slice(0, 10)) || (alt && alt.test(String(t)));
  await panel('Properties');
  if (ok(await selectedTitle())) return;
  await p.keyboard.press('Escape'); await wait(200);
  // the preview pane's background, left of the video, clears the selection to the Scene
  const c = await p.evaluate(() => { const c = [...document.querySelectorAll('canvas')].map(c => c.getBoundingClientRect()).filter(r => r.width > 100 && r.x > 700 && r.y < 600).sort((a, z) => z.width * z.height - a.width * a.height)[0]; return { x: 728, y: c.y + c.height / 2 }; });
  await p.mouse.click(c.x, c.y); await wait(500);
  const lh = await heading('Layers');
  const sy = await p.evaluate(([y, n]) => { const e = [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && e.textContent.trim().startsWith(n) && e.getBoundingClientRect().x > 1235 && e.getBoundingClientRect().y > y); if (!e) return null; e.scrollIntoView({ block: 'center' }); for (const el of [document.scrollingElement, document.body, document.documentElement]) if (el) el.scrollTop = 0; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, [lh.y, name]);
  if (!sy) throw new Error('no layer ' + name + ' in the Layers list');
  await p.mouse.click(sy[0], sy[1]); await wait(900);
  const t = await selectedTitle(); if (!ok(t)) throw new Error(name + ' not selected: ' + t);
}
// the script clip can show as "Script" or as its iPhone source file (IMG_5748.MOV on Liv's second reel, 18 Oct 2026)
const selectScript = () => selectLayer('Script', /^IMG_\d+\.(MOV|MP4)$/i);
// every transcript block's raw text, scrolling each into view so none is a skeleton
async function fullTranscript() {
  const keys = await p.evaluate(() => [...document.querySelectorAll('[aria-label="Project Transcript"] [data-block=true]')].map(d => d.getAttribute('data-block-key')));
  const out = [];
  for (const k of keys) {
    await p.evaluate(k => document.querySelector(`[data-block=true][data-block-key="${k}"]`)?.scrollIntoView({ block: 'center' }), k); await wait(250);
    const t = await p.evaluate(k => [...document.querySelector(`[data-block=true][data-block-key="${k}"]`).querySelectorAll('[data-text=true]')].map(s => s.textContent).join(''), k);
    out.push([k, t]);
  }
  return out;
}
// delete from block-local offset A to block-local offset B (offsets into the block's data-text)
async function cutAt(kA, oA, kB, oB) {
  for (const k of [kA, kB, kA]) { await p.evaluate(k => document.querySelector(`[data-block=true][data-block-key="${k}"]`)?.scrollIntoView({ block: 'center' }), k); await wait(500); }
  const sel = await p.evaluate(([kA, oA, kB, oB]) => {
    function pos(key, i) { const nodes = [...document.querySelector(`[data-block=true][data-block-key="${key}"]`).querySelectorAll('[data-text=true]')].map(s => s.firstChild).filter(Boolean); let acc = 0; for (const n of nodes) { if (i <= acc + n.textContent.length) return [n, i - acc]; acc += n.textContent.length; } const n = nodes[nodes.length - 1]; return [n, n.textContent.length]; }
    const [na, a] = pos(kA, oA), [nb, bb] = pos(kB, oB);
    document.querySelector('[aria-label="Project Transcript"]').focus();
    window.getSelection().setBaseAndExtent(na, a, nb, bb); document.dispatchEvent(new Event('selectionchange'));
    return window.getSelection().toString();
  }, [kA, +oA, kB, +oB]);
  await wait(400); await p.keyboard.press('Backspace'); await wait(1500);
  return sel;
}

async function drag(x1, y1, x2, y2) {
  await p.mouse.move(x1, y1); await wait(150); await p.mouse.down(); await wait(300);
  await p.mouse.move(x1 - 8, y1 + 4, { steps: 5 }); await wait(200);
  for (let i = 1; i <= 30; i++) { await p.mouse.move(x1 + (x2 - x1) * i / 30, y1 + (y2 - y1) * i / 30); await wait(20); }
  await wait(500); await p.mouse.up(); await wait(1500);
}
async function selectedTitle() {
  return p.evaluate(() => { for (const e of document.querySelectorAll('div,span')) { const r = e.getBoundingClientRect(); if (r.x > 1270 && r.x < 1300 && r.y > 55 && r.y < 90 && e.children.length === 0) return e.textContent; } });
}
async function field(label, val) {
  const pos = await p.evaluate(l => { for (const e of document.querySelectorAll('div,span,label')) { if (e.children.length === 0 && e.textContent.trim() === l) { const r = e.getBoundingClientRect(); if (r.x > 1235 && r.y > 90) return [r.x + 40, r.y + r.height / 2]; } } return null; }, label);
  if (!pos) throw new Error('no field ' + label);
  await p.mouse.dblclick(pos[0], pos[1]); await p.keyboard.press('Meta+a'); await p.keyboard.type(String(val)); await p.keyboard.press('Enter'); await wait(600);
}

// zoom helpers shared by zoomhook and punch: a Zoom and pan added with the playhead at <clear>, which must sit outside every
// existing zoom, since a zoom added inside another replaces it; key() selects the diamond at <sec> and sets its width centred
const addZoom = async (from, to, easing, clear) => {
    await fit(); await seek(+clear);
    await selectScript(); await heading('Animation');
    await p.getByRole('button', { name: 'Add animation' }).last().click(); await wait(800);
    await p.getByRole('menuitem', { name: 'Zoom and pan' }).first().click(); await wait(1500);
    await p.getByRole('button', { name: 'Animation settings' }).last().click(); await wait(900);
    await timeField('End', to); await timeField('Start', from); await timeField('End', to);
    if (easing) {
      await clickText('Natural', { minX: 1340, last: true }); await wait(700);
      await p.locator('[role=option],[role=menuitem],[role=menuitemradio]').filter({ hasText: new RegExp(`^${easing}$`) }).first().click(); await wait(700);
    }
    const v = await p.evaluate(() => [...document.querySelectorAll('[role=dialog],[data-radix-popper-content-wrapper]')].map(x => [...x.querySelectorAll('input')].map(i => i.value).join(' to ') + ' ' + (x.innerText.match(/Easing\s*\n?\s*(\S+)/) || [])[1]).join(' / '));
    await p.getByRole('button', { name: 'Close panel' }).last().click().catch(() => {}); await wait(500);
    console.log('zoom', from, 'to', to, '|', v);
  };
  // a keyframe is selected when the size fields are editable and underlined; between keyframes they are greyed
const onKey = () => p.evaluate(() => { const lab = [...document.querySelectorAll('div')].find(e => e.children.length === 0 && e.textContent.trim() === 'W' && e.getBoundingClientRect().x > 1235); if (!lab) return false; const ly = lab.getBoundingClientRect().y; const i = [...document.querySelectorAll('input')].find(i => Math.abs(i.getBoundingClientRect().y - ly) < 14 && i.getBoundingClientRect().x > 1235); return !!i && !i.disabled && getComputedStyle(i).textDecorationLine.includes('underline'); });
const key = async (sec, w) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await focus(sec); const y = await zoomKeyframeY();
      await p.mouse.click(r.x0 + sec * r.pps, y); await wait(800); await panel('Properties');
      const now = (await timecode()).now.split(':').reduce((m, x) => m * 60 + +x, 0);
      if (await onKey() && Math.abs(now - sec) < 0.12) {
        // with many zooms the Animation list pushes Size and position off the top of the panel, where field() cannot reach it
      await p.evaluate(() => { const lab = [...document.querySelectorAll('div,span,label')].find(e => e.children.length === 0 && e.textContent.trim() === 'W' && e.getBoundingClientRect().x > 1235); lab?.scrollIntoView({ block: 'center' }); for (const el of [document.scrollingElement, document.body, document.documentElement]) if (el) el.scrollTop = 0; }); await wait(400);
      if (w) { await field('W', w); await field('X', 1080); await field('Y', 1920); }
        return `${await readField('W')} at ${await readField('X')},${await readField('Y')}`;
      }
    }
    await p.screenshot({ path: 'keyfail.png' });
  throw new Error('could not select the keyframe at ' + sec + ' (keyfail.png shows where it looked)');
  };

const commands = {
  // timecode, duration and the transcript, one block a line
  async state() { console.log(await timecode()); for (const [k, t] of await blocks()) console.log(k, JSON.stringify(t.replace(/\s*\u{1F4CD}\s*/gu, " ").trim())); },
  async shot(out = 'shot.png') { await p.screenshot({ path: out }); console.log(out); },
  // the canvas alone, at the given seconds: node descript.mjs frames 2 27.5 54.6
  async frames(...ts) {
    await fit();
    for (const t of ts) {
      await seek(+t); await wait(2000);
      const box = await p.evaluate(() => { const c = [...document.querySelectorAll('canvas')].map(c => c.getBoundingClientRect()).filter(r => r.width > 100 && r.x > 700 && r.y < 600).sort((a, z) => z.width * z.height - a.width * a.height)[0]; return c && { x: c.x, y: c.y, width: c.width, height: c.height }; });
      await p.screenshot({ path: `frame-${t}.png`, clip: box }); console.log(`frame-${t}.png`, (await timecode()).now);
    }
  },
  // delete transcript text from a point in block A to a point in block B.
  // node descript.mjs cut <keyA> "<textA>" before|after <keyB> "<textB>" before|after [--dry]
  // "^" and "$" mean the start and end of a block. Blocks off screen render as skeletons, so each is scrolled into view first.
  async cut(kA, sA, mA, kB, sB, mB, dry) {
    for (const k of [kA, kB, kA]) { await p.evaluate(k => document.querySelector(`[data-block=true][data-block-key="${k}"]`)?.scrollIntoView({ block: 'center' }), k); await wait(600); }
    const sel = await p.evaluate(([kA, sA, mA, kB, sB, mB]) => {
      function pos(key, str, mode) {
        const blk = document.querySelector(`[data-block=true][data-block-key="${key}"]`);
        const nodes = [...blk.querySelectorAll('[data-text=true]')].map(s => s.firstChild).filter(Boolean);
        const full = nodes.map(n => n.textContent).join('');
        let i = str === '^' ? 0 : str === '$' ? full.length : full.indexOf(str);
        if (i < 0) throw new Error(`"${str}" not in ${key}`);
        if (mode === 'after' && str !== '^' && str !== '$') i += str.length;
        let acc = 0; for (const n of nodes) { if (i <= acc + n.textContent.length) return [n, i - acc]; acc += n.textContent.length; }
      }
      const [na, oa] = pos(kA, sA, mA), [nb, ob] = pos(kB, sB, mB);
      document.querySelector('[aria-label="Project Transcript"]').focus();
      window.getSelection().setBaseAndExtent(na, oa, nb, ob);
      document.dispatchEvent(new Event('selectionchange'));
      return window.getSelection().toString();
    }, [kA, sA, mA, kB, sB, mB]);
    console.log('selected', JSON.stringify(sel), (await timecode()).total);
    if (dry === '--dry') return;
    await wait(400); await p.keyboard.press('Backspace'); await wait(1500);
    console.log('after', (await timecode()).total);
  },
  // list every silence gap; with --delete, remove each one of at least <min> seconds.
  // Fits the whole timeline on screen first, because gaps off screen are not in the page and get missed.
  // --skip 10.12[,8.6] keeps the named gaps, for a stretch after the last transcribed line that may hold an unheard
  // take (the sign-off), which the skill says is kept and flagged rather than cut (279, 19 Oct 2026)
  async gaps(min = '1', del, skipFlag, skipVals) {
    await fit();
    console.log('gaps', JSON.stringify((await gaps()).map(g => g.s)));
    if (del !== '--delete') return;
    const keep = skipFlag === '--skip' && skipVals ? skipVals.split(',').map(Number) : [];
    // a chip can hold words whose timing Descript has stretched over the pause (the trailer, 16 Oct 2026: a cut inside
    // "start this completely for free" left "for free" spread over 4.7s, and deleting the chip took the words), so the
    // words are read before and after, and a deletion that took any is undone with the Undo button and skipped
    // compared without punctuation, since a delete can re-render "'Cause" as "' Cause" and lose nothing (273)
    const words = async () => (await blocks()).map(b => b[1]).join(' ').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    // a gap that held words is skipped by its place in the order, not its length, since two gaps can share a length
    // (273, two of 13.8s, 22 Oct 2026), and the words it took are printed
    const skipN = [];
    for (let i = 0; i < 60; i++) {
      const all = (await gaps()).filter(g => !keep.includes(g.s));
      const n = all.findIndex((g, k) => g.s >= +min && !skipN.includes(k));
      if (n < 0) break;
      const g = all[n];
      const before = await words();
      await p.mouse.click(g.x, g.y); await wait(400); await p.keyboard.press('Backspace'); await wait(1200);
      const after = await words();
      if (after !== before) {
        const A = before.split(' '), B = after.split(' '); let a = 0, z = 0;
        while (a < A.length && A[a] === B[a]) a++;
        while (z < A.length - a && z < B.length - a && A[A.length - 1 - z] === B[B.length - 1 - z]) z++;
        await p.evaluate(() => document.activeElement?.blur()); await p.locator('button[aria-label^="Undo"]').first().click(); await wait(2200);
        console.log('NOT a pause, it held words; undone', g.s, (await words()) === before ? 'restored' : 'CHECK THE TRANSCRIPT', '| took', JSON.stringify(A.slice(a, A.length - z).join(' ')), 'left', JSON.stringify(B.slice(a, B.length - z).join(' ')));
        skipN.push(n); await fit(); continue;
      }
      console.log('deleted', g.s, '->', (await timecode()).total);
      await fit();
    }
    console.log('left', JSON.stringify((await gaps()).map(g => g.s)));
  },
  // trim a clip's end to <sec>, the cover image's 5.0s: coarse with the whole reel on screen, then fine zoomed in, the
  // same two passes the text cover uses. An image dropped from Overlays comes in as long as the whole reel (257)
  async trim(id, sec) {
    const end = +sec;
    const box = async () => (await clips()).find(c => c.id === id);
    let r = await fit(); let c = await box();
    if (!c) { console.log('no clip', id, 'on screen'); return; }
    await p.mouse.click(c.x + 15, c.y + 10); await wait(500);
    if (c.x + c.w - (r.x0 + end * r.pps) > 3) { await drag(c.x + c.w - 2, c.y + 10, r.x0 + end * r.pps, c.y + 10); }
    r = await focus(end); c = await box();
    if (c && Math.abs(c.x + c.w - (r.x0 + end * r.pps)) > 1) { await p.mouse.click(Math.max(c.x, 20) + 15, c.y + 10); await wait(500); c = await box(); await drag(c.x + c.w - 2, c.y + 10, r.x0 + end * r.pps, c.y + 10); }
    c = await box(); r = await ruler();
    console.log('clip ends at', c ? ((c.x + c.w - r.x0) / r.pps).toFixed(2) : '?', 's');
  },
  // the short pauses inside lines ("British English or ... are there"): zoomed out to fit, Descript draws no chip for a
  // gap under about a second, so `gaps` never sees them. This zooms in until they render, walks the timeline a screen at
  // a time and lists (or with --delete removes) every gap of at least <min> seconds and under 3, skipping the wide
  // placeholder rows Descript lays over parts of the word bar it has not drawn, which carry long times and are not gaps.
  // --skip 2.86 keeps the gaps of the lengths listed, as `gaps` does, for a kept tail under 3s (266, 20 Oct 2026)
  async shortgaps(min = '0.2', ...rest) {
    const del = rest.includes('--delete') ? '--delete' : undefined;
    const ki = rest.indexOf('--skip'); const keepLens = ki >= 0 ? String(rest[ki + 1]).split(',').map(Number) : [];
    const kept = (g) => keepLens.some(k => Math.abs(k - g.s) < 0.005);
    const total = () => timecode().then(t => t.total.split(':').reduce((a, x) => a * 60 + +x, 0));
    // in until a short gap draws as its own chip, about 150 pixels a second, but no further than the ruler can be read
    // (past that its labels go to 0:02.25 and the seconds-to-pixels reading is lost)
    await fit();
    for (let i = 0; i < 12; i++) { const r = await ruler(); if (r && r.pps >= 150) break; await zoom('in', 1); if (!(await ruler())) { await zoom('out', 1); break; } }
    await toStart();
    const onScreen = () => p.evaluate(() => [...document.querySelectorAll('.Wordbar__FullGap')].map(e => { const r = e.getBoundingClientRect(); return { s: parseFloat(e.querySelector('.Wordbar__FullGap__TimeIndicator')?.textContent), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, l: r.x }; }));
    const found = []; const skip = []; let removed = 0;
    for (let step = 0; step < 80; step++) {
      for (let i = 0; i < 40; i++) {
        const r0 = await ruler(); const g = (await onScreen()).find(g => g.s >= +min && g.s < 3 && !kept(g) && g.w < 600 && g.l > 15 && g.l + g.w < 1215 && !(r0 && skip.some(t => Math.abs(t - (g.x - r0.x0) / r0.pps) < 0.1)));
        if (!g) break;
        const r = await ruler(); const at = r ? +((g.x - r.x0) / r.pps).toFixed(1) : null;
        // a chip can also hold speech while the words stay in the transcript: Descript squeezed "So if you haven't used
        // plan mode before, give it a try" into 1.2s either side of a 1.05s "pause" that was the rest of the line, and the
        // delete clipped the line (277, 16 Oct 2026). So the words in the 1.5s either side are read for pace, and a chip
        // beside words running faster than anyone speaks (7.5 a second over four or more) is left alone
        const pace = r && await p.evaluate(({ l, z, pps }) => {
          const ws = [...document.querySelectorAll('.Wordbar__Word')].map(e => { const b = e.getBoundingClientRect(); return { a: b.x, z: b.x + b.width, n: (e.innerText || '').trim().split(/\s+/).filter(Boolean).length }; }).filter(w => w.n);
          const side = (sel, span) => { const n = sel.reduce((s, w) => s + w.n, 0); return n >= 4 && span > 0 ? n / (span / pps) : 0; };
          const pre = ws.filter(w => w.z <= l + 2 && w.z >= l - 1.5 * pps), post = ws.filter(w => w.a >= z - 2 && w.a <= z + 1.5 * pps);
          return Math.max(side(pre, l - Math.min(...pre.map(w => w.a))), side(post, Math.max(...post.map(w => w.z)) - z));
        }, { l: g.l, z: g.l + g.w, pps: r.pps });
        if (pace > 7.5) {
          if (!skip.includes(at)) console.log('NOT a pause, the words beside it run at', pace.toFixed(1), 'a second, so it holds speech; left', g.s, 'at', at);
          skip.push(at); continue;
        }
        if (del !== '--delete') { if (!found.some(f => Math.abs(f[0] - at) < 0.05)) found.push([at, g.s]); break; }
        // a chip can stand for a word Descript has lost the timing of (a corrected word, 257: "claude.md" went as a
        // 0.73s gap), so the words are read before and after, and a deletion that took any is undone and skipped
        const words = async () => (await blocks()).map(b => b[1]).join(' ').replace(/\s+/g, ' ').trim();
        const before = await words();
        await p.mouse.click(g.x, g.y); await wait(400); await p.keyboard.press('Backspace'); await wait(1000);
        if ((await words()) !== before) {
          await p.evaluate(() => document.activeElement?.blur()); await p.keyboard.press('Meta+z'); await wait(2000);
          console.log('NOT a pause, it held words; undone', g.s, 'at', at, (await words()) === before ? 'restored' : 'CHECK THE TRANSCRIPT');
          skip.push(at); continue;
        }
        removed++; console.log('deleted', g.s, 'at', at, '->', (await timecode()).total);
      }
      if (del !== '--delete') { for (const g of await onScreen()) if (g.s >= +min && g.s < 3 && !kept(g) && g.w < 600 && g.l > 15 && g.l + g.w < 1215) { const r = await ruler(); const at = +((g.x - r.x0) / r.pps).toFixed(1); if (!skip.some(t => Math.abs(t - at) < 0.1) && !found.some(f => Math.abs(f[0] - at) < 0.05)) found.push([at, g.s]); } }
      const r = await ruler(); if (!r || (1215 - r.x0) / r.pps >= await total()) break;
      await unscrollPage(); await p.mouse.move(600, r.y + 60); await p.mouse.wheel(900, 0); await wait(500);
    }
    if (del === '--delete') console.log('removed', removed, 'total', (await timecode()).total);
    else console.log('short gaps', JSON.stringify(found));
  },
  // start and length of each script segment (one per transcript block), for the card and click times
  async segments() {
    await fit();
    const d = await p.evaluate(() => [...document.querySelectorAll('.TimelineTau[data-duration]')].map(e => parseFloat(e.getAttribute('data-duration'))));
    const bl = await blocks(); let acc = 0;
    d.forEach((s, i) => { console.log(acc.toFixed(2), `+${s}`, (bl[i]?.[1] || '').replace(/\s*\u{1F4CD}\s*/gu, ' ').trim().slice(0, 60)); acc += s; });
    console.log('total', acc.toFixed(2));
  },
  // where a clip starts, measured zoomed in (read only): node descript.mjs measure <clipId> [roughly where, in seconds]
  // a short clip (a click) does not render zoomed out, so give it the rough time
  async measure(id, near) { console.log(id, 'starts at', (await measure(id, near)).toFixed(3), 's'); },
  // every word's start in the cut, read from the timeline's word bar zoomed in, where each word is drawn at its own
  // place (read only): node descript.mjs words [zoom steps, 3 by default, where a pixel is about 10ms; at 5 the ruler shows too few labels to read]. The SRT only gives a caption's start, and a card that should
  // come in on its words came in early on 289 (Oli, 22 Oct 2026), so a card's start is taken from here
  async words(steps = '3') {
    const total = (await timecode()).total.split(':').reduce((a, x) => a * 60 + +x, 0);
    await fit(); await zoom('in', +steps); await toStart();
    const seen = new Map();
    for (let i = 0; i < 400; i++) {
      let r = await ruler();
      // a scroll can leave the page itself scrolled, which hides the ruler's labels for a moment
      for (let k = 0; !r && k < 4; k++) { await unscrollPage(); await wait(600); r = await ruler(); }
      if (!r) { console.log('lost the ruler near', [...seen.keys()].pop(), 's; run again'); break; }
      const ws = await p.evaluate(() => [...document.querySelectorAll('.Wordbar__Word')].map(e => [e.textContent.trim(), e.getBoundingClientRect().x]).filter(([t, x]) => t && x > 0 && x < 1230));
      for (const [t, x] of ws) { const s = (x - r.x0) / r.pps; if (s >= 0) seen.set(s.toFixed(2), t); }
      if (r.x0 + total * r.pps < 1230) break;
      await p.mouse.move(600, r.y + 60); await p.mouse.wheel(900, 0); await wait(500);
    }
    for (const [s, t] of [...seen].sort((a, c) => +a[0] - +c[0])) console.log(`${s}\t${t}`);
  },
  async fit() { console.log(await fit()); },
  // reload the editor, for a stale page: a frozen seek after drop or place (255), or a connector upload that stays greyed in
  // Files and will not drop until the page fetches it again (273's 690MB overlay, 22 Oct 2026). Descript has saved by then
  async reload() { await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForSelector('[aria-label="Project Transcript"]', { timeout: 60000 }); await wait(5000); console.log(await timecode()); },
  async zoom(dir, n = '1') { await zoom(dir, +n); console.log(await ruler()); },
  async seek(sec) { await fit(); console.log(await seek(+sec)); },
  async clips() { for (const c of await clips()) console.log(JSON.stringify(c)); },
  // drag a file or stock item (by its visible name in the open side panel) onto the canvas or the timeline.
  // Overlays dropped on the canvas land at 0 whatever the playhead; move them with `move` afterwards.
  async drop(name, x = '968', y = '330') {
    // the cards sit in the project's Overlays folder; placing a card leaves the Properties panel open
    await panel('Project');
    // a folder opens from the arrow left of its name, not the name; after a connector upload it shows collapsed
    // a collapsed folder keeps its files in the page, hidden, so the test is visibility, not presence (253, 7 Oct 2026)
    if (!(await p.getByText(name, { exact: true }).first().isVisible().catch(() => false))) {
      const f = await p.getByText('Overlays', { exact: true }).first().boundingBox();
      if (f) { await p.mouse.click(f.x - 18, f.y + f.height / 2); await wait(1200); }
    }
    if (!(await p.getByText(name, { exact: true }).count())) { console.log('not in the Overlays folder:', name); return; }
    const r = await p.getByText(name, { exact: true }).first().boundingBox();
    // only clips drawn on screen are in the page, so both lists are taken with the whole timeline fitted;
    // zoomed in, a card scrolled out of view reads as new and the next move takes the wrong one (249, 5 Oct 2026)
    await fit(); const before = new Set((await clips()).map(c => c.id));
    await drag(r.x + r.width / 2, r.y + r.height / 2, +x, +y); await wait(6000);
    await fit(); const added = (await clips()).filter(c => !before.has(c.id));
    if (added.length !== 1) console.log('WARNING: expected one new clip, found', added.length);
    console.log('added', JSON.stringify(added));
  },
  // move a clip so it starts at <seconds>, measured against the ruler; refuses a clip hidden under the script track
  async move(id, sec) {
    // coarse move zoomed out, when the clip is long enough to render there (cards are; clicks are not)
    await fit();
    let r = await ruler();
    if (await findClip(id)) {
      const c = await safeBox(id); r = await ruler();
      await drag(c.x + Math.min(20, c.width / 2), c.y + 12, c.x + Math.min(20, c.width / 2) + (r.x0 + +sec * r.pps + 2 - c.x), c.y + 12);
    }
    // fine move zoomed in, with the target in the middle of the screen
    await zoom('in', 4); await toStart();
    r = await ruler();
    await p.mouse.move(600, r.y + 60); await p.mouse.wheel(r.x0 + +sec * r.pps - 600, 0); await wait(500);
    let c = await safeBox(id); r = await ruler();
    const t2 = r.x0 + +sec * r.pps + 2;
    if (Math.abs(c.x - t2) > 0.5) await drag(c.x + Math.min(20, c.width / 2), c.y + 12, c.x + Math.min(20, c.width / 2) + (t2 - c.x), c.y + 12);
    c = await safeBox(id); r = await ruler(); console.log('starts at', ((c.x - 2 - r.x0) / r.pps).toFixed(3), 's', (await timecode()).total);
  },
  // line clip A's start up with clip B's (a click with its card): node descript.mjs align <clickId> <cardId>
  async align(a, bId) {
    const sec = await measure(bId); console.log('card starts at', sec.toFixed(3));
    await commands.move(a, sec.toFixed(3));
  },
  // size and place the selected layer: node descript.mjs place <clipId> 1400 1080 3020  (W, centre X, centre Y)
  // move the captions up or down without reapplying the preset
  async capy(y) {
    // picked from the Layers list, never the track: with the caption track below the timeline's fold the click took
    // the Script and moved the whole video down (287, 21 Oct 2026)
    await selectLayer('Bold: Two words'); await field('Y', +y);
    console.log('captions', JSON.stringify({ W: await readField('W'), H: await readField('H'), X: await readField('X'), Y: await readField('Y') }));
  },
  // move a layer picked by its name in the Layers list: node descript.mjs layery Script 1920
  async layery(name, y) {
    if (name === 'Script') await selectScript(); else await selectLayer(name);
    await field('Y', +y); console.log(await selectedTitle(), 'Y', await readField('Y'));
  },
  async place(id, w, x, y) {
    const c = await safeBox(id); await p.mouse.click(c.x + c.width / 2, c.y + 12); await wait(600);
    await panel('Properties');
    console.log('layer', await selectedTitle());
    await field('W', w); await field('X', x); await field('Y', y);
    await p.screenshot({ path: 'place.png', clip: { x: 1230, y: 50, width: 370, height: 600 } }); console.log('place.png');
  },
  // set a clip's volume and read it back: node descript.mjs vol <clipId> 50
  async vol(id, pct) {
    const c = await safeBox(id); await p.mouse.click(c.x + c.width / 2, c.y + 12); await wait(600);
    await panel('Properties');
    const pos = await p.evaluate(() => { for (const e of document.querySelectorAll('div,span')) { if (e.children.length === 0 && e.textContent.trim() === 'Audio') { const r = e.getBoundingClientRect(); if (r.x > 1235) return [r.x + 30, r.y + 40]; } } });
    await p.mouse.dblclick(pos[0], pos[1]); await p.keyboard.press('Meta+a'); await p.keyboard.type(pct); await p.keyboard.press('Enter'); await wait(700);
    const v = await p.evaluate(() => [...document.querySelectorAll('input')].filter(i => i.getBoundingClientRect().x > 1235).map(i => i.value));
    console.log(await selectedTitle(), 'inputs', v.join('|'));
  },
  async panel(name) { await panel(name); console.log('open', name); },

  // remove a layer this skill added and is replacing: a clip by id (give a rough time for a click) or a text layer by its label
  async remove(what, near) {
    let x, y;
    if (/^[0-9a-f]{8}-/.test(what)) { if (near !== undefined) await focus(+near); else await fit(); const c = await safeBox(what); x = c.x + Math.min(10, c.width / 2); y = c.y + 12; }
    // a layer by its name is right-clicked on its row in the Layers list, which carries Delete for every kind of layer; the
    // timeline's own right-click at a name's track opened the scene menu, which has none, on 273's image cover (23 Oct 2026)
    else {
      await fit();
      const r = await p.evaluate(n => { const e = [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && e.textContent.trim() === n && e.getBoundingClientRect().x > 1235); if (!e) return null; e.scrollIntoView({ block: 'center' }); for (const el of [document.scrollingElement, document.body, document.documentElement]) if (el) el.scrollTop = 0; const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; }, what);
      if (r) { x = r.x; y = r.y; }
      else { const t = await textTrack(what); if (!t) { console.log('no layer', what); return; } x = t.x + 10; y = t.y + t.h / 2; }
    }
    await p.mouse.click(x, y, { button: 'right' }); await wait(800);
    await p.getByRole('menuitem', { name: 'Delete' }).first().click(); await wait(1000);
    console.log('removed', what, (await timecode()).total);
  },
  // remove every Zoom and pan on the Script layer (to redo the hook zoom)
  async unzoom() {
    await selectScript();
    for (let i = 0; i < 6; i++) {
      const h = await heading('Animation');
      const rows = await p.evaluate(y => [...document.querySelectorAll('div,span')].filter(e => e.children.length === 0 && e.textContent.trim() === 'Zoom and pan' && e.getBoundingClientRect().y > y && e.getBoundingClientRect().x > 1235).map(e => e.getBoundingClientRect().y), h.y);
      if (!rows.length) break;
      await p.getByRole('button', { name: 'Remove animation' }).first().click(); await wait(900);
    }
    const h = await heading('Animation');
    const left = await p.evaluate(y => [...document.querySelectorAll('div,span')].filter(e => e.children.length === 0 && e.textContent.trim() === 'Zoom and pan' && e.getBoundingClientRect().y > y && e.getBoundingClientRect().x > 1235).length, h.y);
    console.log('zooms left', left);
  },
  // read-only health check before touching a project: timecode, ruler, transcript, controls
  async selftest() {
    const tc = await timecode(); const total = tc.total.split(':').reduce((a, x) => a * 60 + +x, 0);
    const r = await fit(); const bl = await blocks();
    const btns = await p.evaluate(() => ['Zoom In', 'Zoom Out'].map(n => !!document.querySelector(`[aria-label="${n}"]`)));
    const rail = await p.evaluate(() => ['Project', 'Properties', 'Elements', 'Captions', 'Media'].map(n => [...document.querySelectorAll('div,button')].some(e => e.textContent.trim() === n && e.getBoundingClientRect().x > 1515)));
    const ok = total > 0 && r && r.pps > 0 && bl.length > 0 && btns.every(Boolean) && rail.every(Boolean);
    console.log(ok ? 'OK' : 'FAIL', JSON.stringify({ total, pps: r && +r.pps.toFixed(2), blocks: bl.length, zoomButtons: btns, rail }));
  },
  // compare the transcript with the script's rows and propose the cuts that leave only the last full take of each row.
  // node descript.mjs plan <script.md> "<heading text>" [--apply]
  async plan(file, head, apply) {
    const rows = scriptRows(file, head).map(tok);
    const bl = await fullTranscript();
    const T = []; bl.forEach(([k, t]) => tok(t).forEach(x => T.push({ ...x, k })));
    // a row matches where its first words start and the words that follow share most of the row (script rows are close to, not exactly, what was said)
    const { cuts, log } = planCuts(rows, T); log.forEach(l => console.log(l)); if (cuts === null) return;
    if (!cuts.length) { console.log('no cuts: the transcript is the script'); return; }
    cuts.forEach(([a, z], i) => console.log(`cut ${i + 1}: "${T.slice(a, z).map(x => x.w).join(' ').slice(0, 140)}"`));
    if (apply !== '--apply') { console.log('dry run; add --apply to make these cuts'); return; }
    for (const [a, z] of cuts.reverse()) {
      const A = T[a], Z = T[z];
      const kB = Z ? Z.k : bl[bl.length - 1][0], oB = Z ? Z.s : bl[bl.length - 1][1].length;
      await cutAt(A.k, A.s, kB, oB);
      console.log('cut ->', (await timecode()).total);
    }
  },
  // apply "Bold: Two words" and size it to one row: W 600, H 130, centre 1080, 2480, just under the chin (Oli, 6 Oct 2026; 2300 sat over his mouth)
  // `captions --size` sizes captions already on, for a run that added them and stopped before sizing (259)
  async captions(size) {
    if (await textTrack('Bold: Two words') && size !== '--size') { console.log('captions already on; leaving them'); return; }
    if (!(await textTrack('Bold: Two words'))) {
    await panel('Captions');
    await p.locator('input[placeholder="Search captions"]').fill('Bold'); await wait(1200);
    // the preset applies from its preview tile, which sits just above its name
    const lab = await p.evaluate(() => { const e = [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && e.textContent.trim() === 'Bold: Two words' && e.getBoundingClientRect().x > 1235); e.scrollIntoView({ block: 'center' }); for (const el of [document.scrollingElement, document.body, document.documentElement]) if (el) el.scrollTop = 0; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    await wait(400); await p.mouse.click(1372, lab.y - 45);
    }
    // the track can take well over three seconds to appear on a long take (259), so it is waited for
    let t = null; for (let i = 0; i < 20 && !t; i++) { await wait(1000); t = await textTrack('Bold: Two words'); }
    if (!t) throw new Error('captions not added');
    await p.mouse.click(t.x + 40, t.y + t.h / 2); await wait(600);
    await panel('Properties');
    // a caption track below the timeline's fold is not selected by that click and the panel shows the scene (264), so
    // the layer is picked from the Layers list instead
    if ((await readField('W')) === null) {
      const row = await p.evaluate(() => { const e = [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && e.textContent.trim() === 'Bold: Two words' && e.getBoundingClientRect().x > 1235); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
      if (row) { await p.mouse.click(row[0], row[1]); await wait(1200); }
    }
    await field('W', 600); await field('H', 130);
    if ((await readField('W')) !== '600') { // aspect locked: unlock and set again
      const h = await heading('Size and position'); await p.mouse.click(1487, h.y + 80); await wait(400);
      await field('W', 600); await field('H', 130);
    }
    if ((await readField('W')) !== '600') { // after the unlock a double click left W at 93 (253, 7 Oct 2026); a single click on the input itself takes
      const i = await p.evaluate(() => { const e = [...document.querySelectorAll('input')].filter(i => i.getBoundingClientRect().x > 1235)[3]; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
      await p.mouse.click(i[0], i[1]); await p.keyboard.press('Meta+a'); await p.keyboard.type('600'); await p.keyboard.press('Enter'); await wait(800);
    }
    await field('X', 1080); await field('Y', 2480);
    console.log('captions', JSON.stringify({ W: await readField('W'), H: await readField('H'), X: await readField('X'), Y: await readField('Y') }));
  },
  // the cover line as a text layer, 0 to 5s: Lato Bold 120, W 1800, centre 1080, 900, shadow on
  // a line that wraps to three rows at 1800 takes a wider box: cover "<line>" 1960
  async cover(line, w = 1800) {
    await fit(); await seek(0);
    if (!(await textTrack(line.slice(0, 12)))) {
    await panel('Elements');
    // "Text" is both the section heading and the first tile; the tile is the lower one
    const tile = await p.evaluate(() => { const t = [...document.querySelectorAll('div,span')].filter(e => e.children.length === 0 && e.textContent.trim() === 'Text' && e.getBoundingClientRect().x > 1235).map(e => e.getBoundingClientRect()).sort((a, z) => a.y - z.y); const r = t[1] || t[0]; return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const before = (await p.evaluate(() => document.querySelectorAll('[data-testid="timeline-track"]').length));
    await p.mouse.click(tile.x, tile.y); await wait(1500);
    if ((await p.evaluate(() => document.querySelectorAll('[data-testid="timeline-track"]').length)) <= before) throw new Error('no text layer was added');
    const box = await p.evaluate(() => { const c = [...document.querySelectorAll('canvas')].map(c => c.getBoundingClientRect()).filter(r => r.width > 100 && r.x > 700 && r.y < 600).sort((a, z) => z.width * z.height - a.width * a.height)[0]; return { x: c.x + c.width / 2, y: c.y + c.height / 2 }; });
    await p.mouse.dblclick(box.x, box.y); await wait(700);
    const editing = await p.evaluate(() => { const a = document.activeElement; return a && a.isContentEditable && a.getAttribute('aria-label') !== 'Project Transcript'; });
    if (!editing) throw new Error('could not edit the new text layer');
    await p.keyboard.press('Meta+a'); await p.keyboard.insertText(line); await wait(400);
    }
    await selectLayer(line);
    // the Text section: font (Lato is the default), weight dropdown, Size field
    const tx = await heading('Text');
    const fontName = await p.evaluate(y => [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && e.getBoundingClientRect().x > 1235 && Math.abs(e.getBoundingClientRect().y - y - 40) < 15)?.textContent.trim(), tx.y);
    if (fontName !== 'Lato') { await p.mouse.click(1440, tx.y + 40); await wait(600); await p.keyboard.type('Lato'); await wait(900); await clickText('Lato', { minX: 1235, last: true }); await wait(800); }
    await p.mouse.click(1340, tx.y + 80); await wait(700);
    const opt = p.getByRole('option', { name: 'Bold', exact: true });
    if (await opt.count()) await opt.first().click(); else await clickText('Bold', { minX: 1235 });
    await wait(700);
    await field('Size', 120);
    // width is locked in auto-width mode; the middle of the three mode buttons is fixed width
    const sp = await heading('Size and position'); await p.mouse.click(1410, sp.y + 120); await wait(600);
    await field('W', +w); await field('X', 1080); await field('Y', 900);
    // shadow on, read from the switch so a rerun does not toggle it back off
    await clickText('Effects', { minX: 700 });
    const sw = p.locator('[data-testid="effect-row-shadow"] [role="switch"]:visible').first();
    if ((await sw.getAttribute('aria-checked')) !== 'true') { await sw.click(); await wait(600); }
    console.log('shadow', await sw.getAttribute('aria-checked'));
    await p.keyboard.press('Escape'); await wait(400);
    // trim to 5.0s: coarse with the whole layer on screen, then fine zoomed in
    const L = line.slice(0, 12);
    // a track's edge only drags once the track is selected
    const pick = async t => { await p.mouse.click(Math.max(t.x, 20) + 15, t.y + t.h / 2); await wait(500); };
    let r = await fit(); let t = await textTrack(L);
    if (t.x + t.w - (r.x0 + 5 * r.pps) > 3) { await pick(t); await drag(t.x + t.w - 2, t.y + t.h / 2, r.x0 + 5 * r.pps, t.y + t.h / 2); }
    r = await focus(5); t = await textTrack(L);
    if (Math.abs(t.x + t.w - (r.x0 + 5 * r.pps)) > 1) { await pick(t); t = await textTrack(L); await drag(t.x + t.w - 2, t.y + t.h / 2, r.x0 + 5 * r.pps, t.y + t.h / 2); }
    t = await textTrack(L); r = await ruler();
    await selectLayer(line);
    console.log('cover ends at', ((t.x + t.w - r.x0) / r.pps).toFixed(2), 's; size', await readField('Size'), 'W', await readField('W'), 'Y', await readField('Y'));
  },
  // the hook zoom: 100 to 110% from 0 to <end>, back to 100% at <next> (the start of row 2)
  async zoomhook(end, next) {
    // the slow push in over row 1: 100% at 0 to 110% at the end of row 1 with no easing, then back to 100% over 0.1s
    // as row 2 starts. Each Zoom and pan has its own Start and End (Animation settings) and two keyframe diamonds; a new
    // zoom's end diamond comes up at Descript's default, about 140% and off centre, and a zoom added with the playhead
    // inside another replaces it, so the reset is added with the playhead clear and all four diamonds are set (249, 5 Oct 2026)
    // Start and End are typed to a tenth of a second, so every time is rounded first and the diamonds are clicked where
    // they really sit; a click that misses a diamond leaves the last keyframe selected and edits that one instead
    next = Math.round(+next * 10) / 10; end = Math.floor(+end * 10) / 10;
    if (next - end < 0.2) { end = Math.round((next - 0.2) * 10) / 10; console.log('rows abut; zoom ends at', end); }
    await commands.unzoom();
    const back = Math.round((next + 0.1) * 10) / 10;
    await addZoom(0, end, 'None', next + 1.5);
    await addZoom(next, back, undefined, next + 1.5);
    for (const [sec, w] of [[0, 2160], [end, 2376], [next, 2376], [back, 2160]]) console.log('key', sec, await key(sec, w));
    for (const sec of [0, end, next, back]) console.log('read back', sec, await key(sec));
  },
  // the punch in and out (finish-reel step 6b): a three-frame snap to tight at <at> and back to full frame at <out>, each a Zoom
  // and pan 0.1s long (Descript's shortest) from one width to the other, held between; 2484 is 115 percent of 2160, right for
  // footage shot close (259, 11 Oct 2026, read 100, 115, 115, 100 with zoomat). Never unzooms, so it runs after zoomhook,
  // once per TIGHT row: node descript.mjs punch <at> <out> [width]
  async punch(at, out, w = '2484') {
    at = Math.round(+at * 10) / 10; out = Math.round(+out * 10) / 10;
    const a2 = Math.round((at + 0.1) * 10) / 10, o2 = Math.round((out + 0.1) * 10) / 10;
    if (out - at < 0.5) { console.log('row too short to punch'); return; }
    // each zoom is added with the playhead just after it, inside the same paragraph clip of the script, not midway: on 259 a
    // zoom out added from the middle of a row that crossed a paragraph boundary held at 196 percent and its diamonds could not
    // be selected, and had to be deleted from the Animation list (11 Oct 2026)
    await addZoom(at, a2, 'None', a2 + 0.3);
    await addZoom(out, o2, 'None', o2 + 0.3);
    for (const [sec, ww] of [[at, 2160], [a2, +w], [out, +w], [o2, 2160]]) console.log('key', sec, await key(sec, ww));
    for (const sec of [at, a2, out, o2]) console.log('read back', sec, await key(sec));
  },
  // one 0.1s zoom step from <fromW> to <toW> at <sec>, added from just after it: node descript.mjs zoomstep <sec> <fromW> <toW>;
  // the way a punch's in or out is redone alone. Keep <sec> clear of a paragraph clip's edge by a quarter second or more,
  // because a click on a diamond sitting on the edge grabs the clip instead (259, 57.6 against an edge at 57.72)
  async zoomstep(sec, fromW, toW) {
    sec = Math.round(+sec * 10) / 10; const s2 = Math.round((sec + 0.1) * 10) / 10;
    await addZoom(sec, s2, 'None', s2 + 0.3);
    for (const [t, ww] of [[sec, +fromW], [s2, +toW]]) console.log('key', t, await key(t, ww));
  },
  // set one zoom keyframe's width, centred, or read it with no width: node descript.mjs zkey <sec> [width]; the repair when a
  // punch or zoomhook run stops partway and leaves a diamond at Descript's default of about 140 percent off centre
  async zkey(sec, w) { await fit(); await selectScript(); console.log('key', +sec, await key(+sec, w === undefined ? undefined : +w)); },
  // a Click Match at 50% on each card's first frame: node descript.mjs clicks <cardId> [<cardId> ...]
  async clicks(...cards) {
    for (const card of cards) {
      const sec = await measure(card);
      await panel('Media'); await clickText('Stock', { minX: 1235 }).catch(() => {});
      const au = p.locator('[data-testid="media-pane-audio-tab"]');
      if ((await au.getAttribute('aria-checked')) !== 'true') { await au.click(); await wait(800); }
      const s = p.locator('input[placeholder="Search stock media"]'); await s.fill(''); await s.fill('Click Match'); await s.press('Enter'); await wait(2500);
      const r = await focus(sec); const c = await safeBox(card);
      const before = new Set((await clips()).map(x => x.id));
      const it = await p.evaluate(() => { const e = [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && e.textContent.trim() === 'Click Match' && e.getBoundingClientRect().x > 1235); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      if (!it) { console.log('Click Match not in the stock results'); return; }
      await drag(it.x + it.width / 2, it.y + it.height / 2, c.x + 6, c.y + c.height + 20); await wait(6000);
      const added = (await clips()).filter(x => !before.has(x.id));
      if (added.length !== 1) { console.log('expected one new clip, got', JSON.stringify(added)); return; }
      const id = added[0].id;
      await commands.move(id, sec.toFixed(3));
      await commands.vol(id, '50');
      const t = await selectedTitle(); if (!String(t).startsWith('Click Mat')) { console.log('WRONG SOUND added:', t, id); return; }
      console.log('card', card, 'at', sec.toFixed(3), 'click', id);
    }
  },
  // fix a word's spelling in the transcript, which changes the caption and not the audio: correct judgment judgement
  // the Correct button is on the toolbar a mouse drag brings up; a double-click selection shows none, and typing over a
  // selection opens Regenerate, the paid AI voice, so nothing is ever typed into the script itself.
  // A block key from `transcript` as the third argument picks the paragraph, for a word that also sits in an earlier one
  // ("than" in "rather than" before "than the methods", 278) or a paragraph off screen, which renders as a skeleton
  async correct(from, to, key) {
    if (key) { await p.evaluate(k => document.querySelector(`[data-block=true][data-block-key="${k}"]`)?.scrollIntoView({ block: 'center' }), key); await wait(800); }
    // scroll once, then measure without scrolling again, or the drag lands mid-scroll on the next paragraph (258)
    const find = scroll => p.evaluate(([w, scroll, key]) => {
      const blk = [...document.querySelectorAll('[aria-label="Project Transcript"] [data-block=true]')].find(b => (!key || b.dataset.blockKey === key) && b.innerText.includes(w));
      if (!blk) return null;
      if (scroll) blk.scrollIntoView({ block: 'center' });
      for (const s of blk.querySelectorAll('[data-text=true]')) { const n = s.firstChild, i = n?.textContent.indexOf(w) ?? -1; if (i >= 0) {
        const rg = document.createRange(); rg.setStart(n, i); rg.setEnd(n, i + w.length); const r = rg.getBoundingClientRect();
        return { x1: r.x + 1, x2: r.x + r.width - 1, y: r.y + r.height / 2 }; } }
    }, [from, scroll, key]);
    if (!(await find(true))) { console.log(`"${from}" not in the transcript`); return; }
    await wait(1200); let r = await find(false);
    // a selection left from an earlier try keeps its floating toolbar over the line below it, where the drag then lands (258);
    // a plain click on transcript text puts the caret there, which clears the toolbar and edits nothing; the point is checked
    // to be transcript text, never the toolbar, whose Correct and Regenerate buttons a click must not reach
    const free = await p.evaluate(({ x, y }) => { for (const [dx, dy] of [[2, 0], [2, -32], [2, -64], [2, 32]]) { const e = document.elementFromPoint(x + dx, y + dy); if (e && e.closest('[aria-label="Project Transcript"] [data-block=true]') && !e.closest('button')) return { x: x + dx, y: y + dy }; } return null; }, { x: r.x1, y: r.y });
    if (!free) { console.log('the transcript is covered where the word sits; reload the page and run again'); return; }
    await p.mouse.click(free.x, free.y); await wait(800); r = await find(false);
    await p.mouse.move(r.x1, r.y); await p.mouse.down(); await p.mouse.move(r.x2, r.y, { steps: 8 }); await p.mouse.up(); await wait(1200);
    const sel = await p.evaluate(() => window.getSelection().toString());
    if (sel.trim() !== from) { console.log('selected', JSON.stringify(sel), 'not', from); return; }
    await p.getByRole('button', { name: 'Correct', exact: true }).first().click(); await wait(900);
    if (!(await p.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'))) { console.log('the Correct box did not open'); return; }
    await p.keyboard.press('Meta+a'); await p.keyboard.insertText(to); await wait(300);
    await p.getByRole('button', { name: 'Correct', exact: true }).last().click(); await wait(1500);
    const now = await p.evaluate(w => [...document.querySelectorAll('[aria-label="Project Transcript"] [data-block=true]')].some(b => b.innerText.includes(w)), to);
    console.log('corrected', from, '->', to, now, (await timecode()).total);
  },
  // Studio Sound on the script clip (spends credits, so only when Oli has said to), read back from its switch
  async studio() {
    await selectScript(); await panel('Properties'); await wait(600);
    const sw = p.locator('[data-testid="effect-row-studio sound"] [role="switch"]').first();
    if (await sw.count() && (await sw.getAttribute('aria-checked')) === 'true') { console.log('studio sound already on'); return; }
    await panel('AI Tools'); await clickText('Studio Sound', { minX: 1235 });
    for (let i = 0; i < 40 && !(await sw.count()); i++) await wait(1500);
    await selectScript(); await panel('Properties'); await wait(800);
    console.log('studio sound', await sw.getAttribute('aria-checked'));
  },
  // every paragraph of the transcript as it stands, with its start, for reading takes against the script; read only
  async transcript() {
    for (const [t, x] of await fullTranscript()) console.log(`${t}\t${x.replace(/\s*\u{1F4CD}\s*/gu, ' ').replace(/\s+/g, ' ').trim()}`);
  },
  // before cutting a take where Oli reworded lines: his last full take of each row, read from the page, as a draft
  // of the "You said (as recorded, best takes)" column; rows under 50% are the ones to read against the take
  async draft(file, head) {
    const paras = (await fullTranscript()).map(([, t]) => t.replace(/\s*\u{1F4CD}\s*/gu, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    for (const r of draftRows(paras, scriptRows(file, head))) console.log(`${r.row}\t${r.score}%\t${r.takes} take${r.takes === 1 ? '' : 's'}\t${r.said ?? '(not found)'}`);
  },
  // the Script's width at each moment, read from its panel, which shows the in-between value while a zoom plays;
  // 2160 is full frame and 2376 is 110 percent. Steadier than measuring frames when the preview is small or the wall plain
  async zoomat(...ts) {
    for (const t of ts) {
      await fit(); await seek(+t); await selectScript(); await panel('Properties'); await wait(500);
      const w = +(await readField('W'));
      console.log(t, 'W', w, `${Math.round(w / 21.6)}%`, 'at', (await timecode()).now);
    }
  },
  // the closing check: gaps, duration, transcript against the script rows, then frames
  async check(file, head, ...ts) {
    await fit(); const g = (await gaps()).map(x => x.s);
    const rows = scriptRows(file, head).map(tok).flat().map(x => x.w);
    const T = (await fullTranscript()).flatMap(([, t]) => tok(t).map(x => x.w));
    const diff = wordDiff(rows, T);
    console.log('duration', (await timecode()).total, '| gaps', JSON.stringify(g), '| words', diff.length ? `${diff.length} differences from the script` : 'match the script');
    for (const [x, y] of diff) console.log(`  script "${x}"  said "${y}"`);
    if (ts.length) await commands.frames(...ts);
  },

};

if (!commands[cmd]) console.log('commands:', Object.keys(commands).join(', '));
else await commands[cmd](...args);
await b.close().catch(() => {});
