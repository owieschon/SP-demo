// Scan a folder for words that must not appear in it.
//
//   node tools/scan.mjs <folder> <list.txt> [--show]
//
// The list is one term per line, matched case-insensitively as a whole word
// (so "Ed" does not flag "Edgar" or "used"). It lives outside the repo.
// Prints a count per term and, with --show, every hit as file:line. Exit code
// 1 when anything matched, so it can gate a commit.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [folder, listPath] = process.argv.slice(2);
const SHOW = process.argv.includes("--show");
if (!folder || !listPath) { console.error("usage: node tools/scan.mjs <folder> <list.txt> [--show]"); process.exit(2); }

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".look", ".svelte-kit", "legacy", ".vercel"]);
const SKIP_EXT = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|xlsx?|pkl|zip|wasm|gz|traineddata)$/i;

const terms = readFileSync(listPath, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole-word: a letter or digit may not touch either end of the term.
const patterns = terms.map((t) => ({ term: t, re: new RegExp(`(?<![A-Za-z0-9])${escape(t)}(?![A-Za-z0-9])`, "i") }));

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (!SKIP_EXT.test(name) && st.size < 5_000_000) yield p;
  }
}

const counts = new Map(); const files = new Set(); let hits = 0;
for (const file of walk(folder)) {
  let text; try { text = readFileSync(file, "utf8"); } catch { continue; }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const { term, re } of patterns) {
      if (re.test(line)) {
        hits++; files.add(file); counts.set(term, (counts.get(term) || 0) + 1);
        if (SHOW) console.log(`${relative(folder, file)}:${i + 1}: [${term}] ${line.trim().slice(0, 140)}`);
      }
    }
  });
}
console.log(`\n${hits} hit(s) in ${files.size} file(s)`);
for (const [term, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${term}`);
process.exit(hits ? 1 : 0);
