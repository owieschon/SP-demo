// Split batch files into pieces no larger than maxBytes, cutting only after
// a statement ends (a line ending in ";" while outside a $$ ... $$ body).
//   node tools/chunk-sql.mjs <batch-folder> <out-folder> [maxBytes]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const [src, out, maxArg] = process.argv.slice(2);
const MAX = Number(maxArg || 30000);
mkdirSync(out, { recursive: true });
let piece = 0;
for (const file of readdirSync(src).filter((f) => f.endsWith(".sql")).sort()) {
  const lines = readFileSync(join(src, file), "utf8").split("\n");
  let buf = [], size = 0, inDollar = false, cuts = 0;
  const flush = () => { if (!buf.length) return; piece++; cuts++; writeFileSync(join(out, `p${String(piece).padStart(3, "0")}_${file.replace(/^batch_(\d+).*/, "b$1")}_${cuts}.sql`), buf.join("\n") + "\n"); buf = []; size = 0; };
  for (const line of lines) {
    buf.push(line); size += line.length + 1;
    // Count $$ markers (and $tag$ markers) on the line to track function bodies.
    const marks = (line.match(/\$[A-Za-z_]*\$/g) || []).length;
    if (marks % 2 === 1) inDollar = !inDollar;
    if (!inDollar && /;\s*$/.test(line) && size >= MAX) flush();
  }
  flush();
}
console.log(`${piece} pieces`);
