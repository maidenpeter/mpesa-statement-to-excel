// Parser tests on the synthetic statements:  node --test tests/
//
// Reads each PDF in tests/fixtures/synthetic with the same pdf.js build the page ships (lib/pdf.min.js),
// runs lib/parser.js on it and compares every row and total with expected.json, which tests/make_fixtures.py
// writes from the transactions it generated (not from the parser).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "tests", "fixtures", "synthetic");
const pdfjs = require(path.join(ROOT, "lib", "pdf.min.js"));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(ROOT, "lib", "pdf.worker.min.js");
const parser = require(path.join(ROOT, "lib", "parser.js"));
const excel = require(path.join(ROOT, "lib", "excel.js"));
const EXPECT = JSON.parse(fs.readFileSync(path.join(FIX, "expected.json"), "utf8"));

// The page's own text extraction (lib/app.js, extractPages), copied here; a test below checks it is unchanged.
const MAPPING = "{ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.hypot(it.transform[2], it.transform[3]) }";
async function extract(name, password) {
  const data = new Uint8Array(fs.readFileSync(path.join(FIX, name)));
  const pdf = await pdfjs.getDocument({ data, password: password || undefined, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  let chars = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => {
      chars += it.str.length;
      return { str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.hypot(it.transform[2], it.transform[3]) };
    }));
  }
  const numPages = pdf.numPages;
  await pdf.destroy();
  return { pages, chars, numPages };
}

async function read(name, password) {
  const { pages } = await extract(name, password);
  return parser.parseDocument(pages, name);
}

const close = (a, b, what) => assert.ok(Math.abs(a - b) < 0.005, `${what}: got ${a}, expected ${b}`);
const when = (ts) => new Date(ts).toISOString().slice(0, 19).replace("T", " ");

function compareRows(rows, expected, label) {
  assert.equal(rows.length, expected.length, `${label}: row count`);
  rows.forEach((r, i) => {
    const e = expected[i];
    const at = `${label} row ${i + 1} (${e.receipt})`;
    assert.equal(r.receipt, e.receipt, `${at}: receipt`);
    assert.equal(when(r.ts), e.time, `${at}: completion time`);
    assert.equal(r.details, e.details, `${at}: details`);
    assert.equal(r.status, e.status, `${at}: status`);
    close(r.paidIn, e.paidIn, `${at}: paid in`);
    close(r.withdrawn, e.withdrawn, `${at}: withdrawn`);
    close(r.balance, e.balance, `${at}: balance`);
    assert.equal(r.type, e.type, `${at}: type`);
    assert.equal(r.party, e.party, `${at}: counterparty`);
    assert.equal(r.partyId, e.partyId, `${at}: phone, till or paybill`);
    assert.equal(r.account, e.account, `${at}: account`);
    assert.equal(r.check, e.check, `${at}: balance check`);
  });
}

function compareSummary(s, e, label) {
  for (const k of ["count", "mismatches", "guessed", "name", "mobile", "period"]) assert.equal(s[k], e[k], `${label}: ${k}`);
  for (const k of ["totalIn", "totalOut", "opening", "closing", "charges", "fulizaDrawn", "fulizaRepaid"]) close(s[k], e[k], `${label}: ${k}`);
  if (e.pdfTotals == null) assert.equal(s.pdfTotals, null, `${label}: statement totals`);
  else { close(s.pdfTotals.in, e.pdfTotals.in, `${label}: statement TOTAL in`); close(s.pdfTotals.out, e.pdfTotals.out, `${label}: statement TOTAL out`); }
}

const READABLE = Object.entries(EXPECT.statements).filter(([, e]) => !e.error);

for (const [name, e] of READABLE) {
  test(`${name}: every row and total`, async () => {
    const { pages, numPages } = await extract(name, e.password ? EXPECT.password : null);
    assert.equal(numPages, e.pages, "page count");
    const doc = parser.parseDocument(pages, name);
    assert.ok(doc.newestFirst, "statement printed newest first");
    const rows = parser.combine([doc]);
    compareRows(rows, e.rows, name);
    compareSummary(parser.summarize(rows, [doc]), e.summary, name);
  });
}

test("multi_page.pdf: a row that runs over a page break keeps all its details", async () => {
  const e = EXPECT.statements["multi_page.pdf"];
  assert.ok(e.split_row && e.split_row.lines_on_next_page > 0, "the fixture has a row across a page break");
  const rows = parser.combine([await read("multi_page.pdf")]);
  const got = rows.filter((r) => r.receipt === e.split_row.receipt && when(r.ts) === e.split_row.time);
  const want = e.rows.filter((r) => r.receipt === e.split_row.receipt && r.time === e.split_row.time);
  assert.deepEqual(got.map((r) => r.details), want.map((r) => r.details));
});

test("multi_page.pdf: a payment and its charge printed in the order they happened are put back in balance order", async () => {
  const e = EXPECT.statements["multi_page.pdf"];
  assert.ok(e.pairs_printed_out_of_order > 0, "the fixture prints some pairs out of order");
  const rows = parser.combine([await read("multi_page.pdf")]);
  assert.equal(rows.filter((r) => r.check === "Mismatch").length, 0);
});

