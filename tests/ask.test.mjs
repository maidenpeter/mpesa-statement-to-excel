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

for (const name of ["clean_month.pdf", "fuliza.pdf", "multi_page.pdf"]) {
  test(`${name}: lookups by receipt, amount, date, number and direction list exactly the rows that fit`, async () => {
    const e = EXPECT.statements[name];
    const { rows, s } = await read(name, e.password ? EXPECT.password : null);
    const x = e.rows;
    const find = (text) => {
      const m = Ask.match(text, rows);
      assert.ok(m && m.id === "find", `"${text}" is a lookup: ${JSON.stringify(m)}`);
      return Ask.answer("find", rows, s, m.slot);
    };
    const count = (a) => (a.table ? a.table.rows.length : 0);
    const cap = (n) => Math.min(n, 100);

    // every receipt: its rows, a payment's charge included
    for (const rc of [...new Set(x.map((r) => r.receipt))].slice(0, 25)) {
      assert.equal(count(find("find receipt " + rc)), x.filter((r) => r.receipt === rc).length, rc);
      assert.equal(count(find(rc.toLowerCase())), x.filter((r) => r.receipt === rc).length, rc + " typed in lower case");
    }
    // every amount that is not a charge, typed with its cents
    const amounts = [...new Set(x.filter((r) => !CHARGES.includes(r.type)).map((r) => r.paidIn || r.withdrawn))].slice(0, 25);
    for (const v of amounts) {
      const n = x.filter((r) => Math.abs((r.paidIn || r.withdrawn) - v) < 0.005).length;
      assert.equal(count(find(v.toFixed(2))), cap(n), `amount ${v}`);
    }
    // every day, written two ways
    for (const d of [...new Set(x.map((r) => r.time.slice(0, 10)))].slice(0, 15)) {
      const n = x.filter((r) => r.time.startsWith(d)).length;
      assert.equal(count(find("transactions on " + d)), cap(n), d);
      assert.equal(count(find(`${+d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`)), cap(n), d + " as day/month/year");
      assert.equal(count(find(`what happened on ${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`)), cap(n), d + " in words");
    }
    // a full phone number against the masked number the statement prints
    for (const id of [...new Set(x.map((r) => r.partyId).filter((v) => /^07\d\d\*+\d{3}$/.test(v)))].slice(0, 5)) {
      const full = id.slice(0, 4) + "123" + id.slice(-3);
      const a = find(full);
      assert.equal(count(a), cap(x.filter((r) => r.partyId === id).length), full);
      assert.ok(a.say.join(" ").includes(id), `${full}: the answer names the number as printed`);
      assert.equal(count(find("+254" + full.slice(1))), count(a), "+254" + full.slice(1));
    }
    // direction and comparisons, with the totals
    const out = x.filter((r) => r.withdrawn > 1000), inn = x.filter((r) => r.paidIn > 5000), mid = x.filter((r) => r.withdrawn >= 500 && r.withdrawn <= 1000);
    const a1 = find("payments over 1,000");
    assert.equal(count(a1), cap(out.length));
    if (out.length) assert.ok(a1.say[0].includes(fmt(r2(out.reduce((t, r) => t + r.withdrawn, 0)))), a1.say[0]);
    assert.equal(count(find("received more than 5k")), cap(inn.length));
    assert.equal(count(find("payments between 500 and 1000")), cap(mid.length));
    // a month: what was paid out in it
    const month = x[0].time.slice(0, 7), mm = MONTHS[+month.slice(5) - 1];
    const spent = x.filter((r) => r.time.startsWith(month) && r.withdrawn > 0);
    const a2 = find(`how much did I spend in ${mm} ${month.slice(0, 4)}`);
    assert.equal(count(a2), cap(spent.length));
    assert.ok(a2.say[0].includes(fmt(r2(spent.reduce((t, r) => t + r.withdrawn, 0)))), a2.say[0]);
    // an account number on a paybill payment
    const acc = x.find((r) => r.account);
    if (acc) assert.equal(count(find(acc.account)), x.filter((r) => r.account === acc.account).length, acc.account);
    // nothing fits: said so, with the nearest amounts on the statement
    const none = find("show 98765.43");
    assert.equal(none.table, null);
    assert.match(none.say[0], /^No transaction on this statement matches/);
    assert.match(none.say[1], /^The nearest amounts on it are KSh/);
    // the examples offered are lookups that find something
    for (const t of Ask.examples(rows)) {
      const m = Ask.match(t, rows);
      assert.ok(m && count(Ask.answer(m.id, rows, s, m.slot)) > 0, `example "${t}" finds rows`);
    }
  });
}

test("lookups leave the other questions alone, and names stay names", async () => {
  const { rows } = await read("clean_month.pdf");
  const id = (t) => (Ask.match(t, rows) || {}).id || null;
  assert.equal(id("what were my 5 biggest payments"), "big-out");
  assert.equal(id("top 3 people I paid the most"), "top-out");
  assert.equal(id("which month did I spend the most"), "months");
  const someone = rows.find((r) => r.type === "Send money" && r.party);
  const first = someone.party.split(" ")[0].toLowerCase();
  assert.equal(id("how much did I send to " + first), "party");
  const m = Ask.match("show payments to " + first, rows);
  assert.equal(m.id, "find");
  assert.ok(m.slot.party === someone.party.toUpperCase() + "|" + someone.partyId && m.slot.dir === "out");
  // a person called June: "to june" is the person, "in june" is the month
  const june = rows.map((r) => (r === someone ? { ...r, party: "JUNE TESTER", details: r.details.replace(someone.party, "JUNE TESTER") } : r));
  assert.equal((Ask.match("payments to june", june) || {}).id, "party");
  assert.deepEqual(Ask.match("payments in june", june).slot.date, { mm: "06" });
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
