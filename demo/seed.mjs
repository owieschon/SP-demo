// Invented world for the GRCRM demo database.
//
//   node demo/seed.mjs --check     build the world in memory, print figures, touch nothing
//   node demo/seed.mjs             wipe the demo database and load the world
//
// Everything here is synthetic: the company, its people, its customers, its
// parts and every dollar. Names are generated from word lists; any match with
// a real business is coincidence. Dates are relative to the day the script
// runs, so re-running the morning of a demo keeps "today" honest.
//
// The database is the real GRCRM schema (its migrations applied unchanged),
// so the data has to be shaped exactly the way the ERP exports shape it:
// item ledger lines with negative quantities for sales, customer ledger
// invoices net of credit memos, a Jet "Open Sales Lines" snapshot loaded
// through gr_wh_import, and JSON records that the mirror trigger projects
// into the relational tables. The reads (Today, Deals, Warehouse, Find a
// part) then work without a single line of demo-only code in the app.
import { readFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CHECK = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Deterministic randomness. Same seed, same world, every run.
// ---------------------------------------------------------------------------
let seedState = 20260918;
function rnd() { // mulberry32
  seedState |= 0; seedState = (seedState + 0x6D2B79F5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
function gauss(mean, sd) {
  const u = 1 - rnd(), v = rnd();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const money = (n) => Math.round(n * 100) / 100;
const hex = (n = 12) => { let s = ""; while (s.length < n) s += Math.floor(rnd() * 16).toString(16); return s; };

// ---------------------------------------------------------------------------
// Dates. Everything is a plain YYYY-MM-DD string built in UTC.
// ---------------------------------------------------------------------------
const TODAY = new Date(); TODAY.setUTCHours(0, 0, 0, 0);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const daysAgo = (n) => iso(addDays(TODAY, -n));
const daysOut = (n) => iso(addDays(TODAY, n));
const YEAR = TODAY.getUTCFullYear();
const FIRST_LEDGER_DAY = new Date(Date.UTC(YEAR - 3, 0, 3));   // customer ledger history starts here
const FIRST_ITEM_DAY = new Date(Date.UTC(YEAR - 2, 0, 2));     // item ledger lines start a year later, like the real export
const dayOfYear = (d) => Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);

// ---------------------------------------------------------------------------
// The people. Owner names are what the app groups by; emails are what
// Supabase Auth signs in with. owen@grcrm.demo is the admin you sign in as.
// ---------------------------------------------------------------------------
const ROSTER = [
  { email: "owen@grcrm.demo",   display_name: "Owen",   role: "admin", owner_name: "Owen",   ops: true,  active: true },
  { email: "dana@grcrm.demo",   display_name: "Dana",   role: "team",  owner_name: "Dana",   ops: false, active: true },
  { email: "marcus@grcrm.demo", display_name: "Marcus", role: "team",  owner_name: "Marcus", ops: false, active: true },
  { email: "sam@grcrm.demo",    display_name: "Sam",    role: "team",  owner_name: "Sam",    ops: false, active: true },
  { email: "priya@grcrm.demo",  display_name: "Priya",  role: "team",  owner_name: "Priya",  ops: true,  active: true },
  { email: "jordan@grcrm.demo", display_name: "Jordan", role: "team",  owner_name: "Jordan", ops: false, active: true },
];
const OWNERS = ["Owen", "Dana", "Marcus", "Sam"];
const ADMIN = ROSTER[0];

const AGENCIES = [
  { id: "6001", name: "Summit Rep Group",           code: "410", group: "SUMMIT REP GROUP",      reps: ["Carla Nunez", "Ben Whitaker"],  territory: "Texas and the Gulf" },
  { id: "6002", name: "Ridgeline Sales Associates", code: "520", group: "RIDGELINE SALES",       reps: ["Luis Ortega", "Hannah Kim"],    territory: "Mountain West" },
  { id: "6003", name: "Bluewater Marketing",        code: "630", group: "BLUEWATER MARKETING",   reps: ["Derek Sloan"],                  territory: "Great Lakes and Canada" },
];

const FIRST = ["Alex", "Jamie", "Morgan", "Taylor", "Chris", "Pat", "Casey", "Drew", "Riley", "Robin", "Sydney", "Terry", "Dale", "Kim", "Lee", "Shawn", "Tracy", "Jesse", "Blake", "Avery", "Reese", "Quinn"];
const LAST = ["Alvarez", "Brennan", "Castillo", "Dawson", "Ellison", "Foster", "Garza", "Holloway", "Ibarra", "Jennings", "Keller", "Lindqvist", "Moreno", "Navarro", "Okafor", "Pruitt", "Quintero", "Reyes", "Sandoval", "Tanaka", "Underwood", "Vasquez", "Whitfield", "Yates", "Zimmerman"];
const TITLES = ["Parts Manager", "Purchasing", "Owner", "General Manager", "Buyer", "Service Manager", "Counter Lead", "Operations Manager"];
const personName = () => `${pick(FIRST)} ${pick(LAST)}`;

// ---------------------------------------------------------------------------
// Customers. A mix of independents, three chains whose branches bill to a
// head office, a few Canadian and Latin American accounts, two blocked and
// two closed, the way a real customer master looks.
// ---------------------------------------------------------------------------
const REGION_WORDS = ["Amarillo", "Bayou", "Big Sky", "Cascade", "Prairie", "Gulf Coast", "High Plains", "Ironhorse", "Panhandle", "Red River", "Rio Grande", "Rocky Mountain", "Sandhills", "Sooner", "Timberline", "Tidewater", "Yellowstone", "Ozark", "Piney Woods", "Blue Ridge", "Great Basin", "Copper State", "Badlands", "Cimarron", "Brazos", "Pecos", "Wasatch", "Bitterroot", "Sabine", "Palo Duro", "Llano", "Caprock", "Sangre", "Front Range", "Snake River", "Four Corners", "Permian", "Trinity", "Guadalupe", "Sierra"];
const KINDS = ["Truck Parts", "Diesel Supply", "Fleet Service", "Chrome & Stack", "Truck Center", "Heavy Duty Parts", "Trailer & Truck", "Freight Systems", "Truck Repair", "Equipment Co."];
const US_CITIES = [["Amarillo", "TX"], ["Lubbock", "TX"], ["Odessa", "TX"], ["Laredo", "TX"], ["Beaumont", "TX"], ["Tyler", "TX"], ["El Paso", "TX"], ["Corpus Christi", "TX"], ["Tulsa", "OK"], ["Lawton", "OK"], ["Shreveport", "LA"], ["Lafayette", "LA"], ["Fort Smith", "AR"], ["Texarkana", "AR"], ["Denver", "CO"], ["Grand Junction", "CO"], ["Billings", "MT"], ["Missoula", "MT"], ["Boise", "ID"], ["Spokane", "WA"], ["Yakima", "WA"], ["Medford", "OR"], ["Reno", "NV"], ["Salt Lake City", "UT"], ["Casper", "WY"], ["Albuquerque", "NM"], ["Phoenix", "AZ"], ["Fresno", "CA"], ["Bakersfield", "CA"], ["Toledo", "OH"], ["Akron", "OH"], ["Erie", "PA"], ["Gary", "IN"], ["Rockford", "IL"], ["Green Bay", "WI"], ["Des Moines", "IA"], ["Omaha", "NE"], ["Sioux Falls", "SD"], ["Fargo", "ND"], ["Jacksonville", "FL"], ["Mobile", "AL"], ["Chattanooga", "TN"], ["Kansas City", "MO"]];
const CHAINS = [
  { name: "TruckSource", hq: ["Dallas", "TX"], branches: [["Houston", "TX"], ["San Antonio", "TX"], ["Oklahoma City", "OK"], ["Tulsa", "OK"], ["Little Rock", "AR"], ["Shreveport", "LA"]] },
  { name: "Fleetline Parts", hq: ["Denver", "CO"], branches: [["Salt Lake City", "UT"], ["Albuquerque", "NM"], ["Cheyenne", "WY"], ["Billings", "MT"]] },
  { name: "Lone Star Truck Centers", hq: ["Fort Worth", "TX"], branches: [["Waco", "TX"], ["Abilene", "TX"], ["Lubbock", "TX"]] },
];
const INTERNATIONAL = [
  ["Northern Fleet Supply", "Calgary", "AB", "CA"], ["Kootenay Truck & Trailer", "Cranbrook", "BC", "CA"], ["Maple Diesel", "Winnipeg", "MB", "CA"], ["Ontario Heavy Duty", "Mississauga", "ON", "CA"],
  ["Transportes del Norte Refacciones", "Monterrey", "NL", "MX"], ["Refacciones Bajio", "Leon", "GT", "MX"], ["Andina Camiones", "Santiago", "RM", "CL"], ["Caribe Fleet Parts", "Bogota", "DC", "CO"],
];
const TIERS = ["DEALER", "DEALER", "DEALER", "DEALER", "PERFORMANC", "PERFORMANC", "PERFORMANC", "JOBBER", "JOBBER", "ELITE"];
const TIER_DISC = { JOBBER: 0.29, DEALER: 0.44, PERFORMANC: 0.48, ELITE: 0.523 };

function buildCustomers() {
  const customers = [];
  let nextNum = 1101;
  const num = () => String(nextNum++);
  const codeFor = () => { const r = rnd(); return r < 0.42 ? "1" : r < 0.66 ? "410" : r < 0.86 ? "520" : "630"; };
  const repName = (code, owner) => code === "1" ? `HOUSE - ${owner.toUpperCase()}` : pick(AGENCIES.find((a) => a.code === code).reps).toUpperCase();
  const groupFor = (code) => code === "1" ? "HOUSE ACCOUNT" : AGENCIES.find((a) => a.code === code).group;

  // Chains: the head office is its own customer; branches bill to it.
  for (const ch of CHAINS) {
    const code = codeFor(); const owner = pick(OWNERS);
    const hqNum = num();
    customers.push({ customer_no: hqNum, name: `${ch.name} - ${ch.hq[0]}`, bill_to_customer_no: null, chain: ch.name, city: ch.hq[0], state: ch.hq[1], country: "US",
      code, rep: repName(code, owner), group: groupFor(code), owner, tier: pick(TIERS), size: "A", ownCarrier: chance(0.5), blocked: "", isHq: true });
    for (const [city, state] of ch.branches) {
      customers.push({ customer_no: num(), name: `${ch.name} - ${city}`, bill_to_customer_no: hqNum, chain: ch.name, city, state, country: "US",
        code, rep: repName(code, owner), group: groupFor(code), owner, tier: customers[customers.length - 1].tier, size: pick(["B", "B", "C"]), ownCarrier: customers[customers.length - 1].ownCarrier, blocked: "", branchOf: hqNum });
    }
  }
  // Independents.
  const used = new Set();
  for (let i = 0; i < 52; i++) {
    let name; do { name = `${pick(REGION_WORDS)} ${pick(KINDS)}`; } while (used.has(name)); used.add(name);
    const [city, state] = pick(US_CITIES);
    const code = codeFor(); const owner = pick(OWNERS);
    const size = pick(["A", "B", "B", "C", "C", "C", "D", "D"]);
    customers.push({ customer_no: num(), name, bill_to_customer_no: null, chain: null, city, state, country: "US",
      code, rep: repName(code, owner), group: groupFor(code), owner, tier: pick(TIERS), size, ownCarrier: chance(0.3), blocked: "" });
  }
  // International.
  for (const [name, city, state, country] of INTERNATIONAL) {
    const code = country === "CA" ? "630" : "1"; const owner = country === "CA" ? pick(OWNERS) : "Owen";
    customers.push({ customer_no: num(), name, bill_to_customer_no: null, chain: null, city, state, country,
      code, rep: repName(code, owner), group: groupFor(code), owner, tier: pick(["DEALER", "PERFORMANC"]), size: pick(["B", "C"]), ownCarrier: true, blocked: "" });
  }
  // Life stages, so Today has something to say: new this year, gone quiet, churned, closed, blocked.
  const independents = customers.filter((c) => !c.chain);
  const stage = (c, s) => { c.lifecycle = s; };
  for (const c of customers) stage(c, "steady");
  independents.slice(-5).forEach((c) => { stage(c, "new"); c.customer_no = String(20000 + ri(100, 900)); });   // newer numbers, like the real master
  independents.slice(0, 4).forEach((c) => stage(c, "dormant"));
  independents.slice(4, 8).forEach((c) => stage(c, "churned"));
  independents.slice(8, 12).forEach((c) => stage(c, "slipping"));
  independents.slice(12, 16).forEach((c) => stage(c, "growing"));
  independents[16].blocked = "All"; independents[17].blocked = "All";
  independents[18].code = "CLOSED"; independents[18].rep = "HOUSE - CLOSED"; independents[18].group = "HOUSE ACCOUNT"; stage(independents[18], "churned");
  independents[19].code = "CLOSED"; independents[19].rep = "HOUSE - CLOSED"; independents[19].group = "HOUSE ACCOUNT"; stage(independents[19], "churned");
  // A few accounts nobody owns yet, for the owner proposals and the Unassigned row.
  independents.slice(40, 44).forEach((c) => { c.owner = null; });
  return customers;
}

// ---------------------------------------------------------------------------
// Parts. Part numbers follow a real-world grammar (diameter, angle, legs,
// finish) because the app decodes them, so a sibling search has something
// to find. Costs and prices are invented.
// ---------------------------------------------------------------------------
const FINISH = { A: "ALUMINIZED", C: "CHROME", SA: "ALUMINIZED SLIP", SC: "CHROME SLIP" };
const VENDORS = [
  { vendor_no: "V1010", name: "Lakeshore Plating Co.",       kind: "plater",  lead: "3W", city: "Sandusky", state: "OH" },
  { vendor_no: "V1020", name: "Midland Tube & Steel",        kind: "tube",    lead: "2W", city: "Toledo", state: "OH" },
  { vendor_no: "V1030", name: "Cardinal Clamp Co.",          kind: "clamps",  lead: "4W", city: "Erie", state: "PA" },
  { vendor_no: "V1040", name: "Northstar Flex Products",     kind: "flex",    lead: "6W", city: "Duluth", state: "MN" },
  { vendor_no: "V1050", name: "Great Lakes Muffler Mfg",     kind: "muffler", lead: "5W", city: "Grand Rapids", state: "MI" },
  { vendor_no: "V1060", name: "Summit Fasteners",            kind: "hardware", lead: "2W", city: "Akron", state: "OH" },
  { vendor_no: "V1070", name: "Buckeye Stamping",            kind: "brackets", lead: "4W", city: "Columbus", state: "OH" },
  { vendor_no: "V1080", name: "Harbor Packaging Supply",     kind: "packaging", lead: "1W", city: "Cleveland", state: "OH" },
  { vendor_no: "V1090", name: "Pioneer Heat Shield",         kind: "shields", lead: "3W", city: "Fort Wayne", state: "IN" },
  { vendor_no: "V1100", name: "Keystone Rubber & Gasket",    kind: "gaskets", lead: "2W", city: "Scranton", state: "PA" },
];
const vendorOf = (kind) => VENDORS.find((v) => v.kind === kind).vendor_no;

function buildItems() {
  const items = [];
  const add = (it) => { items.push(it); return it; };
  const listPrice = (cost, margin) => money(cost / (1 - margin));
  const shelf = () => `${pick("ABCDEFG")}-${ri(1, 24)}`;

  // Elbows
  const legs = [[12, 12], [18, 18], [18, 24], [24, 24], [12, 18], [20, 20], [24, 30], [16, 16]];
  for (const dia of [4, 5, 6, 7, 8]) for (const deg of [45, 90]) for (const [a, b] of legs) for (const fin of ["A", "C", "SA", "SC"]) {
    if (!chance(0.19)) continue;
    const chrome = fin.startsWith("C") || fin.endsWith("C");
    const cost = money((14 + dia * 4 + (a + b) * 0.35) * (chrome ? 1.9 : 1));
    add({ item_no: `L${dia}${deg}-${a}${b}${fin}`, description: `${dia}" ${deg} DEG ELBOW ${a}" X ${b}" ${FINISH[fin]}`, category: "ELBOWS", posting: chrome ? "CHROME" : "PIPE", family: "elbow",
      cost, price: listPrice(cost, 0.72), replenishment: "Prod. Order", work_center: chrome ? "CHROME" : "BEND CELL", vendor_no: chrome ? vendorOf("plater") : "", lead: chrome ? "3W" : chance(0.6) ? "1W" : "", qtyTypical: [4, 24] });
  }
  // Stacks
  const STYLE = { S: "STRAIGHT CUT", M: "MITER CUT", K: "CURVED", W: "WEST COAST TURNOUT" };
  for (const dia of [5, 6, 7, 8]) for (const len of [36, 48, 60, 72, 84, 96, 108, 120]) for (const st of ["S", "M", "K", "W"]) for (const fin of ["A", "C"]) {
    if (!chance(0.16)) continue;
    const chrome = fin === "C";
    const cost = money((40 + dia * 6 + len * 0.9) * (chrome ? 1.8 : 1));
    add({ item_no: `S${dia}-${len}${st}${fin}`, description: `${dia}" X ${len}" ${STYLE[st]} STACK ${FINISH[fin]}`, category: "STACKS", posting: chrome ? "CHROME" : "PIPE", family: "stack",
      cost, price: listPrice(cost, 0.7), replenishment: "Prod. Order", work_center: chrome ? "CHROME" : "CUT CELL", vendor_no: chrome ? vendorOf("plater") : "", lead: chrome ? "3W" : chance(0.6) ? "1W" : "", qtyTypical: [2, 10] });
  }
  // Straight pipe
  for (const dia of [3, 4, 5, 6]) for (const len of [24, 36, 48, 60, 120]) {
    if (!chance(0.75)) continue;
    const cost = money(8 + dia * 3 + len * 0.45);
    add({ item_no: `P${dia}-${len}A`, description: `${dia}" X ${len}" STRAIGHT PIPE ALUMINIZED`, category: "PIPE", posting: "PIPE", family: "pipe",
      cost, price: listPrice(cost, 0.78), replenishment: "Prod. Order", work_center: "CUT CELL", vendor_no: "", lead: "1W", qtyTypical: [5, 40] });
  }
  // Mufflers
  for (let i = 0; i < 12; i++) {
    const bought = i < 8; const cost = money(ri(70, 220));
    add({ item_no: `M-${1005 + i * 5}`, description: `MUFFLER ${pick(["OVAL", "ROUND"])} ${pick([24, 30, 36])}" BODY ${pick(["4", "5"])}" IN/OUT`, category: "MUFFLERS", posting: "MUFFLER", family: "muffler",
      cost, price: listPrice(cost, 0.55), replenishment: bought ? "Purchase" : "Prod. Order", work_center: bought ? "" : "WELD CELL", vendor_no: bought ? vendorOf("muffler") : "", lead: bought ? "5W" : "2W", qtyTypical: [2, 8] });
  }
  // Clamps
  for (const dia of [3, 3.5, 4, 5, 6]) for (const t of ["B", "W", "V"]) {
    const cost = money(3 + dia * 1.4 + (t === "V" ? 4 : 0));
    add({ item_no: `CL-${String(dia).replace(".", "")}${t}`, description: `${dia}" ${{ B: "BAND", W: "WIDE BAND", V: "V-BAND" }[t]} CLAMP`, category: "CLAMPS", posting: "CLAMPS", family: "clamp",
      cost, price: listPrice(cost, 0.6), replenishment: "Purchase", work_center: "", vendor_no: vendorOf("clamps"), lead: "4W", qtyTypical: [20, 120] });
  }
  // Flex
  for (const dia of [3, 4, 5]) for (const len of [18, 24, 36]) {
    const cost = money(12 + dia * 4 + len * 0.5);
    add({ item_no: `FL-${dia}-${len}`, description: `${dia}" X ${len}" FLEX PIPE STAINLESS`, category: "FLEX", posting: "FLEX", family: "flex",
      cost, price: listPrice(cost, 0.5), replenishment: "Purchase", work_center: "", vendor_no: vendorOf("flex"), lead: "6W", qtyTypical: [6, 30] });
  }
  // Accessories
  for (let i = 1; i <= 6; i++) { const cost = money(ri(18, 45)); add({ item_no: `HS-${100 + i * 10}`, description: `HEAT SHIELD ${pick([4, 5, 6])}" ${pick(["36", "48", "60"])}" STAINLESS`, category: "ACCESSORY", posting: "ACCESS", family: "shield", cost, price: listPrice(cost, 0.62), replenishment: "Prod. Order", work_center: "WELD CELL", vendor_no: "", lead: "2W", qtyTypical: [4, 20] }); }
  for (let i = 1; i <= 6; i++) { const cost = money(ri(6, 22)); add({ item_no: `RB-${30 + i * 5}ZN`, description: `${pick(["RAIN CAP", "MOUNTING BRACKET", "STACK BRACKET"])} ${pick([5, 6, 7, 8])}" ZINC`, category: "ACCESSORY", posting: "ACCESS", family: "bracket", cost, price: listPrice(cost, 0.55), replenishment: "Purchase", work_center: "", vendor_no: vendorOf("brackets"), lead: "4W", qtyTypical: [10, 60] }); }
  // Kits (assembled from other parts)
  for (let i = 1; i <= 5; i++) { const cost = money(ri(380, 1100)); add({ item_no: `K-${200 + i}`, description: `${pick(["DUAL", "SINGLE"])} STACK KIT ${pick([6, 7, 8])}" ${pick(["CHROME", "ALUMINIZED"])}`, category: "KITS", posting: "KITS", family: "kit", cost, price: listPrice(cost, 0.58), replenishment: "Assembly", work_center: "ASSEMBLY", vendor_no: "", lead: "", qtyTypical: [1, 4] }); }
  // Custom, made to order
  for (let i = 1; i <= 15; i++) { const cost = money(ri(60, 900)); add({ item_no: `CU-${4000 + i * 7}`, description: `CUSTOM ${pick(["ELBOW", "STACK", "Y-PIPE", "EXTENSION", "TURNOUT"])} PER DRAWING ${ri(1000, 9999)}`, category: pick(["ELBOWS", "STACKS", "PIPE"]), posting: "PIPE", family: "custom", productGroup: "CUSTOM", madeToOrder: true, cost, price: listPrice(cost, 0.66), replenishment: "Prod. Order", work_center: pick(["BEND CELL", "WELD CELL", "CUT CELL"]), vendor_no: "", lead: chance(0.5) ? "" : "2W", qtyTypical: [1, 6] }); }
  // Proprietary, one buyer each
  for (let i = 1; i <= 4; i++) { const cost = money(ri(90, 400)); add({ item_no: `PR-${7000 + i * 11}`, description: `PROPRIETARY ${pick(["MANIFOLD ADAPTER", "STACK", "BRACKET SET"])} DWG ${ri(100, 999)}`, category: pick(["ELBOWS", "STACKS", "ACCESSORY"]), posting: "PIPE", family: "proprietary", productGroup: "PROPRIETAR", isProprietary: true, cost, price: listPrice(cost, 0.7), replenishment: "Prod. Order", work_center: "WELD CELL", vendor_no: "", lead: "2W", qtyTypical: [2, 12] }); }

  // Stock figures the item master carries.
  for (const it of items) {
    const stocked = !it.madeToOrder;
    const base = { clamp: 400, flex: 120, bracket: 200, pipe: 90, elbow: 40, stack: 18, muffler: 25, shield: 30, kit: 6, proprietary: 10, custom: 0 }[it.family];
    it.qoh_gr = stocked ? Math.max(0, Math.round(gauss(base, base * 0.6))) : 0;
    it.qoh = it.qoh_gr + (stocked && chance(0.3) ? ri(1, Math.max(1, Math.round(base * 0.2))) : 0);
    it.on_prod_order = it.replenishment === "Prod. Order" && chance(0.35) ? pick([25, 50, 100, 150]) : 0;
    it.on_purch_order = it.replenishment === "Purchase" && chance(0.4) ? pick([100, 200, 500]) : 0;
    it.shelf = shelf(); it.bin = `${it.shelf}-${ri(1, 6)}`;
    it.productGroup = it.productGroup || (it.family === "kit" ? "KIT" : it.posting);
    it.blocked = chance(0.03); it.obsolete = false;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Accounts, agencies and reps as the JSON records the mirror trigger reads.
// Chains are one rolled-up account with the branches as locations.
// ---------------------------------------------------------------------------
function buildRecords(customers) {
  const records = []; let nextId = 1001;
  const accountByCustomer = new Map();
  const contactsByAccount = new Map();
  const nowIso = new Date().toISOString();
  const stepPool = ["Follow up on the chrome quote", "Confirm Q4 stack forecast", "Send updated tier pricing", "Set up a plant visit", "Ask about the new location", "Review open backorders with purchasing", "Get the drawing for the custom Y-pipe", "Check in on the muffler program", "Book the counter-day training", "Close the loop on the freight claim"];
  const notePool = ["Spoke with purchasing, they are consolidating vendors this quarter.", "Chrome demand is up with the new fleet contract.", "Asked for lead times on 8 inch stacks before they commit.", "Prefers email over calls before 10am.", "Wants a standing order for clamps, monthly.", "Their counter guy is new, send the catalog.", "Lost a bid on mufflers to a competitor on price, not quality.", "Expanding the service bays, more pipe next year."];
  const dueDays = () => pick([-9, -4, -2, -1, 0, 0, 1, 2, 3, 5, 8, 12, 20, 35, 60]);

  const mkContacts = (n) => Array.from({ length: n }, (_, i) => {
    const name = personName();
    return { id: `ct_${hex(16)}`, name, title: pick(TITLES), email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`, phone: `(${ri(200, 989)}) 555-${String(ri(100, 9999)).padStart(4, "0")}`, location: "", primary: i === 0 };
  });
  const mkNotes = (n, author) => Array.from({ length: n }, () => ({ id: `nl_${hex(16)}`, author, text: pick(notePool), createdAt: addDays(TODAY, -ri(3, 200)).toISOString() }));
  const mkSteps = (n, owner) => Array.from({ length: n }, () => ({ id: `ns_${hex(16)}`, title: pick(stepPool), dueDate: iso(addDays(TODAY, dueDays())), completed: false, owner, addedBy: owner, addedAt: addDays(TODAY, -ri(1, 30)).toISOString() }));

  const roots = customers.filter((c) => !c.branchOf);
  for (const c of roots) {
    const id = String(nextId++);
    const owner = c.owner || "Unassigned";
    const branches = customers.filter((b) => b.branchOf === c.customer_no);
    const contacts = mkContacts(ri(1, 3));
    const steps = c.lifecycle === "churned" ? [] : mkSteps(chance(0.55) ? ri(1, 2) : 0, owner === "Unassigned" ? "Owen" : owner);
    const data = {
      category: "Account Management", title: c.isHq ? `${c.chain} (ROLLED UP)` : c.name, customerNum: c.customer_no, accountOwner: owner,
      salesRep: c.code === "1" ? "" : c.rep, address: `${ri(100, 9900)} ${pick(["Industrial", "Commerce", "Frontage", "Mill", "Freight", "Depot"])} ${pick(["Rd", "Blvd", "Dr", "Pkwy"])}`, city: c.city, state: c.state,
      phone: `(${ri(200, 989)}) 555-${String(ri(100, 9999)).padStart(4, "0")}`, email: contacts[0].email, houseAccount: c.code === "1",
      strategies: [], buyingGroups: c.chain ? [c.chain] : [], details: "", notes: "", isRolledUp: !!c.isHq, completed: false,
      contacts, noteLog: mkNotes(chance(0.6) ? ri(1, 3) : 0, owner === "Unassigned" ? "Owen" : owner), nextSteps: steps,
      locations: branches.map((b) => ({ id: `loc_${hex(16)}`, navNum: b.customer_no, customerNum: b.customer_no, address: `${b.city}, ${b.state}`, contactName: personName(), contactTitle: "Branch Manager", email: "", phone: "", addedBy: "import", sourceName: b.name })),
      openOrders: [], openOrdersUpdatedAt: null, stat2025: 0, stat2026YTD: 0,
    };
    records.push({ id, owner, data, created_at: addDays(TODAY, -ri(200, 900)).toISOString(), updated_at: nowIso, _customer: c, _branches: branches });
    accountByCustomer.set(c.customer_no, id);
    for (const b of branches) accountByCustomer.set(b.customer_no, id);
    contactsByAccount.set(id, contacts);
  }
  // Agencies (channels) and their reps
  for (const a of AGENCIES) {
    records.push({ id: a.id, owner: "Owen", created_at: nowIso, updated_at: nowIso, data: { category: "Channel", title: a.name, email: `hello@${a.name.toLowerCase().replace(/[^a-z]+/g, "")}.example.com`, phone: `(${ri(200, 989)}) 555-${String(ri(100, 9999)).padStart(4, "0")}`, website: "", address: "", territory: a.territory, notes: "", completed: false, contacts: [], noteLog: [], nextSteps: [] } });
    a.reps.forEach((name, i) => {
      const id = `${5000 + Number(a.id) - 6000 + 1}${i}`;
      records.push({ id, owner: "Owen", created_at: nowIso, updated_at: nowIso, data: { category: "Sales Rep", title: name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`, phone: `(${ri(200, 989)}) 555-${String(ri(100, 9999)).padStart(4, "0")}`, territory: a.territory, company: a.name, address: "", notes: "", parentChannelId: a.id, linkedAccountIds: [], completed: false, contacts: [], noteLog: [], nextSteps: [] } });
    });
  }
  return { records, accountByCustomer, contactsByAccount };
}

// ---------------------------------------------------------------------------
// The ledgers. Each customer buys a basket of parts, each on its own rhythm
// (clockwork, predictable, random, one-off). Lines on the same day become one
// shipment and one invoice. The customer ledger goes back a year further than
// the item ledger, the way the real exports do.
// ---------------------------------------------------------------------------
function buildLedgers(customers, items, accountByCustomer) {
  const sellable = items.filter((i) => !i.madeToOrder && i.family !== "proprietary");
  const custom = items.filter((i) => i.madeToOrder);
  const proprietary = items.filter((i) => i.family === "proprietary");
  const skuLines = []; const shipments = []; // shipment = {customer, date, lines[], po, doc}
  let entryNo = 500001; let docNo = 300001; let poCounter = 41000;
  const basketSize = { A: [22, 36], B: [11, 22], C: [5, 11], D: [1, 4] };
  const cadenceOf = () => { const r = rnd(); return r < 0.25 ? "clockwork" : r < 0.6 ? "predictable" : r < 0.85 ? "random" : "oneoff"; };
  const startFor = (c) => c.lifecycle === "new" ? addDays(TODAY, -ri(20, 150)) : addDays(FIRST_LEDGER_DAY, ri(0, 240));
  const endFor = (c) => {
    if (c.lifecycle === "churned") return addDays(TODAY, -ri(200, 330));
    if (c.lifecycle === "dormant") return addDays(TODAY, -ri(75, 130));
    if (c.blocked) return addDays(TODAY, -ri(120, 300));
    return addDays(TODAY, -1);
  };
  const proprietaryOwners = new Map();
  proprietary.forEach((p, i) => proprietaryOwners.set(p.item_no, customers.filter((c) => c.size === "A")[i % 4]));

  for (const c of customers) {
    const [lo, hi] = basketSize[c.size];
    const basket = new Set();
    while (basket.size < ri(lo, hi)) basket.add(pick(sellable));
    if (c.size !== "D" && chance(0.5)) basket.add(pick(custom));
    for (const [pn, owner] of proprietaryOwners) if (owner === c) basket.add(items.find((i) => i.item_no === pn));
    c.basket = [...basket];
    const start = startFor(c), end = endFor(c);
    const volumeScale = c.lifecycle === "growing" ? (d) => (d.getUTCFullYear() === YEAR ? 1.35 : 1) : c.lifecycle === "slipping" ? (d) => (d.getUTCFullYear() === YEAR ? 0.55 : 1) : () => 1;
    const byDay = new Map();
    for (const it of c.basket) {
      const cad = cadenceOf();
      const meanGap = cad === "clockwork" ? ri(21, 45) : cad === "predictable" ? ri(30, 75) : cad === "random" ? ri(60, 200) : 0;
      const sdGap = cad === "clockwork" ? meanGap * 0.1 : cad === "predictable" ? meanGap * 0.3 : meanGap * 0.9;
      let d = addDays(start, ri(0, cad === "oneoff" ? 500 : meanGap));
      const [qlo, qhi] = it.qtyTypical;
      let n = 0;
      while (d <= end && n < 400) {
        // Front-loaded year: fewer orders in November and December.
        if (!(d.getUTCMonth() >= 10 && chance(0.35))) {
          const qty = Math.max(1, Math.round(gauss((qlo + qhi) / 2, (qhi - qlo) / 4) * volumeScale(d)));
          const key = iso(d);
          if (!byDay.has(key)) byDay.set(key, []);
          byDay.get(key).push({ it, qty });
        }
        if (cad === "oneoff") break;
        d = addDays(d, Math.max(3, Math.round(gauss(meanGap, sdGap))));
        n++;
      }
    }
    const disc = TIER_DISC[c.tier];
    for (const [day, lines] of [...byDay.entries()].sort()) {
      const date = new Date(day + "T00:00:00Z");
      const po = `PO-${poCounter++}`;
      const doc = `PS${String(docNo++).padStart(6, "0")}`;
      const shipment = { customer: c, date, po, doc, lines: [], total: 0, cost: 0 };
      for (const { it, qty } of lines) {
        const unit = money(it.price * (1 - disc) * gauss(1, 0.02));
        const amount = money(unit * qty), cost = money(it.cost * qty);
        shipment.lines.push({ it, qty, unit, amount, cost });
        shipment.total = money(shipment.total + amount); shipment.cost = money(shipment.cost + cost);
        if (date >= FIRST_ITEM_DAY) {
          skuLines.push({ id: randomUUID(), entry_no: String(entryNo++), account_id: accountByCustomer.get(c.customer_no) || null, customer_num: c.customer_no, item_no: it.item_no, posting_date: day,
            document_no: doc, document_type: "Sales Shipment", quantity: -qty, sales_amount: amount, cost_amount: cost, external_doc_no: po, batch_id: "imp_seed_ledger", first_batch_id: "imp_seed_ledger", imported_at: new Date().toISOString() });
          // The odd return, ten to thirty days later.
          if (chance(0.004)) {
            const rd = addDays(date, ri(10, 30));
            if (rd < TODAY) skuLines.push({ id: randomUUID(), entry_no: String(entryNo++), account_id: accountByCustomer.get(c.customer_no) || null, customer_num: c.customer_no, item_no: it.item_no, posting_date: iso(rd),
              document_no: `PR${String(docNo++).padStart(6, "0")}`, document_type: "Sales Return Receipt", quantity: Math.min(qty, ri(1, 3)), sales_amount: -money(unit * Math.min(qty, 2)), cost_amount: -money(it.cost * Math.min(qty, 2)), external_doc_no: po, batch_id: "imp_seed_ledger", first_batch_id: "imp_seed_ledger", imported_at: new Date().toISOString() });
          }
        }
      }
      shipments.push(shipment);
    }
  }

  // Invoices, credit memos and payments in the customer ledger; invoice headers beside them.
  const custLedger = []; const invoices = []; let clNo = 900001; let invNo = 700001; let orderNo = 610001;
  const freeShip = { [YEAR]: 1800, [YEAR - 1]: 1700, [YEAR - 2]: 1600, [YEAR - 3]: 1500 };
  for (const s of shipments.sort((a, b) => a.date - b.date)) {
    const c = s.customer;
    const freight = c.ownCarrier ? 0 : s.total >= (freeShip[s.date.getUTCFullYear()] || 1500) ? 0 : money(Math.min(220, 38 + s.total * 0.025));
    const amount = money(s.total + freight);
    const ageDays = Math.round((TODAY - s.date) / 86400000);
    const open = ageDays < 30 || chance(0.04);
    const posting = iso(s.date);
    const docNum = `PSI${String(invNo++).padStart(6, "0")}`;
    const billTo = c.bill_to_customer_no || c.customer_no;
    custLedger.push({ entry_no: clNo++, posting_date: posting, document_type: "Invoice", document_no: docNum, customer_no: billTo, sell_to_customer_no: c.customer_no, external_doc_no: s.po, customer_name: c.name, description: `Invoice ${docNum}`,
      customer_posting_group: c.country === "US" ? "DOMESTIC" : "FOREIGN", salesperson_code: c.code, currency_code: "", original_amount: amount, amount, remaining_amount: open ? amount : 0, sales_amount: amount, due_date: iso(addDays(s.date, 30)),
      closed_at_date: open ? null : iso(addDays(s.date, ri(18, 45))), is_open: open, on_hold: "", reversed: false, source_code: "SALES", loaded_at: new Date().toISOString() });
    invoices.push({ invoice_no: docNum, customer_no: c.customer_no, customer_name: c.name, bill_to_customer_no: billTo, posting_date: posting, document_date: posting, due_date: iso(addDays(s.date, 30)), order_date: iso(addDays(s.date, -ri(2, 9))), shipment_date: posting,
      order_no: `SO${orderNo++}`, quote_no: "", external_doc_no: s.po, amount, amount_incl_tax: amount, remaining_amount: open ? amount : 0, salesperson_code: c.code, order_taken_by: "JORDAN", price_group: c.tier, disc_group: "", posting_group: c.country === "US" ? "DOMESTIC" : "FOREIGN",
      payment_terms: "NET30", shipment_method: c.ownCarrier ? "CUSTOMER" : "GROUND", shipping_agent: c.ownCarrier ? "" : pick(["XPO", "UPS", "FEDEX", "SAIA"]), location_code: "MAIN", sell_to_city: c.city, sell_to_state: c.state, sell_to_zip: "", ship_to_name: c.name, ship_to_zip: "", ship_to_country: c.country, country_code: c.country,
      contact_name: "", email: "", phone: "", closed: !open, corrective: false, currency_code: "", user_id: "NAV\\JORDAN", batch_id: "imp_seed_invoices", first_batch_id: "imp_seed_invoices", imported_at: new Date().toISOString() });
    if (!open) custLedger.push({ entry_no: clNo++, posting_date: iso(addDays(s.date, ri(18, 45))), document_type: "Payment", document_no: `PMT${String(clNo).padStart(6, "0")}`, customer_no: billTo, sell_to_customer_no: c.customer_no, external_doc_no: "", customer_name: c.name, description: `Payment ${docNum}`,
      customer_posting_group: c.country === "US" ? "DOMESTIC" : "FOREIGN", salesperson_code: c.code, currency_code: "", original_amount: -amount, amount: -amount, remaining_amount: 0, sales_amount: 0, due_date: null, closed_at_date: null, is_open: false, on_hold: "", reversed: false, source_code: "CASHRCPT", loaded_at: new Date().toISOString() });
    if (chance(0.015)) {
      const cm = -money(amount * (0.1 + rnd() * 0.3)); const cd = addDays(s.date, ri(5, 20));
      if (cd < TODAY) custLedger.push({ entry_no: clNo++, posting_date: iso(cd), document_type: "Credit Memo", document_no: `PCM${String(clNo).padStart(6, "0")}`, customer_no: billTo, sell_to_customer_no: c.customer_no, external_doc_no: s.po, customer_name: c.name, description: `Credit against ${docNum}`,
        customer_posting_group: c.country === "US" ? "DOMESTIC" : "FOREIGN", salesperson_code: c.code, currency_code: "", original_amount: cm, amount: cm, remaining_amount: 0, sales_amount: cm, due_date: null, closed_at_date: iso(cd), is_open: false, on_hold: "", reversed: false, source_code: "SALES", loaded_at: new Date().toISOString() });
    }
  }
  return { skuLines, shipments, custLedger, invoices };
}

// ---------------------------------------------------------------------------
// Deals. Built after the ledger so a "delivering" deal's parts really did
// ship inside its window and a "kept" deal really did reach 95%.
// ---------------------------------------------------------------------------
function buildDeals(records, customers, shipments, contactsByAccount) {
  const deals = []; let nextId = 3001;
  const accounts = records.filter((r) => r.data.category === "Account Management" && r._customer.lifecycle !== "churned" && r._customer.lifecycle !== "dormant" && !r._customer.blocked && r._customer.size !== "D");
  const shipsFor = (r) => shipments.filter((s) => s.customer === r._customer || r._branches.includes(s.customer));
  const li = (l) => ({ id: `li_${hex(16)}`, itemNo: l.it.item_no, qty: l.qty, desc: l.it.description, unitPrice: l.unit });
  const uo = (amount, date, basis, lines = []) => ({ id: `uo_${hex(16)}`, amount: money(amount), expectedDate: date, dateBasis: basis, holdup: "", quoteId: null, itemLines: lines });
  const titles = ["Chrome stack program", "Fleet elbow restock", "Muffler line changeover", "Clamp standing order", "Custom Y-pipe build", "Q4 pipe stocking order", "Heat shield retrofit", "Dual stack kits for the new lot", "Turnout stacks for the west yard", "Flex pipe consolidation"];
  const used = new Set();
  const take = () => { let a; do { a = pick(accounts); } while (used.has(a.id) && used.size < accounts.length); used.add(a.id); return a; };
  const base = (a, title, extra) => {
    const c = a._customer; const contacts = contactsByAccount.get(a.id) || [];
    const owner = a.data.accountOwner === "Unassigned" ? "Owen" : a.data.accountOwner;
    return { id: String(nextId++), owner, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), data: {
      category: "Open Opportunities", title, linkedAccountId: a.id, accountName: a.data.title, customerNum: c.customer_no, oppOwner: owner, accountOwner: owner, salesRep: a.data.salesRep,
      oppType: pick(["New Business", "Upsell", "Reactivation", "Renewal"]), oppDescription: pick(["Buyer confirmed quantities on the call.", "Waiting on their fleet manager to sign off.", "Replaces a competitor's part on the same trucks.", ""]),
      buyerContactId: contacts[0]?.id || null, scopeItems: [], upcomingOrders: [], quotes: [], noteLog: [], nextSteps: [], stageHistory: [], completed: false, lastContact: daysAgo(ri(1, 20)), ...extra } };
  };
  const inWindow = (a, from, to) => shipsFor(a).filter((s) => s.date >= from && s.date <= to);
  const scopeAndDelivered = (a, from, to, nParts) => {
    const ships = inWindow(a, from, to); const lines = ships.flatMap((s) => s.lines);
    const parts = [...new Set(lines.map((l) => l.it.item_no))].slice(0, nParts);
    const scope = parts.map((pn) => li(lines.find((l) => l.it.item_no === pn)));
    const delivered = money(lines.filter((l) => parts.includes(l.it.item_no)).reduce((n, l) => n + l.amount, 0));
    return { scope, delivered };
  };

  // Delivering: window open, parts shipping, more expected.
  for (let i = 0; i < 6; i++) {
    const a = take(); const start = addDays(TODAY, -ri(30, 90));
    const { scope, delivered } = scopeAndDelivered(a, start, TODAY, ri(3, 7));
    if (!delivered) continue;
    const value = money(delivered / (0.3 + rnd() * 0.45));
    const remaining = money(value - delivered);
    deals.push(base(a, pick(titles), { dateCreated: iso(start), revenuePotential: value, dealConfidence: chance(0.6) ? String(pick([50, 60, 70, 80, 90])) : "",
      scopeItems: scope, upcomingOrders: [uo(remaining * 0.6, daysOut(ri(7, 30)), "customer", scope.slice(0, 3)), uo(remaining * 0.4, daysOut(ri(31, 70)), "estimate")] }));
  }
  // Kept: window closed, delivered at or above 95%.
  for (let i = 0; i < 4; i++) {
    const a = take(); const start = addDays(TODAY, -ri(150, 240)); const end = addDays(TODAY, -ri(45, 90));
    const { scope, delivered } = scopeAndDelivered(a, start, end, ri(3, 6));
    if (!delivered) continue;
    deals.push(base(a, pick(titles), { dateCreated: iso(start), revenuePotential: money(delivered * 0.97), dealConfidence: "90", scopeItems: scope, upcomingOrders: [uo(delivered * 0.97, iso(end), "customer", scope.slice(0, 2))], lastContact: iso(end) }));
  }
  // Quoted: a quote went out, an order is expected, nothing shipped yet.
  for (let i = 0; i < 5; i++) {
    const a = take(); const c = a._customer; const parts = c.basket.slice(0, ri(2, 5));
    const scope = parts.map((it) => ({ id: `li_${hex(16)}`, itemNo: it.item_no, qty: ri(...it.qtyTypical), desc: it.description, unitPrice: money(it.price * (1 - TIER_DISC[c.tier])) }));
    const value = money(scope.reduce((n, s) => n + s.qty * s.unitPrice, 0) * ri(2, 6));
    deals.push(base(a, pick(titles), { dateCreated: daysAgo(ri(5, 40)), revenuePotential: value, dealConfidence: chance(0.5) ? String(pick([40, 50, 60])) : "", scopeItems: scope, upcomingOrders: [uo(value, daysOut(ri(10, 45)), chance(0.5) ? "customer" : "estimate", scope)] }));
  }
  // Promised: just a named buyer and a number. One has no buyer, for the nudge.
  for (let i = 0; i < 4; i++) {
    const a = take();
    deals.push(base(a, pick(titles), { dateCreated: daysAgo(ri(2, 25)), revenuePotential: money(ri(8, 60) * 1000), dealConfidence: "", buyerContactId: i === 0 ? null : (contactsByAccount.get(a.id) || [])[0]?.id || null }));
  }
  // The window closed short and nobody has answered yet.
  for (let i = 0; i < 2; i++) {
    const a = take(); const start = addDays(TODAY, -ri(90, 140)); const end = addDays(TODAY, -ri(20, 45));
    const { scope, delivered } = scopeAndDelivered(a, start, end, ri(2, 5));
    const value = money(Math.max(delivered * 2.2, 15000));
    deals.push(base(a, pick(titles), { dateCreated: iso(start), revenuePotential: value, dealConfidence: "70", scopeItems: scope, upcomingOrders: [uo(value, iso(end), "customer", scope)] }));
  }
  // One pushed, one broken, answered by the rep.
  {
    const a = take(); const start = addDays(TODAY, -120); const end = addDays(TODAY, -30);
    const { scope } = scopeAndDelivered(a, start, TODAY, 3);
    deals.push(base(a, "Stack order slipped to next quarter", { dateCreated: iso(start), revenuePotential: 42000, dealConfidence: "50", scopeItems: scope, upcomingOrders: [uo(42000, iso(end), "customer", scope)], commitmentOutcome: "pushed", commitmentOutcomeAt: daysAgo(12) + "T15:20:00Z" }));
    const b = take(); const s2 = addDays(TODAY, -160); const e2 = addDays(TODAY, -50);
    deals.push(base(b, "Muffler program lost on price", { dateCreated: iso(s2), revenuePotential: 27500, dealConfidence: "20", scopeItems: [], upcomingOrders: [uo(27500, iso(e2), "estimate")], commitmentOutcome: "broken", commitmentOutcomeAt: daysAgo(40) + "T17:05:00Z" }));
  }
  // Two big ones the operations trigger cares about: customer-given dates and part lines.
  for (let i = 0; i < 2; i++) {
    const a = take(); const c = a._customer; const parts = c.basket.filter((it) => it.family === "stack" || it.family === "elbow").slice(0, 6);
    if (parts.length < 2) continue;
    const scope = parts.map((it) => ({ id: `li_${hex(16)}`, itemNo: it.item_no, qty: ri(20, 80), desc: it.description, unitPrice: money(it.price * (1 - TIER_DISC[c.tier])) }));
    const value = money(Math.max(90000, scope.reduce((n, s) => n + s.qty * s.unitPrice, 0) * 3));
    deals.push(base(a, i === 0 ? "Fleet-wide chrome stack refit" : "Annual elbow supply agreement", { dateCreated: daysAgo(ri(10, 40)), revenuePotential: value, dealConfidence: "75", scopeItems: scope,
      upcomingOrders: [uo(value * 0.5, daysOut(ri(15, 35)), "customer", scope.slice(0, 4)), uo(value * 0.5, daysOut(ri(50, 80)), "customer", scope.slice(2))] }));
  }
  // One legacy-shaped deal that predates the model: a stage and a probability, no confidence.
  {
    const a = take();
    deals.push(base(a, "Legacy pursuit from the old pipeline", { dateCreated: daysAgo(210), revenuePotential: 18000, stage: "Negotiation", probability: 75, closeDate: daysOut(20), dealConfidence: "" }));
  }
  return deals;
}

// ---------------------------------------------------------------------------
// The Jet "Open Sales Lines" report: today's open order book, plus
// yesterday's for the day-over-day view.
// ---------------------------------------------------------------------------
function buildJet(customers, items, deals) {
  const active = customers.filter((c) => !c.blocked && c.code !== "CLOSED" && c.lifecycle !== "churned" && c.lifecycle !== "dormant");
  const orders = []; let doc = 481200;
  const nOrders = 128;
  for (let i = 0; i < nOrders; i++) {
    const c = pick(active); const lateish = chance(0.36);
    const ship = lateish ? addDays(TODAY, -ri(1, 26)) : addDays(TODAY, ri(1, 42));
    const taken = addDays(ship, -ri(3, 21));
    const partial = chance(0.4);
    const nLines = ri(1, 6);
    const lines = [];
    const pool = [...c.basket, ...(chance(0.3) ? [pick(items.filter((it) => it.madeToOrder))] : [])];
    for (let k = 0; k < nLines; k++) {
      const it = pick(pool); if (lines.some((l) => l.it === it)) continue;
      const qty = ri(...it.qtyTypical);
      const shippedSome = partial && chance(0.3);
      const outstanding = shippedSome ? Math.max(1, qty - ri(1, Math.max(1, qty - 1))) : qty;
      lines.push({ it, qty, outstanding, unit: money(it.price * (1 - TIER_DISC[c.tier])) });
    }
    orders.push({ doc: String(doc++), c, ship, taken, partial, lines, po: `PO-${ri(48000, 49999)}`, agent: c.ownCarrier ? "CUSTOMER PICKUP" : pick(["XPO", "UPS", "FEDEX", "SAIA"]) });
  }
  // Make the shelf genuinely short on some of the parts in demand.
  const demand = new Map();
  for (const o of orders) for (const l of o.lines) demand.set(l.it, (demand.get(l.it) || 0) + l.outstanding);
  for (const [it, d] of demand) if (!it.madeToOrder && chance(0.28)) { it.qoh_gr = Math.max(0, Math.floor(d * (0.2 + rnd() * 0.6))); it.qoh = it.qoh_gr + (chance(0.4) ? ri(1, 20) : 0); }

  const rowsFor = (os, qohShift = 0) => os.flatMap((o) => o.lines.map((l, idx) => ({
    document_no: o.doc, line_no: idx + 1, customer_no: o.c.customer_no, customer_name: o.c.name, salesperson_code: o.c.code, order_status: pick(["Released", "Released", "Open"]), location_code: "MAIN", shelf_no: l.it.shelf, bin_code: l.it.bin,
    order_taken_on: iso(o.taken), shipment_date: iso(o.ship), item_no: l.it.item_no, item_description: l.it.description, item_category: l.it.category, product_group: l.it.productGroup, quantity: l.qty, outstanding_qty: l.outstanding, uom: "PCS",
    unit_price: l.unit, unit_cost: l.it.cost, outstanding_amount: money(l.outstanding * l.unit), qoh: Math.max(0, l.it.qoh + qohShift), qoh_gr: Math.max(0, l.it.qoh_gr + qohShift), partial: o.partial, replenishment: l.it.replenishment, work_center: l.it.work_center,
    external_document: o.po, shipping_agent: o.agent, payment_terms: "NET30", blocked: false, ship_to_country_region_code: o.c.country, sell_to_country_region_code: o.c.country,
  })));
  const today = rowsFor(orders);
  // Yesterday: six orders that have since shipped are still open, three of today's orders had not been taken yet, stock was a little different.
  const yesterdayOrders = [...orders.slice(3), ...orders.slice(0, 6).map((o) => ({ ...o, doc: String(Number(o.doc) - 300) }))];
  const yesterday = rowsFor(yesterdayOrders, 4);
  return { orders, today, yesterday };
}

// ---------------------------------------------------------------------------
// Assemble the world.
// ---------------------------------------------------------------------------
export function buildWorld() {
  const customers = buildCustomers();
  const items = buildItems();
  const { records, accountByCustomer, contactsByAccount } = buildRecords(customers);
  const { skuLines, shipments, custLedger, invoices } = buildLedgers(customers, items, accountByCustomer);
  const deals = buildDeals(records, customers, shipments, contactsByAccount);
  const jet = buildJet(customers, items, deals);

  // Stats the legacy JSON carries, lifetime sales on the customer master, open orders on each account.
  const byAcct = new Map();
  for (const s of shipments) { const id = accountByCustomer.get(s.customer.customer_no); const y = s.date.getUTCFullYear(); const m = byAcct.get(id) || {}; m[y] = money((m[y] || 0) + s.total); byAcct.set(id, m); }
  for (const r of records) if (r.data.category === "Account Management") { const m = byAcct.get(r.id) || {}; r.data.stat2025 = m[YEAR - 1] || 0; r.data.stat2026YTD = m[YEAR] || 0; }
  for (const c of customers) c.lifetime_sales = money(shipments.filter((s) => s.customer === c).reduce((n, s) => n + s.total, 0));
  const ordersByCustomer = new Map();
  for (const o of jet.orders) { const k = o.c.customer_no; if (!ordersByCustomer.has(k)) ordersByCustomer.set(k, []); ordersByCustomer.get(k).push(o); }
  for (const r of records) if (r.data.category === "Account Management") {
    const nums = [r._customer.customer_no, ...r._branches.map((b) => b.customer_no)];
    const os = nums.flatMap((n) => ordersByCustomer.get(n) || []);
    r.data.openOrders = os.map((o) => ({ orderNum: o.doc, extDocNum: o.po, quoteNum: "", amount: String(money(o.lines.reduce((n, l) => n + l.qty * l.unit, 0))), outstandingAmount: String(money(o.lines.reduce((n, l) => n + l.outstanding * l.unit, 0))), orderDate: iso(o.taken), shipmentDate: iso(o.ship), partial: o.partial, completelyShipped: false }));
    r.data.openOrdersUpdatedAt = os.length ? new Date().toISOString() : null;
  }
  // Activity on accounts: calls and emails the reps logged recently.
  const events = [];
  for (const r of records.filter((x) => x.data.category === "Account Management")) {
    if (r._customer.lifecycle === "churned" || !chance(0.65)) continue;
    for (let i = 0; i < ri(1, 4); i++) {
      const kind = pick(["called", "called", "emailed", "emailed", "met", "voicemail"]);
      const who = r.data.accountOwner === "Unassigned" ? ROSTER[0] : ROSTER.find((u) => u.owner_name === r.data.accountOwner);
      events.push({ id: `ev_${hex(16)}`, account_id: r.id, commitment_id: null, contact_id: null, kind, outcome: kind === "voicemail" ? "no answer" : pick(["reached", "reached", "callback"]), note: pick(["Went over open backorders.", "Sent the updated price sheet.", "Asked for the Q4 forecast.", "Left a message about the chrome lead time.", "Stopped by with the new catalog."]),
        item_nos: [], amount: null, source: "user", actor_email: who.email, actor_name: who.owner_name, reason: null, at: addDays(TODAY, -ri(1, 60)).toISOString(), request_id: null, event_id: null });
    }
  }
  const revenueByYear = {};
  for (const e of custLedger) if (e.document_type === "Invoice" || e.document_type === "Credit Memo") { const y = e.posting_date.slice(0, 4); revenueByYear[y] = money((revenueByYear[y] || 0) + e.amount); }
  const goal = money(Math.round((revenueByYear[YEAR - 1] || 5000000) * 1.2 / 10000) * 10000);
  return { customers, items, records, deals, skuLines, custLedger, invoices, jet, events, revenueByYear, goal };
}

function report(w) {
  const late = w.jet.today.filter((r) => r.shipment_date < iso(TODAY)).length;
  const short = w.jet.today.filter((r) => r.outstanding_qty > r.qoh_gr).length;
  console.log(`customers ${w.customers.length} (chains ${CHAINS.length}, blocked ${w.customers.filter((c) => c.blocked).length}, closed ${w.customers.filter((c) => c.code === "CLOSED").length}, new ${w.customers.filter((c) => c.lifecycle === "new").length})`);
  console.log(`items ${w.items.length} (made to order ${w.items.filter((i) => i.madeToOrder).length}, purchased ${w.items.filter((i) => i.replenishment === "Purchase").length}, proprietary ${w.items.filter((i) => i.isProprietary).length})`);
  console.log(`records ${w.records.length} accounts+agencies+reps, deals ${w.deals.length}`);
  console.log(`item ledger lines ${w.skuLines.length}, customer ledger entries ${w.custLedger.length}, invoices ${w.invoices.length}`);
  console.log(`revenue by year ${JSON.stringify(w.revenueByYear)}, goal ${w.goal}`);
  console.log(`jet today ${w.jet.today.length} lines / ${w.jet.orders.length} orders (${late} late lines, ${short} short before allocation); yesterday ${w.jet.yesterday.length} lines`);
  console.log(`activity events ${w.events.length}`);
  const dealKinds = {}; for (const d of w.deals) { const k = d.data.commitmentOutcome || (d.data.stage ? "legacy" : d.data.upcomingOrders.length ? (d.data.scopeItems.length ? "scoped+orders" : "orders") : "promised"); dealKinds[k] = (dealKinds[k] || 0) + 1; }
  console.log(`deal shapes ${JSON.stringify(dealKinds)}`);
}

// ---------------------------------------------------------------------------
// Loading. Column lists are explicit so generated columns are left alone.
// ---------------------------------------------------------------------------
function readEnv() {
  const candidates = [join(HERE, "..", ".env.local"), join(HERE, "..", "..", "grcrm-svelte", ".env.local")];
  for (const p of candidates) if (existsSync(p)) {
    const env = Object.fromEntries(readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
    if (env.DEMO_DB_URL) return env;
  }
  throw new Error("No DEMO_DB_URL found. Put it in grcrm-demo/.env.local (see the setup note).");
}

async function insertRows(client, table, rows, chunk = 1000) {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]).filter((k) => !k.startsWith("_"));
  const list = cols.map((c) => `"${c}"`).join(", ");
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : r[c]])));
    await client.query(`insert into public."${table}" (${list}) select ${list} from json_populate_recordset(null::public."${table}", $1::json)`, [JSON.stringify(slice)]);
  }
  return rows.length;
}

