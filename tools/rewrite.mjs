// Rewrite identifying words in a copied tree using a mapping file.
//
//   node tools/rewrite.mjs <folder> <mapping.json> [--dry]
//
// The mapping is {"old": "new", ...}, applied case-insensitively as whole
// words, longest key first (so "Acme Tools Inc." wins over "Acme Tools"). The
// replacement keeps the case shape of what it replaces when the key is a
// single word: "MARY" -> "DANA", "Mary" -> "Dana", "mary" -> "dana". It lives
// outside the repo, because the mapping itself names what must not appear.
//
// Prints a count per key. --dry changes nothing. Run tools/scan.mjs after it:
// the rewrite handles the bulk, the scan finds what is left for a person.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [folder, mapPath] = process.argv.slice(2);
const DRY = process.argv.includes("--dry");
if (!folder || !mapPath) { console.error("usage: node tools/rewrite.mjs <folder> <mapping.json> [--dry]"); process.exit(2); }

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".look", ".svelte-kit", ".vercel"]);
const SKIP_EXT = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|xlsx?|pkl|zip|wasm|gz|traineddata|lock)$/i;

const mapping = JSON.parse(readFileSync(mapPath, "utf8"));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rules = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length)
  .map(([from, to]) => ({ from, to, re: new RegExp(`(?<![A-Za-z0-9])${escape(from)}(?![A-Za-z0-9])`, "gi") }));

function shaped(match, to) {
  if (match === match.toUpperCase() && /[A-Z]/.test(match)) return to.toUpperCase();
  if (match === match.toLowerCase()) return to.toLowerCase();
  return to;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (!SKIP_EXT.test(name) && st.size < 5_000_000) yield p;
  }
}

const counts = new Map(); let changedFiles = 0;
for (const file of walk(folder)) {
  let text; try { text = readFileSync(file, "utf8"); } catch { continue; }
  let out = text;
  for (const { from, to, re } of rules) {
    out = out.replace(re, (m) => { counts.set(from, (counts.get(from) || 0) + 1); return shaped(m, to); });
  }
  if (out !== text) {
    changedFiles++;
    if (!DRY) writeFileSync(file, out);
    else console.log(`would change ${relative(folder, file)}`);
  }
}
console.log(`\n${changedFiles} file(s) ${DRY ? "would change" : "changed"}`);
for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);
