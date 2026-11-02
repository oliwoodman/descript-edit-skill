import fs from 'node:fs';
// Pure helpers for reading a script entry and planning the cuts; no browser.
// read a script entry's rows (the "You said" / "You say" column) from a markdown table under a heading
export function scriptRows(file, head) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const h = lines.findIndex(l => /^#{1,6}\s/.test(l) && l.includes(head)); if (h < 0) throw new Error('no heading ' + head);
  const rows = []; let inTable = false;
  for (let i = h + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) break;
    if (!l.startsWith('|')) { if (inTable) break; continue; }
    inTable = true; const c = l.split('|').map(x => x.trim());
    if (/^-+$/.test(c[1].replace(/:/g, '')) || /^#$/.test(c[1])) continue;
    if (!c[2] || c[1].startsWith('**')) continue;
    rows.push(c[2]);
  }
  return rows;
}
export function lcs(a, b) { const d = Array(b.length + 1).fill(0); for (const x of a) { let prev = 0; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = x === b[j - 1] ? prev + 1 : Math.max(d[j], d[j - 1]); prev = t; } } return d[b.length]; }
// word differences between two lists, as [script words, transcript words] pairs
export function wordDiff(a, b) {
  const m = a.length, n = b.length, L = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0, da = [], db = [];
  const flush = () => { if (da.length || db.length) out.push([da.join(' '), db.join(' ')]); da = []; db = []; };
  while (i < m || j < n) { if (i < m && j < n && a[i] === b[j]) { flush(); i++; j++; } else if (j < n && (i === m || L[i][j + 1] >= L[i + 1][j])) db.push(b[j++]); else da.push(a[i++]); }
  flush(); return out;
}
export const tok = s => [...s.matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g)].map(m => ({ w: m[0].toLowerCase().replace(/['’].*$/, ''), s: m.index, e: m.index + m[0].length }));

// T: transcript tokens {w,s,e,k}; rows: token lists. Keeps the last full take of each row, cuts the rest.
export function planCuts(rows, T) {
  const log = [];
    const occ = R => { const o = [];
      for (let j = 0; j < T.length; j++) {
        if (T[j].w !== R[0].w || (R.length > 2 && !R.slice(1, 4).some(r => T.slice(j + 1, j + 4).some(t => t.w === r.w)))) continue;
        let best = null;
        for (let e = j + Math.max(1, R.length - 4); e <= Math.min(T.length, j + R.length + 4); e++) {
          const sc = lcs(T.slice(j, e).map(x => x.w), R.map(x => x.w)) / Math.max(R.length, e - j);
          if (!best || sc > best[2]) best = [j, e, sc];
        }
        if (best && best[2] >= 0.7) {
          // a match starting a word or two into the same take ("the proposal, the session plan") overlaps it; keep the better one
          const last = o[o.length - 1];
          if (last && best[0] < last[1]) { if (best[2] > last[2]) o[o.length - 1] = best; }
          else o.push(best);
        }
      }
      return o; };
    // every row's takes, in order; a row with none stops the plan
    const takes = rows.map(R => occ(R));
    for (let i = 0; i < rows.length; i++) if (!takes[i].length) { log.push(`row ${i + 1} NOT FOUND: ${rows[i].map(x => x.w).join(' ').slice(0, 70)}`); return { cuts: null, log }; }
    // pick from the end backwards: each row keeps its last take that ends before the next row's kept take starts,
    // so a row and the one after it come from the same run where they can
    const keep = Array(rows.length); let limit = T.length;
    for (let i = rows.length - 1; i >= 0; i--) {
      const c = takes[i].filter(o => o[1] <= limit);
      if (!c.length) { log.push(`row ${i + 1} has no take before row ${i + 2}`); return { cuts: null, log }; }
      keep[i] = c[c.length - 1]; limit = keep[i][0];
    }
    keep.forEach((k, i) => { if (k[2] < 1) log.push(`row ${i + 1} matched at ${Math.round(k[2] * 100)}%: "${T.slice(k[0], k[1]).map(x => x.w).join(' ').slice(0, 80)}"`); });
    const cuts = []; let from = 0;
    keep.forEach(([s, e], i) => {
      if (s > from) cuts.push([from, s]);
      // a stumble inside the kept take: the same one to four words twice in a row, where the script has them once
      const rw = rows[i].map(x => x.w).join(' ');
      for (let j = s; j < e; j++) for (let n = 4; n >= 1; n--) {
        const A = T.slice(j, j + n).map(x => x.w).join(' '), B = T.slice(j + n, j + 2 * n).map(x => x.w).join(' ');
        if (j + 2 * n <= e && A === B && !rw.includes(A + ' ' + A)) { cuts.push([j, j + n]); log.push(`row ${i + 1} repeats "${A}"; cutting one`); j += n; break; }
      }
      from = e;
    });
    if (from < T.length) cuts.push([from, T.length]);
  return { cuts, log };
}

// Draft the "You said (as recorded, best takes)" rows from an uncut transcript, for when Oli rewords lines on camera
// and plan cannot find the scripted words. paras: the transcript's paragraphs as strings; rows: the scripted lines.
// Each paragraph is split into attempts where a phrase restarts, consecutive attempts at the same line are grouped,
// each group keeps its last full attempt, and the groups are lined up with the rows in order. Returns one entry per
// row: { row, said, score, takes } where said is the transcript's own text, so plan matches it exactly.
export function draftRows(paras, rows) {
  const attempts = [];
  for (const para of paras) {
    const T = tok(para); if (!T.length) continue;
    const cuts = [0]; let start = 0;
    for (let j = 1; j + 2 < T.length; j++) {
      // a restart: the three words at j already came up in this attempt, and the words before them match its opening
      for (let i = start; i < j && j - i <= 40; i++) {
        if (T[i].w !== T[j].w || T[i + 1].w !== T[j + 1].w || T[i + 2].w !== T[j + 2].w) continue;
        const k = i - start, r = j - k;
        if (r <= start) continue;
        const pre = lcs(T.slice(start, i).map(x => x.w), T.slice(r, j).map(x => x.w));
        if (k === 0 || pre / k >= 0.5) { cuts.push(r); start = r; }
        break;
      }
    }
    cuts.push(T.length);
    for (let c = 0; c + 1 < cuts.length; c++) if (cuts[c + 1] > cuts[c]) {
      const a = T.slice(cuts[c], cuts[c + 1]);
      // the text runs on over closing marks the word tokens leave out ("22%", "first?")
      const end = a[a.length - 1].e + (para.slice(a[a.length - 1].e).match(/^[%.,!?"'”’)]*/)[0].length);
      attempts.push({ w: a.map(x => x.w), text: para.slice(a[0].s, end).replace(/[-–—\s]+$/, '').trim() });
    }
  }
  // group consecutive attempts at the same line: same opening three words, or most of the shorter one in the longer
  const groups = [];
  for (const a of attempts) {
    const g = groups[groups.length - 1], b = g && g[g.length - 1];
    const same = b && (a.w.slice(0, 3).join(' ') === b.w.slice(0, 3).join(' ') || lcs(a.w, b.w) / Math.min(a.w.length, b.w.length) >= 0.6);
    if (same) g.push(a); else groups.push([a]);
  }
  // keep the last attempt at least three quarters the length of the longest
  const kept = groups.map(g => { const max = Math.max(...g.map(a => a.w.length)); return { ...[...g].reverse().find(a => a.w.length >= 0.75 * max), takes: g.length }; });
  // line the groups up with the rows in order, best total similarity; a group can be left out, a row left empty
  const R = rows.map(r => tok(r).map(x => x.w)), n = R.length, m = kept.length;
  const sim = (i, j) => lcs(R[i], kept[j].w) / Math.max(R[i].length, kept[j].w.length);
  const S = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0)), B = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const opts = [[S[i - 1][j - 1] + sim(i - 1, j - 1), 1], [S[i - 1][j], 2], [S[i][j - 1], 3]];
    const best = opts.reduce((x, y) => (y[0] > x[0] ? y : x)); S[i][j] = best[0]; B[i][j] = best[1];
  }
  const out = rows.map((r, i) => ({ row: i + 1, said: null, score: 0, takes: 0 }));
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (B[i][j] === 1) { out[i - 1] = { row: i, said: kept[j - 1].text, score: Math.round(sim(i - 1, j - 1) * 100), takes: kept[j - 1].takes }; i--; j--; }
    else if (B[i][j] === 2) i--; else j--;
  }
  return out;
}
