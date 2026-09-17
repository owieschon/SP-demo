// Turn a folder of migrations into a few batch files for hand application.
//
//   node tools/batch-migrations.mjs <migrations-folder> <out-folder> [maxBytes]
//
// Full-line comments and blank lines are dropped (a line whose first
// non-space characters are "--" can only be a comment; nothing inside a
// string literal starts a line that way in these files). Trailing comments
// and everything inside quotes are left exactly as they are. Files are
// concatenated in name order into batches no larger than maxBytes, and no
// file is ever split. Each batch is one transaction when applied.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [src, out, maxArg] = process.argv.slice(2);
const MAX = Number(maxArg || 90000);
mkdirSync(out, { recursive: true });

const files = readdirSync(src).filter((f) => f.endsWith(".sql")).sort();
let batch = [], size = 0, n = 0, total = 0, stripped = 0;
const flush = () => {
  if (!batch.length) return;
  n++;
  const name = `batch_${String(n).padStart(2, "0")}_${batch[0].version}_to_${batch[batch.length - 1].version}.sql`;
  writeFileSync(join(out, name), batch.map((b) => `-- ==== ${b.file}\n${b.text}`).join("\n"));
  console.log(`${name}  ${batch.length} files  ${size} bytes`);
  batch = []; size = 0;
};
for (const file of files) {
  const raw = readFileSync(join(src, file), "utf8");
  total += raw.length;
  const text = raw.split(/\r?\n/).filter((l) => { const t = l.trim(); return t !== "" && !t.startsWith("--"); }).join("\n") + "\n";
  stripped += text.length;
  const version = file.slice(0, 14);
  if (size + text.length > MAX && batch.length) flush();
  batch.push({ file, version, text }); size += text.length;
}
flush();
console.log(`\n${files.length} files, ${total} bytes raw, ${stripped} bytes after stripping (${Math.round(100 * stripped / total)}%), ${n} batches`);
