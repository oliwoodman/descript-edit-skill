// Offline: draft the as-recorded rows from a transcript exported as plain text (paragraphs split by blank lines).
// node draft.mjs <transcript.txt> <entry file> "<entry heading>"
import fs from 'node:fs';
import { scriptRows, draftRows } from './plan.mjs';
const [txt, file, head] = process.argv.slice(2);
const paras = fs.readFileSync(txt, 'utf8').split(/\n\s*\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
for (const r of draftRows(paras, scriptRows(file, head))) console.log(`${r.row}\t${r.score}%\t${r.takes} take${r.takes === 1 ? '' : 's'}\t${r.said ?? '(not found)'}`);
