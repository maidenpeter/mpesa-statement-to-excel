/* Questions about a statement, answered from its own rows, in this browser. Browser: window.MpesaAsk.
   Node: module.exports. There is no language model: each question is a calculation on the transactions, and
   every answer lists the rows behind it, so it can be checked against the statement line by line. */
(function (root) {
  "use strict";

  const r2 = (v) => Math.round(v * 100) / 100;
  const total = (list, f) => r2(list.reduce((a, x) => a + f(x), 0));
  const money = (v) => (v < 0 ? "-" : "") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ksh = (v) => "KSh " + money(v);
  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + "%" : "0.0%");
  const when = (ts) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
  const day = (ts) => new Date(ts).toISOString().slice(0, 10);
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const monthOf = (ts) => new Date(ts).toISOString().slice(0, 7);
  const monthName = (k) => MONTHS[+k.slice(5, 7) - 1] + " " + k.slice(0, 4);
  const isCharge = (r) => r.type === "Transaction charge" || r.type === "Fuliza fee";
  const plural = (n, one, many) => n.toLocaleString("en-US") + " " + (n === 1 ? one : many || one + "s");
  const TOP = 10;

  // the transactions behind an answer: date, receipt, details, money in, money out, balance after
  const txTable = (list) => ({
    head: ["Date", "Receipt", "Details", "In", "Out", "Balance"],
    num: [3, 4, 5],
    rows: list.map((r) => [when(r.ts), r.receipt, r.details, r.paidIn ? money(r.paidIn) : "", r.withdrawn ? money(r.withdrawn) : "",
      r.balance != null ? money(r.balance) : ""]),
  });

  // everyone money went to or came from, as the statement names them
  function parties(rows) {
    const map = new Map();
    for (const r of rows) {
      if (!r.party) continue;
      const key = r.party.toUpperCase() + "|" + r.partyId;
      const p = map.get(key) || { key, party: r.party, partyId: r.partyId, n: 0, in: 0, out: 0 };
      p.n++; p.in = r2(p.in + r.paidIn); p.out = r2(p.out + r.withdrawn);
      map.set(key, p);
    }
    return [...map.values()].sort((a, b) => b.in + b.out - (a.in + a.out) || a.key.localeCompare(b.key));
  }
  const partyLabel = (p) => p.party + (p.partyId ? " (" + p.partyId + ")" : "");
  const rowsOf = (rows, key) => rows.filter((r) => r.party && r.party.toUpperCase() + "|" + r.partyId === key);

  function types(rows) {
    const map = new Map();
    for (const r of rows) {
      const t = map.get(r.type) || { type: r.type, n: 0, in: 0, out: 0 };
      t.n++; t.in = r2(t.in + r.paidIn); t.out = r2(t.out + r.withdrawn);
      map.set(r.type, t);
    }
    return [...map.values()].sort((a, b) => b.in + b.out - (a.in + a.out) || a.type.localeCompare(b.type));
  }

  const QUESTIONS = [
    { id: "where", text: "Where did my money go?", kw: ["where", "spend", "spent", "money go", "went", "categor", "breakdown"] },
    { id: "top-out", text: "Who did I pay the most?", kw: ["pay the most", "paid the most", "send the most", "sent the most", "who did i pay", "who did i send", "most to", "top recipient"] },
    { id: "top-in", text: "Who sent me the most?", kw: ["sent me", "who paid me", "received the most", "most from", "top sender", "income", "who gave"] },
    { id: "charges", text: "How much did I pay in charges and fees?", kw: ["charge", "fee", "cost", "transaction cost", "commission"] },
    { id: "fuliza", text: "How much Fuliza did I use?", kw: ["fuliza", "overdraft", "borrow", "loan"] },
    { id: "big-out", text: "What were my biggest payments?", kw: ["biggest payment", "largest payment", "biggest", "largest", "expensive", "big payment"] },
    { id: "big-in", text: "What were my biggest receipts?", kw: ["biggest receipt", "largest receipt", "biggest deposit", "largest deposit", "biggest income", "most i received"] },
    { id: "months", text: "Which month did I spend the most?", kw: ["month", "monthly", "which month", "when did i spend"] },
    { id: "balance", text: "What was my lowest balance, and when?", kw: ["balance", "lowest", "highest", "minimum", "maximum", "low", "ran out"] },
    { id: "checks", text: "Did every balance add up?", kw: ["add up", "reconcile", "check", "correct", "missing", "match", "accurate"] },
    { id: "party", text: "How much did I send to or get from someone?", slot: "party", kw: ["how much did i send to", "sent to", "send to", "from", "with"] },
    { id: "type", text: "How much went on one kind of transaction?", slot: "type", kw: ["how much on", "kind", "spent on", "airtime", "paybill", "buy goods", "withdrawal", "deposit", "m-shwari"] },
  ];

  function answer(id, rows, s, slot) {
    const out = rows.filter((r) => r.withdrawn > 0), inn = rows.filter((r) => r.paidIn > 0);
    const q = QUESTIONS.find((x) => x.id === id);
    const a = { id, title: q ? q.text : "", say: [], nums: [], table: null, show: null };
    if (!rows.length) { a.say.push("Add a statement first."); return a; }
    if (id === "where") {
      const t = types(rows).filter((x) => x.out > 0).sort((x, y) => y.out - x.out);
      const all = total(out, (r) => r.withdrawn);
      if (!t.length) { a.say.push("No money went out in this statement."); return a; }
      a.say.push(`Most of your money went on ${t[0].type}: ${ksh(t[0].out)}, ${pct(t[0].out, all)} of the ${ksh(all)} you paid out.`);
      a.nums = [["Money out", ksh(all)], ["Transactions out", plural(out.length, "transaction")]];
      a.table = { head: ["Kind", "Transactions", "Money out", "Share"], num: [1, 2, 3], rows: t.map((x) => [x.type, String(x.n), money(x.out), pct(x.out, all)]) };
      a.show = { dir: "out" };
    } else if (id === "top-out" || id === "top-in") {
      const key = id === "top-out" ? "out" : "in";
      const p = parties(rows).filter((x) => x[key] > 0).sort((x, y) => y[key] - x[key] || x.key.localeCompare(y.key));
      if (!p.length) { a.say.push(id === "top-out" ? "No payments to a named person or business in this statement." : "No money from a named person or business in this statement."); return a; }
      const all = total(id === "top-out" ? out : inn, (r) => (id === "top-out" ? r.withdrawn : r.paidIn));
      a.say.push(id === "top-out"
        ? `You paid the most to ${partyLabel(p[0])}: ${ksh(p[0].out)} over ${plural(rowsOf(rows, p[0].key).filter((r) => r.withdrawn > 0).length, "transaction")}.`
        : `The most came from ${partyLabel(p[0])}: ${ksh(p[0].in)} over ${plural(rowsOf(rows, p[0].key).filter((r) => r.paidIn > 0).length, "transaction")}.`);
      a.nums = [[id === "top-out" ? "Paid to the top " + Math.min(TOP, p.length) : "From the top " + Math.min(TOP, p.length),
        ksh(total(p.slice(0, TOP), (x) => x[key]))], [id === "top-out" ? "All money out" : "All money in", ksh(all)]];
      a.table = { head: ["Name", "Number", "Transactions", id === "top-out" ? "Money out" : "Money in"], num: [2, 3],
        rows: p.slice(0, TOP).map((x) => [x.party, x.partyId, String(x.n), money(x[key])]) };
      a.show = { party: p[0].key, q: p[0].partyId || p[0].party };
    } else if (id === "charges") {
      const c = rows.filter(isCharge);
      const allOut = total(out, (r) => r.withdrawn);
      const fees = total(c.filter((r) => r.type === "Fuliza fee"), (r) => r.withdrawn);
      const tx = total(c.filter((r) => r.type === "Transaction charge"), (r) => r.withdrawn);
      if (!c.length) { a.say.push("No charges or fees in this statement."); return a; }
      a.say.push(`You paid ${ksh(r2(tx + fees))} in charges and fees, ${pct(tx + fees, allOut)} of everything you paid out, over ${plural(c.length, "charge")}.`);
      a.nums = [["Transaction charges", ksh(tx)], ["Fuliza fees", ksh(fees)], ["All money out", ksh(allOut)]];
      a.table = txTable(c.slice().sort((x, y) => y.withdrawn - x.withdrawn || x.ts - y.ts).slice(0, TOP));
      a.note = c.length > TOP ? `The ${TOP} largest of ${c.length} charges.` : "";
      a.show = { type: "Transaction charge" };
    } else if (id === "fuliza") {
      const drawn = rows.filter((r) => r.type === "Fuliza drawn"), paid = rows.filter((r) => r.type === "Fuliza repayment"),
        fees = rows.filter((r) => r.type === "Fuliza fee");
      if (!drawn.length && !paid.length && !fees.length) { a.say.push("There is no Fuliza in this statement."); return a; }
      const d = total(drawn, (r) => r.paidIn), p = total(paid, (r) => r.withdrawn), f = total(fees, (r) => r.withdrawn);
      a.say.push(`You drew ${ksh(d)} of Fuliza ${plural(drawn.length, "time")}, repaid ${ksh(p)} and paid ${ksh(f)} in Fuliza fees.`);
      if (r2(d - p) > 0) a.say.push(`${ksh(r2(d - p))} drawn in this statement was not repaid in it.`);
      a.nums = [["Drawn", ksh(d)], ["Repaid", ksh(p)], ["Fees", ksh(f)]];
      a.table = txTable(rows.filter((r) => r.type.startsWith("Fuliza")));
      a.show = { q: "", type: "Fuliza drawn" };
    } else if (id === "big-out" || id === "big-in") {
      const key = id === "big-out" ? "withdrawn" : "paidIn";
      const list = (id === "big-out" ? out : inn).filter((r) => !isCharge(r)).sort((x, y) => y[key] - x[key] || x.ts - y.ts);
      if (!list.length) { a.say.push(id === "big-out" ? "No payments in this statement." : "No money in, in this statement."); return a; }
      const top = list[0];
      a.say.push(`${id === "big-out" ? "Your biggest payment" : "The biggest amount you received"} was ${ksh(top[key])} on ${day(top.ts)}: ${top.details}.`);
      a.table = txTable(list.slice(0, TOP));
      a.show = { dir: id === "big-out" ? "out" : "in" };
    } else if (id === "months") {
      const m = new Map();
      for (const r of rows) {
        const k = monthOf(r.ts), x = m.get(k) || { k, n: 0, in: 0, out: 0, close: 0 };
        x.n++; x.in = r2(x.in + r.paidIn); x.out = r2(x.out + r.withdrawn); x.close = r.balance;
        m.set(k, x);
      }
      const list = [...m.values()].sort((x, y) => x.k.localeCompare(y.k));
      const top = list.slice().sort((x, y) => y.out - x.out || x.k.localeCompare(y.k))[0];
      a.say.push(`You paid out the most in ${monthName(top.k)}: ${ksh(top.out)}, against ${ksh(top.in)} that came in.`);
      a.table = { head: ["Month", "Transactions", "Money in", "Money out", "Net", "Closing balance"], num: [1, 2, 3, 4, 5],
        rows: list.map((x) => [monthName(x.k), String(x.n), money(x.in), money(x.out), money(r2(x.in - x.out)), x.close != null ? money(x.close) : ""]) };
    } else if (id === "balance") {
      const withBal = rows.filter((r) => r.balance != null);
      const lo = withBal.reduce((p, r) => (r.balance < p.balance ? r : p), withBal[0]);
      const hi = withBal.reduce((p, r) => (r.balance > p.balance ? r : p), withBal[0]);
      a.say.push(`Your lowest balance was ${ksh(lo.balance)}, on ${when(lo.ts)} after ${lo.details}.`);
      a.say.push(`The highest was ${ksh(hi.balance)}, on ${when(hi.ts)}.`);
      a.nums = [["Opening balance", ksh(s.opening)], ["Lowest", ksh(lo.balance)], ["Highest", ksh(hi.balance)], ["Closing balance", ksh(s.closing)]];
      a.table = txTable([lo, hi].sort((x, y) => x.ts - y.ts));
    } else if (id === "checks") {
      const bad = rows.filter((r) => r.check === "Mismatch");
      a.say.push(bad.length
        ? `${plural(bad.length, "row")} ${bad.length === 1 ? "doesn't" : "don't"} follow from the previous balance. A missing page, or a gap between two statements, causes this.`
        : `Yes. Every one of the ${(rows.length - 1).toLocaleString("en-US")} rows after the first follows from the previous balance plus money in minus money out.`);
      if (s.pdfTotals) {
        const ok = Math.abs(s.totalIn - s.pdfTotals.in) < 0.005 && Math.abs(s.totalOut - s.pdfTotals.out) < 0.005;
        a.say.push(ok ? `The totals match the statement's own summary: ${ksh(s.pdfTotals.in)} in and ${ksh(s.pdfTotals.out)} out.`
          : `The totals differ from the statement's summary: it says ${ksh(s.pdfTotals.in)} in and ${ksh(s.pdfTotals.out)} out; the rows add up to ${ksh(s.totalIn)} and ${ksh(s.totalOut)}.`);
      }
      if (bad.length) { a.table = txTable(bad); a.show = { dir: "bad" }; }
    } else if (id === "party") {
      const p = parties(rows).find((x) => x.key === slot) || parties(rows)[0];
      if (!p) { a.say.push("No named person or business in this statement."); return a; }
      const list = rowsOf(rows, p.key);
      a.title = `How much did I send to or get from ${partyLabel(p)}?`;
      a.say.push(`With ${partyLabel(p)}: ${ksh(p.out)} went out and ${ksh(p.in)} came in, over ${plural(list.length, "transaction")}.`);
      a.nums = [["Money out", ksh(p.out)], ["Money in", ksh(p.in)], ["Net", ksh(r2(p.in - p.out))]];
      a.table = txTable(list);
      a.show = { party: p.key, q: p.partyId || p.party };
    } else if (id === "type") {
      const t = types(rows).find((x) => x.type === slot) || types(rows)[0];
      const list = rows.filter((r) => r.type === t.type);
      a.title = `How much went on ${t.type}?`;
      a.say.push(`${t.type}: ${plural(t.n, "transaction")}, ${ksh(t.out)} out and ${ksh(t.in)} in.`);
      a.nums = [["Money out", ksh(t.out)], ["Money in", ksh(t.in)]];
      a.table = txTable(list.slice(0, 50));
      a.note = list.length > 50 ? `The first 50 of ${list.length}. "Show these" lists them all.` : "";
      a.show = { type: t.type };
    }
    return a;
  }

  // A typed question, matched to the nearest question here by its words, and to a name or kind on the statement.
  // Returns null when nothing matches: the page then says so instead of guessing.
  function match(text, rows) {
    const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9*' -]+/g, " ").replace(/\s+/g, " ").trim() + " ";
    if (t.trim().length < 2) return null;
    const hit = (k) => t.includes(" " + k); // at the start of a word, so "fee" is not found in "coffee"
    // A name or number from the statement wins: that question is about someone. A name counts only through a word
    // of its own: not a question's word ("fees" in "SCHOOL FEES" is a question about fees) and not a common one.
    const kws = QUESTIONS.flatMap((q) => q.kw).filter((k) => !k.includes(" "));
    const common = /^(ltd|limited|shop|stores|agencies|agency|company|enterprises|services|school|fees|bank|sacco|prepaid|power|water|online|account|mobile|money|business|payment|customer|merchant|bundles|subscription|insurance|kenya)$/;
    const own = (w) => w.length >= 4 && !common.test(w) && !kws.some((k) => w.startsWith(k));
    const ps = parties(rows);
    const named = ps.find((p) => (p.partyId && p.partyId.length >= 4 && t.includes(p.partyId.toLowerCase())) ||
      p.party.toLowerCase().split(/[\s()/]+/).filter(own).some((w) => hit(w)));
    if (named) return { id: "party", slot: named.key };
    const ty = types(rows).find((x) => hit(x.type.toLowerCase().replace(/ \(till\)| & bundles/g, "")));
    let best = null, bs = 0;
    for (const q of QUESTIONS) {
      if (q.slot) continue;
      const sc = q.kw.filter(hit).length;
      if (sc > bs) { best = q; bs = sc; }
    }
    if (ty && bs < 2) return { id: "type", slot: ty.type };
    return best ? { id: best.id } : null;
  }

  const api = { QUESTIONS, answer, match, parties, types };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MpesaAsk = api;
})(typeof window !== "undefined" ? window : globalThis);
