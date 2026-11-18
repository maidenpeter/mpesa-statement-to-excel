// "Ask about your statement" (lib/ask.js) on the synthetic statements:  node --test tests/
//
// Each statement is read as the page reads it (pdf.js and lib/parser.js); the answers are compared with figures
// worked out here, separately, from the rows in expected.json.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "tests", "fixtures", "synthetic");
const pdfjs = require(path.join(ROOT, "lib", "pdf.min.js"));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(ROOT, "lib", "pdf.worker.min.js");
const parser = require(path.join(ROOT, "lib", "parser.js"));
const Ask = require(path.join(ROOT, "lib", "ask.js"));
const EXPECT = JSON.parse(fs.readFileSync(path.join(FIX, "expected.json"), "utf8"));

async function read(name, password) {
  const data = new Uint8Array(fs.readFileSync(path.join(FIX, name)));
  const pdf = await pdfjs.getDocument({ data, password: password || undefined, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.hypot(it.transform[2], it.transform[3]) })));
  }
  await pdf.destroy();
  const doc = parser.parseDocument(pages, name);
  const rows = parser.combine([doc]);
  return { rows, s: parser.summarize(rows, [doc]) };
}

const fmt = (v) => "KSh " + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (v) => Math.round(v * 100) / 100;
const CHARGES = ["Transaction charge", "Fuliza fee"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const READABLE = Object.entries(EXPECT.statements).filter(([, e]) => !e.error);

for (const [name, e] of READABLE) {
  test(`${name}: answers match figures worked out from the statement's rows`, async () => {
    const { rows, s } = await read(name, e.password ? EXPECT.password : null);
    const x = e.rows;
    const say = (id, slot) => Ask.answer(id, rows, s, slot).say.join(" ");

    const charges = r2(x.filter((r) => CHARGES.includes(r.type)).reduce((a, r) => a + r.withdrawn, 0));
    if (charges) assert.ok(say("charges").includes(fmt(charges)), `charges ${fmt(charges)}: ${say("charges")}`);
    else assert.match(say("charges"), /^No charges/);

    // who was paid the most, by name and number as printed
    const out = new Map();
    for (const r of x) if (r.party && r.withdrawn > 0) {
      const k = r.party.toUpperCase() + "|" + r.partyId;
      out.set(k, { party: r.party, sum: r2(((out.get(k) || {}).sum || 0) + r.withdrawn) });
    }
    const top = [...out.entries()].sort((a, b) => b[1].sum - a[1].sum || a[0].localeCompare(b[0]))[0];
    if (top) assert.ok(say("top-out").includes(top[1].party) && say("top-out").includes(fmt(top[1].sum)), `top payee: ${say("top-out")}`);

    const big = x.filter((r) => r.withdrawn > 0 && !CHARGES.includes(r.type)).sort((a, b) => b.withdrawn - a.withdrawn)[0];
    if (big) assert.ok(say("big-out").includes(fmt(big.withdrawn)), `biggest payment: ${say("big-out")}`);

    const months = new Map();
    for (const r of x) months.set(r.time.slice(0, 7), r2((months.get(r.time.slice(0, 7)) || 0) + r.withdrawn));
    const [mk, mv] = [...months.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    assert.ok(say("months").includes(MONTHS[+mk.slice(5) - 1] + " " + mk.slice(0, 4)) && say("months").includes(fmt(mv)), `month: ${say("months")}`);

    const low = Math.min(...x.map((r) => r.balance));
    assert.ok(say("balance").includes(fmt(low)), `lowest balance ${fmt(low)}: ${say("balance")}`);

    const bad = x.filter((r) => r.check === "Mismatch").length;
    assert.ok(bad ? say("checks").startsWith(`${bad} row`) : say("checks").startsWith("Yes."), say("checks"));

    // every person or business: what went out and came in, and the rows behind it
    const people = new Map();
    for (const r of x) if (r.party) {
      const k = r.party.toUpperCase() + "|" + r.partyId;
      const p = people.get(k) || { out: 0, in: 0, n: 0 };
      p.out = r2(p.out + r.withdrawn); p.in = r2(p.in + r.paidIn); p.n++;
      people.set(k, p);
    }
    for (const [k, p] of people) {
      const a = Ask.answer("party", rows, s, k);
      assert.deepEqual(a.nums.slice(0, 2), [["Money out", fmt(p.out)], ["Money in", fmt(p.in)]], k);
      assert.equal(a.table.rows.length, p.n, `${k}: the rows behind it`);
    }
  });
}

test("fuliza.pdf: Fuliza drawn, repaid and its fees", async () => {
  const { rows, s } = await read("fuliza.pdf");
  const x = EXPECT.statements["fuliza.pdf"].rows;
  const sum = (t, k) => r2(x.filter((r) => r.type === t).reduce((a, r) => a + r[k], 0));
  const a = Ask.answer("fuliza", rows, s);
  assert.deepEqual(a.nums, [["Drawn", fmt(sum("Fuliza drawn", "paidIn"))], ["Repaid", fmt(sum("Fuliza repayment", "withdrawn"))], ["Fees", fmt(sum("Fuliza fee", "withdrawn"))]]);
  assert.equal(a.table.rows.length, x.filter((r) => r.type.startsWith("Fuliza")).length);
  const none = await read("clean_month.pdf");
  assert.match(Ask.answer("fuliza", none.rows, none.s).say[0], /no Fuliza/);
});

test("typed questions find the right answer, and nothing is guessed", async () => {
  const { rows } = await read("clean_month.pdf");
  const id = (t) => (Ask.match(t, rows) || {}).id || null;
  assert.equal(id("How much did I pay in fees?"), "charges");
  assert.equal(id("who did I send the most money to"), "top-out");
  assert.equal(id("who sent me the most"), "top-in");
  assert.equal(id("fuliza"), "fuliza");
  assert.equal(id("what were my biggest payments"), "big-out");
  assert.equal(id("which month did I spend the most"), "months");
  assert.equal(id("what was my lowest balance"), "balance");
  assert.equal(id("did everything reconcile"), "checks");
  assert.equal(id("zzzz qqqq"), null);
  const someone = rows.find((r) => r.type === "Send money" && r.party);
  const m = Ask.match("how much did I send to " + someone.party.split(" ")[0].toLowerCase(), rows);
  assert.deepEqual(m, { id: "party", slot: someone.party.toUpperCase() + "|" + someone.partyId });
  const air = Ask.match("how much did I spend on airtime", rows);
  assert.deepEqual(air, { id: "type", slot: "Airtime & bundles" });
  // a payee called "... SCHOOL FEES" does not turn a question about fees into a question about the school
  const fz = await read("fuliza.pdf");
  assert.ok(Ask.parties(fz.rows).some((p) => /SCHOOL FEES/.test(p.party)));
  assert.equal((Ask.match("how much did I pay in fees?", fz.rows) || {}).id, "charges");
  assert.equal((Ask.match("how much did I pay demo academy", fz.rows) || {}).id, "party");
});
