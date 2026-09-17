// Sign the demo user in through Supabase Auth and store the session token in
// the app checkout's scripts/.env.test, the same way the repo's own test
// tooling does for its branch test user. Nothing is printed.
//   DEMO_PASSWORD=... node tools/mint-demo-token.mjs <app-folder>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const app = process.argv[2]; const pw = process.env.DEMO_PASSWORD;
if (!app || !pw) { console.error("usage: DEMO_PASSWORD=... node tools/mint-demo-token.mjs <app-folder>"); process.exit(2); }
const envPath = join(app, "scripts", ".env.test");
const env = Object.fromEntries(readFileSync(envPath, "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: "owen@grcrm.demo", password: pw }) });
if (!r.ok) { console.error("sign-in failed:", r.status, (await r.text()).slice(0, 200)); process.exit(1); }
const j = await r.json();
const lines = readFileSync(envPath, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("TEST_JWT=") && !l.startsWith("VITE_SUPABASE_URL="));
lines.push(`VITE_SUPABASE_URL=${env.SUPABASE_URL}`, `TEST_JWT=${j.access_token}`);
writeFileSync(envPath, lines.join("\n") + "\n");
console.log(`token stored for ${j.user?.email}, expires in ${j.expires_in}s`);
