// The cover as a designed image: the whole cover line in heavy white capitals with a firm close shadow and nothing
// behind it, rendered full frame at 2160 by 3840 and transparent, so it is placed at W 2160, X 1080, Y 1920 and lands
// exactly as designed. Everything stays inside the middle 840 of the 1080 width, the lines Instagram's own text guides
// show, and the block sits low enough to stay whole in the 3:4 profile grid crop. A long line wraps onto two balanced
// lines, shrinking from 150 to 120 to fit, and onto three when two will not hold it.
//
//   node cover-image.mjs <out.png> "" "<cover line>"
//
// COVER_TOP=250 COVER_BIG=120 in front moves the block up and caps the size, for footage where the head sits high.
// It renders in your installed Google Chrome, so nothing extra downloads.
import { chromium } from 'playwright';
const [out, small, big, close = ''] = process.argv.slice(2);
if (!out || small === undefined || !big) { console.log('usage: node cover-image.mjs <out.png> "<small line>" "<big words>" ["<small closing line>"]'); process.exit(1); }
// COVER_TOP and COVER_BIG move the block up and cap the big line's size, for footage where the head sits high (the welcome
// film, 21 Oct 2026, at 250 and 120 kept the block off the face)
const TOP = +(process.env.COVER_TOP || 300), BIG = +(process.env.COVER_BIG || 150);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const css = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@900&display=swap');
html,body{margin:0;background:transparent}
.wrap{width:1080px;height:1920px;position:relative;font-family:Inter,sans-serif;color:#fff}
.t{position:absolute;left:120px;right:120px;top:${TOP}px;text-align:center;text-shadow:0 0 3px rgba(0,0,0,.6),0 3px 8px rgba(0,0,0,.55),0 6px 26px rgba(0,0,0,.45)}
.serif{font-family:Georgia,serif;font-style:italic;font-size:${Math.round(76 * BIG / 150)}px;line-height:1.05;text-wrap:balance}
.big{font-weight:900;font-size:${BIG}px;letter-spacing:-3px;line-height:.95;text-transform:uppercase;margin:12px 0 8px;text-wrap:balance}`;
const html = `<div class="t">${small ? `<div class="serif">${esc(small)}</div>` : ''}<div class="big" id="big">${esc(big)}</div>${close ? `<div class="serif">${esc(close)}</div>` : ''}</div>`;
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 2 });
await p.setContent(`<style>${css}</style><div class="wrap">${html}</div>`);
await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(800);
// a single word wider than the 840 column is the only thing shrunk; measured as the widest word laid out alone
await p.evaluate((BIG) => { const e = document.getElementById('big'); const m = document.createElement('span'); m.className = 'big'; m.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;margin:0';
  document.body.append(m); let w = 0; for (const word of e.textContent.split(/\s+/)) { m.textContent = word; w = Math.max(w, m.getBoundingClientRect().width); } m.remove();
  let size = w > 840 ? BIG * 840 / w : BIG; e.style.fontSize = `${size}px`;
  const lh = () => parseFloat(getComputedStyle(e).fontSize) * 0.95;
  const start = size;
  while (e.getBoundingClientRect().height > lh() * 2.5 && size > 120) { size -= 4; e.style.fontSize = `${size}px`; }
  // a line that will not go on two at 120 or more goes on three at the biggest size that fits, since big type reads
  // from across a room and small type does not (Oli on 289, 26 Oct 2026)
  if (e.getBoundingClientRect().height > lh() * 2.5) { size = start; e.style.fontSize = `${size}px`;
    while (e.getBoundingClientRect().height > lh() * 3.5 && size > 90) { size -= 4; e.style.fontSize = `${size}px`; } } }, BIG);
await p.screenshot({ path: out, omitBackground: true });
await b.close();
console.log(out);