async function main() {
  const w = buildWorld();
  report(w);
  if (CHECK) return;

  const { default: pg } = await import("pg");
  const env = readEnv();
  const client = new pg.Client({ connectionString: env.DEMO_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const t0 = Date.now();
  try {
    await client.query("begin");
    // Act as the admin for the functions that check who is calling, and tell
    // the direct-write audit trigger this is the API, not a stray write.
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('gr.api', '1', true)", [JSON.stringify({ email: ADMIN.email, role: "authenticated", sub: "00000000-0000-4000-8000-000000000001" })]);

    // Wipe. Only tables that exist, only demo-owned data.
    const wipe = ["records", "accounts", "commitments", "contacts", "notes", "next_steps", "locations", "quotes", "upcoming_orders", "line_items", "po_log", "reps", "channels",
      "sku_transactions", "customer_ledger", "invoices", "bc_customers", "items", "item_master_lines", "item_master_snapshots", "item_master_staging", "vendors", "open_sales_lines", "open_sales_snapshots",
      "kit_components", "account_events", "nudges", "audit_events", "import_batches", "user_permissions", "revenue_goals", "mirror_failures", "write_requests", "agent_cards", "proposals", "reactions", "reorder_suppressions", "refresh_requests", "system_events", "chat_sessions", "user_memories", "account_memories",
      // Company data that migrations seed (promo schedule, discount codes, event programs) must not survive into the demo.
      "promos", "promo_codes", "promo_signoffs", "promo_departments", "promo_cover", "events", "event_costs", "event_attendees", "event_milestones", "event_leads", "event_transitions", "event_programs", "sales_drafts", "sales_draft_lines", "price_sheets", "draft_edits", "account_funnel", "bc_export_files", "hard_truths_notes", "account_emails"];
    const { rows: existing } = await client.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name = any($1)", [wipe]);
    const names = existing.map((r) => `public."${r.table_name}"`);
    if (names.length) await client.query(`truncate table ${names.join(", ")} restart identity cascade`);

    await insertRows(client, "user_permissions", ROSTER);
    await insertRows(client, "revenue_goals", [{ year: YEAR, scope: "company", goal: w.goal, set_by: "Owen", notes: "120% of last year", updated_at: new Date().toISOString() }]);
    await insertRows(client, "vendors", VENDORS.map((v) => ({ vendor_no: v.vendor_no, name: v.name, search_name: v.name.toUpperCase(), contact: personName(), phone: "", email: "", city: v.city, state: v.state, country_region_code: "US", lead_time_calculation: v.lead, purchaser_code: "PIC", payment_terms_code: "NET30", shipment_method_code: "GROUND", vendor_posting_group: "DOMESTIC", blocked: "", purchases_amount: money(ri(20, 400) * 1000), balance_amount: money(ri(0, 60) * 1000), last_date_modified: daysAgo(ri(1, 90)), source_file: "Vendor List.xlsx", loaded_at: new Date().toISOString() })));
    await insertRows(client, "bc_customers", w.customers.map((c) => ({ customer_no: c.customer_no, name: c.name, bill_to_customer_no: c.bill_to_customer_no, chain_name: c.country === "US" ? (["TX", "OK", "LA", "AR", "NM", "CO", "MT", "WY", "UT", "ID", "WA", "OR", "NV", "AZ", "CA"].includes(c.state) ? "WEST" : "EAST") : c.country === "CA" ? "CANADA" : "EXPORT",
      salesperson_code: c.code, city: c.city, state: c.state, blocked: c.blocked, lifetime_sales: c.lifetime_sales, rep_group: c.group, salesperson_name: c.rep, loaded_at: new Date().toISOString(), country_region_code: c.country })));
    await insertRows(client, "items", w.items.map((it) => ({ item_no: it.item_no, description: it.description, category: it.category, unit_cost: it.cost, unit_price: it.price, standard_cost: it.cost, updated_at: new Date().toISOString(), product_group: it.productGroup })));
    // The item master goes through the same function the Items upload uses.
    const master = w.items.map((it) => ({ item_no: it.item_no, description: it.description, search_description: it.description, item_category_code: it.category, product_group_code: it.productGroup, inventory_posting_group: it.posting, uom: "PCS",
      qoh: String(it.qoh), qoh_gr: String(it.qoh_gr), on_sales_order: "0", on_purch_order: String(it.on_purch_order), on_prod_order: String(it.on_prod_order), unit_cost: String(it.cost), unit_price: String(it.price), sales_qty_year: String(ri(0, 900)), sales_amount: "",
      center_line_radius: it.family === "elbow" ? `${ri(6, 12)}` : "", lead_time_calculation: it.lead, replenishment_system: it.replenishment, work_center: it.work_center, shelf_no: it.shelf, vendor_no: it.vendor_no, made_to_order: it.madeToOrder ? "Yes" : "No", available_online: "No", substitutes_exist: "No", catalog_item: "", blocked: it.blocked ? "Yes" : "No", last_modified: daysAgo(ri(1, 120)) }));
    const masterJson = JSON.stringify(master);
    await client.query("select public.gr_item_master_import($1::jsonb, $2, $3, now(), 'upload', $4)", [masterJson, "Items.xlsx", createHash("sha256").update(masterJson).digest("hex"), randomUUID()]);
    // No kit bill of materials: no migration creates kit_components yet, and a
    // failed insert inside this transaction would abort everything after it.

    // Records first (the mirror trigger fills the relational tables), then the ledgers.
    await insertRows(client, "records", [...w.records, ...w.deals].map((r) => ({ id: r.id, owner: r.owner, data: r.data, created_at: r.created_at, updated_at: r.updated_at })), 200);
    await insertRows(client, "sku_transactions", w.skuLines, 2000);
    await insertRows(client, "customer_ledger", w.custLedger, 2000);
    await insertRows(client, "invoices", w.invoices, 1000);
    await insertRows(client, "account_events", w.events);
    await insertRows(client, "import_batches", [
      { id: "imp_seed_ledger", kind: "ledger", label: "Item ledger", file_name: `Item Ledger Entries ${iso(TODAY)}.xlsx`, imported_at: new Date().toISOString(), imported_by: "Owen", counts: { lines: w.skuLines.length, matched: w.skuLines.length, unmatched: 0, errors: 0 }, undoable: false },
      { id: "imp_seed_custledger", kind: "customer_ledger", label: "Customer ledger", file_name: `Customer Ledger Entries ${iso(TODAY)}.xlsx`, imported_at: new Date().toISOString(), imported_by: "Owen", counts: { entries: w.custLedger.length, matched: w.custLedger.length, unmatched: 0, errors: 0 }, undoable: false },
      { id: "imp_seed_invoices", kind: "invoices", label: "Posted invoices", file_name: `Posted Sales Invoices ${iso(TODAY)}.xlsx`, imported_at: new Date().toISOString(), imported_by: "Owen", counts: { invoices: w.invoices.length, matched: w.invoices.length, unmatched: 0 }, undoable: false },
      { id: "imp_seed_backlog", kind: "backlog", label: "Open sales orders", file_name: `Sales Orders ${iso(TODAY)}.xlsx`, imported_at: new Date().toISOString(), imported_by: "Owen", counts: { order_lines: w.jet.orders.length, accounts: 40, cleared: 3, errors: 0 }, undoable: false },
    ]);

    // The Jet snapshots, yesterday then today, through the real import function.
    for (const [rows, when, label] of [[w.jet.yesterday, addDays(TODAY, -1), "yesterday"], [w.jet.today, TODAY, "today"]]) {
      const json = JSON.stringify(rows);
      const taken = new Date(when); taken.setUTCHours(11, 0, 0, 0);
      const { rows: out } = await client.query("select public.gr_wh_import($1::jsonb, $2, $3, $4, 'upload', $5) as r", [json, `Open Sales Lines ${iso(when)}.xlsx`, createHash("sha256").update(json).digest("hex"), taken.toISOString(), randomUUID()]);
      console.log(`jet ${label}:`, JSON.stringify(out[0].r).slice(0, 300));
    }
    await client.query("commit");
    console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }

  // Outside the seeding transaction and without a JWT, so the refresh runs as the nightly job would.
  const t1 = Date.now();
  await client.query("set statement_timeout = '1800s'");
  const { rows: rr } = await client.query("select public.gr_nightly_refresh() as r");
  const failed = rr[0].r?.failed; console.log(`nightly refresh: ${failed} failed, ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (failed) console.log(JSON.stringify(rr[0].r).slice(0, 2000));
  for (const fn of ["gr_nightly_nudges", "gr_answer_pushed_windows", "gr_propose_next_steps"]) {
    try { await client.query(`select public.${fn}()`); console.log(`${fn} ok`); } catch (e) { console.log(`${fn}: ${e.message.split("\n")[0]}`); }
  }
  const { rows: counts } = await client.query(`select (select count(*) from public.accounts where deleted_at is null) accounts, (select count(*) from public.commitments where deleted_at is null) deals, (select count(*) from public.contacts) contacts, (select count(*) from public.next_steps) steps,
    (select count(*) from public.sku_transactions) item_lines, (select count(*) from public.customer_ledger) ledger, (select count(*) from public.v_commitments_board) board, (select count(*) from public.nudges) nudges, (select count(*) from public.mirror_failures) mirror_failures`);
  console.log(JSON.stringify(counts[0]));
  await client.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