test("fuliza.pdf: Fuliza drawn, repaid and its fees", async () => {
  const doc = await read("fuliza.pdf");
  const rows = parser.combine([doc]);
  const s = parser.summarize(rows, [doc]);
  const e = EXPECT.statements["fuliza.pdf"];
  const n = (t) => rows.filter((r) => r.type === t).length;
  const en = (t) => e.rows.filter((r) => r.type === t).length;
  for (const t of ["Fuliza drawn", "Fuliza repayment", "Fuliza fee", "Transaction charge"]) {
    assert.ok(en(t) > 0, `the fixture has ${t} rows`);
    assert.equal(n(t), en(t), t);
  }
  close(s.fulizaDrawn, e.summary.fulizaDrawn, "Fuliza drawn");
  close(s.fulizaRepaid, e.summary.fulizaRepaid, "Fuliza repaid");
  close(s.charges, e.summary.charges, "charges and fees");
});

test("balance_break.pdf: the missing row shows as one mismatch and the totals disagree", async () => {
  const doc = await read("balance_break.pdf");
  const rows = parser.combine([doc]);
  const s = parser.summarize(rows, [doc]);
  const e = EXPECT.statements["balance_break.pdf"];
  assert.equal(s.mismatches, 1);
  const bad = rows.filter((r) => r.check === "Mismatch");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].receipt, e.rows.find((r) => r.check === "Mismatch").receipt);
  close(bad[0].balance - bad[0].expected, -e.dropped_row.withdrawn, "the gap is the dropped payment");
  close(s.pdfTotals.out - s.totalOut, e.dropped_row.withdrawn, "statement TOTAL out less the rows read");
});

test("overlap_a.pdf + overlap_b.pdf: merged once, duplicates removed", async () => {
  const m = EXPECT.merges.overlap;
  const docs = [];
  for (const f of m.files) docs.push(await read(f));
  const fresh = () => docs.map((d) => ({ ...d, rows: d.rows.map((r) => ({ ...r })) }));
  const total = docs.reduce((a, d) => a + d.rows.length, 0);
  const rows = parser.combine(fresh());
  assert.equal(total - rows.length, m.overlapping_rows, "rows in both statements");
  compareRows(rows, m.rows, "merged");
  compareSummary(parser.summarize(rows, fresh()), m.summary, "merged");
  // the order the files are added in does not matter
  const reversed = parser.combine(fresh().reverse());
  assert.deepEqual(reversed.map((r) => r.receipt + r.ts + r.details), rows.map((r) => r.receipt + r.ts + r.details));
});

test("locked.pdf: no password, then a wrong one, then the right one", async () => {
  await assert.rejects(extract("locked.pdf"), (err) => err.name === "PasswordException" && err.code === 1);
  await assert.rejects(extract("locked.pdf", "WRONG000"), (err) => err.name === "PasswordException" && err.code === 2);
  const doc = await read("locked.pdf", EXPECT.password);
  assert.equal(doc.rows.length, EXPECT.statements["locked.pdf"].rows.length);
});

test("scanned.pdf: no text layer, so the page refuses it", async () => {
  const { chars } = await extract("scanned.pdf");
  assert.ok(chars < 20, `pdf.js found ${chars} characters`);
  const app = fs.readFileSync(path.join(ROOT, "lib", "app.js"), "utf8");
  assert.ok(app.includes("if (chars < 20) throw"), "the page's no-text rule is still chars < 20");
  for (const [name, e] of READABLE) assert.ok((await extract(name, e.password ? EXPECT.password : null)).chars >= 20, name);
});

test("CSV export: UTF-8 byte order mark, a header and one line per row", async () => {
  const rows = parser.combine([await read("clean_month.pdf")]);
  const csv = excel.toCSV(rows);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines.length, rows.length + 1);
  assert.match(lines[0], /^Date,Time,Receipt No\.,Details,Type/);
});

test("the test reads PDFs the way the page does", () => {
  const app = fs.readFileSync(path.join(ROOT, "lib", "app.js"), "utf8");
  assert.ok(app.includes(MAPPING), "lib/app.js extractPages changed; update extract() in this file to match");
  assert.ok(app.includes("isEvalSupported: false"));
});

test("vendored libraries and fonts match the hashes in THIRD_PARTY_NOTICES.md", () => {
  const notices = fs.readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
  const files = ["lib/pdf.min.js", "lib/pdf.worker.min.js", "lib/exceljs.min.js"]
    .concat(fs.readdirSync(path.join(ROOT, "fonts")).map((f) => "fonts/" + f));
  assert.ok(files.length >= 12);
  for (const f of files) {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, f))).digest("hex");
    assert.ok(notices.includes("`" + f + "`") && notices.includes(sha), `${f}: ${sha}`);
  }
  // every font the stylesheet asks for is there
  const css = fs.readFileSync(path.join(ROOT, "lib", "app.css"), "utf8");
  for (const m of css.matchAll(/url\(\.\.\/(fonts\/[^)]+)\)/g)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), m[1]);
});
