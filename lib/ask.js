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
    } else if (id === "find") {
      const f = slot || {};
      const list = rows.filter((r) => fits(r, f));
      const what = describe(f, rows);
      const tin = total(list, (r) => r.paidIn), tout = total(list, (r) => r.withdrawn);
      a.title = "Find " + what;
      if (!list.length) {
        a.say.push(`No transaction on this statement matches: ${what}.`);
        if (f.amount && f.amount.op === "eq") {
          const near = rows.filter((r) => !isCharge(r)).map((r) => r.paidIn || r.withdrawn).filter((v) => v > 0)
            .filter((v, i, all) => all.indexOf(v) === i).sort((x, y) => Math.abs(x - f.amount.a) - Math.abs(y - f.amount.a) || x - y).slice(0, 2);
          if (near.length) a.say.push(`The nearest amounts on it are ${near.map(ksh).join(" and ")}.`);
        }
        return a;
      }
      if (list.length === 1) {
        const r = list[0];
        a.say.push(`One transaction matches: ${when(r.ts)}, receipt ${r.receipt}, ${r.details}, ${r.paidIn ? ksh(r.paidIn) + " in" : ksh(r.withdrawn) + " out"}.`);
        if (r.balance != null) a.say.push(`The balance after it was ${ksh(r.balance)}.`);
      } else {
        const sums = f.dir === "out" ? `${ksh(tout)} paid out` : f.dir === "in" ? `${ksh(tin)} received` : `${ksh(tout)} out and ${ksh(tin)} in`;
        a.say.push(`${plural(list.length, "transaction")} match: ${sums}.`);
        const d0 = day(list[0].ts), d1 = day(list[list.length - 1].ts);
        a.say.push(d0 === d1 ? `All on ${d0}.` : `The first on ${d0}, the last on ${d1}.`);
      }
      // a payment's charge carries the same receipt; say what the charges on the payments listed came to
      const charged = rows.filter((r) => isCharge(r) && !list.includes(r) && list.some((x) => x.receipt === r.receipt && !isCharge(x) && x.withdrawn > 0));
      if (charged.length) a.say.push(`The charges on ${list.length === 1 ? "it" : "them"} came to ${ksh(total(charged, (r) => r.withdrawn))}.`);
      if (f.phone) {
        const shown = [...new Set(list.map((r) => r.partyId).filter((x) => x && x.includes("*")))];
        if (shown.length) a.say.push(`The statement prints only the first and last digits of a phone number (${shown.join(", ")}), so this lists every number printed that way.`);
      }
      a.nums = [["Transactions", list.length.toLocaleString("en-US")], ["Money out", ksh(tout)], ["Money in", ksh(tin)]];
      a.table = txTable(list.slice(0, FIND_MAX));
      a.note = list.length > FIND_MAX ? `The first ${FIND_MAX} of ${list.length}. The workbook has all of them.` : "";
      // the transaction list can repeat a lookup that is one piece of text: a receipt, a number or a word
      const pid = f.party ? (parties(rows).find((p) => p.key === f.party) || {}).partyId || "" : "";
      const texts = [f.receipt, ...(f.ids || []), ...(f.words || []), f.party ? pid : null, f.phone ? "" : null].filter((x) => x !== null && x !== undefined);
      if (texts.length === 1 && texts[0] && !f.amount && !f.date && !f.type) a.show = { q: texts[0], dir: f.dir || "" };
    }
    return a;
  }

  // ---------- looking up transactions ----------
  // A typed question can ask for particular rows: a receipt code, a name, a phone, till, paybill or account number,
  // an amount (exact, over, under or between), a date, a range of days or a month, and money in or out. Each part
  // is read from the words typed, and a row must fit every part. Words that are on no row are ignored, so a
  // lookup never matches by guesswork.
  const FIND_MAX = 100;
  const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MONTH_RX = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)";
  const monthNum = (w) => String(MON.indexOf(w.slice(0, 3)) + 1).padStart(2, "0");
  const AMT = "(?:ksh\\.?|kes|sh\\.?)?\\s*(\\d+(?:\\.\\d{1,2})?)(k)?\\b(?!\\s*(?:st|nd|rd|th)\\b)";
  const amt = (v, k) => r2(parseFloat(v) * (k ? 1000 : 1));
  const STOP = new Set(("a about acc account all amount amounts an and any are as at bob by can code date day days did do does done " +
    "each every everything find for from gave get give got had has have how i in is it its last list look lookup made make many " +
    "me money more most mpesa much my name named number numbers of on or paid pay payment payments person phone please receipt " +
    "receipts received receive sent send show search see shillings someone spend spent statement tell than that the there these " +
    "this those time times to transaction transactions up was were what when where which who whom with ksh kes sh till paybill " +
    "business called deposit deposits withdrawal withdrawals withdrew bought buy came incoming income over under above below less " +
    "greater least between bigger larger smaller most also only just one ones out mentioning containing involving").split(" "));

  function fits(r, f) {
    if (f.receipt && r.receipt.toLowerCase() !== f.receipt.toLowerCase()) return false;
    if (f.party && !(r.party && r.party.toUpperCase() + "|" + r.partyId === f.party)) return false;
    if (f.ids && f.ids.length && !f.ids.some((x) => [r.partyId, r.account].some((v) => v && v.toLowerCase() === x.toLowerCase()))) return false;
    if (f.phone && !(r.partyId && phoneFits(r.partyId, f.phone))) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.dir === "in" && !(r.paidIn > 0)) return false;
    if (f.dir === "out" && !(r.withdrawn > 0)) return false;
    if (f.amount) {
      const v = f.dir === "in" ? r.paidIn : f.dir === "out" ? r.withdrawn : r.paidIn || r.withdrawn;
      const { op, a, b } = f.amount;
      if (!(op === "eq" ? Math.abs(v - a) < 0.005 : op === "gt" ? v > a : op === "gte" ? v >= a - 0.005 : op === "lt" ? v > 0 && v < a :
        op === "lte" ? v > 0 && v <= a + 0.005 : v >= a - 0.005 && v <= b + 0.005)) return false;
    }
    if (f.date) {
      const d = day(r.ts);
      if (f.date.from && (d < f.date.from || d > f.date.to)) return false;
      if (f.date.md && !(d.slice(5) >= f.date.md[0] && d.slice(5) <= f.date.md[1])) return false;
      if (f.date.month && monthOf(r.ts) !== f.date.month) return false;
      if (f.date.mm && monthOf(r.ts).slice(5) !== f.date.mm) return false;
      if (f.date.year && day(r.ts).slice(0, 4) !== f.date.year) return false;
    }
    if (f.words && f.words.length) {
      const hay = " " + (r.details + " " + r.party).toLowerCase().replace(/[^a-z0-9*]+/g, " ") + " ";
      if (!f.words.every((w) => hay.includes(" " + w))) return false;
    }
    return true;
  }

  // a full number typed against the masked number a statement prints, such as 0712***678
  const phoneDigits = (s) => { const d = s.replace(/[^0-9]/g, ""); return /^254[17]\d{8}$/.test(d) ? "0" + d.slice(3) : d; };
  function phoneFits(id, p) {
    const m = id.match(/^(\d+)\*+(\d+)$/);
    if (!m) return phoneDigits(id) === p;
    const pre = m[1].startsWith("254") ? "0" + m[1].slice(3) : m[1];
    return p.startsWith(pre) && p.endsWith(m[2]);
  }

  function describe(f, rows) {
    const p = f.party && parties(rows).find((x) => x.key === f.party);
    const parts = [];
    parts.push(f.dir === "out" ? "payments" : f.dir === "in" ? "money received" : "transactions");
    if (f.type) parts.push(`of type ${f.type}`);
    if (f.receipt) parts.push(`with receipt ${f.receipt.toUpperCase()}`);
    if (p) parts.push(`with ${partyLabel(p)}`);
    if (f.phone) parts.push(`with ${f.phone}`);
    if (f.ids && f.ids.length) parts.push(`with ${f.ids.join(" or ")}`);
    if (f.words && f.words.length) parts.push(`mentioning "${f.words.join(" ")}"`);
    if (f.amount) {
      const { op, a, b } = f.amount;
      parts.push(op === "eq" ? `of ${ksh(a)}` : op === "gt" ? `over ${ksh(a)}` : op === "gte" ? `of ${ksh(a)} or more` : op === "lt" ? `under ${ksh(a)}` :
        op === "lte" ? `of ${ksh(a)} or less` : `between ${ksh(a)} and ${ksh(b)}`);
    }
    if (f.date) {
      const d = f.date;
      const dm = (md) => +md.slice(3) + " " + MONTHS[+md.slice(0, 2) - 1];
      parts.push(d.from ? (d.from === d.to ? `on ${d.from}` : `from ${d.from} to ${d.to}`) : d.md ? (d.md[0] === d.md[1] ? `on ${dm(d.md[0])}` : `from ${dm(d.md[0])} to ${dm(d.md[1])}`)
        : d.month ? `in ${monthName(d.month)}` : d.year ? `in ${d.year}` : `in ${MONTHS[+d.mm - 1]}`);
    }
    return parts.join(" ");
  }

  // The parts of a lookup in a typed question, or null when it holds none
  function lookup(text, rows) {
    let t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9*.,:/+' -]+/g, " ").replace(/\s+/g, " ") + " ";
    while (/(\d),(\d{3})/.test(t)) t = t.replace(/(\d),(\d{3})/g, "$1$2");
    const f = {};
    // take a piece out of the question once it is read; fn returns false to leave it in
    const cut = (rx, fn) => { t = t.replace(rx, (...m) => (fn(m) === false ? m[0] : " ")); };
    const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const md = (m, d) => `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const ORD = "(\\d{1,2})(?:st|nd|rd|th)?";
    const nameWords = new Set(parties(rows).flatMap((p) => p.party.toLowerCase().split(/[^a-z]+/)));

    // a receipt code printed on this statement
    const receipts = new Set(rows.map((r) => (r.receipt || "").toLowerCase()).filter(Boolean));
    cut(/\b([a-z0-9]{8,12})\b/g, (m) => {
      if (f.receipt || !receipts.has(m[1])) return false;
      f.receipt = m[1];
    });
    // counts that are not amounts: "top 5", "last 3", "5 biggest"
    cut(/\b(?:top|last|first) \d+\b|\b\d+ (?:biggest|largest|top|highest|lowest|smallest|most|times|months?|days?|weeks?)\b/g, () => true);

    // dates: 2026-01-25, 25/01/2026, a range of days in a month, 25 January (2026), January 25, a month, a year
    cut(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/g, (m) => { f.date = { from: ymd(m[1], m[2], m[3]), to: ymd(m[1], m[2], m[3]) }; });
    cut(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d\d)\b/g, (m) => { f.date = { from: ymd(m[3], m[2], m[1]), to: ymd(m[3], m[2], m[1]) }; });
    cut(new RegExp(`\\b(?:between|from) (?:the )?${ORD} (?:and|to|-) (?:the )?${ORD} (?:of )?${MONTH_RX}(?: (20\\d\\d))?\\b`, "g"), (m) => {
      const mm = monthNum(m[3]);
      f.date = m[4] ? { from: ymd(m[4], mm, m[1]), to: ymd(m[4], mm, m[2]) } : { md: [md(mm, m[1]), md(mm, m[2])] };
    });
    cut(new RegExp(`\\b${ORD} (?:of )?${MONTH_RX}(?: (20\\d\\d))?\\b`, "g"), (m) => {
      const mm = monthNum(m[2]);
      f.date = m[3] ? { from: ymd(m[3], mm, m[1]), to: ymd(m[3], mm, m[1]) } : { md: [md(mm, m[1]), md(mm, m[1])] };
    });
    cut(new RegExp(`\\b${MONTH_RX} ${ORD}(?:,? (20\\d\\d))?\\b(?! ?(?:k\\b|ksh|kes|bob|shillings))`, "g"), (m) => {
      const mm = monthNum(m[1]);
      f.date = m[3] ? { from: ymd(m[3], mm, m[2]), to: ymd(m[3], mm, m[2]) } : { md: [md(mm, m[2]), md(mm, m[2])] };
    });
    cut(new RegExp(`\\b(in |during |for |of )?${MONTH_RX}(?: (20\\d\\d))?\\b`, "g"), (m) => {
      // a month, unless it has no "in" or year before or after it and is someone's name on this statement ("June") or "may"
      if (!m[3] && !m[1] && (nameWords.has(m[2]) || m[2] === "may")) return false;
      const mm = monthNum(m[2]);
      f.date = m[3] ? { month: `${m[3]}-${mm}` } : { mm };
    });
    cut(/\b(?:in|during) (20\d\d)\b/g, (m) => { f.date = { year: m[1] }; });

    // amounts: between, at least, at most, over, under, or exact
    cut(new RegExp(`\\bbetween ${AMT} and ${AMT}`, "g"), (m) => { const a = amt(m[1], m[2]), b = amt(m[3], m[4]); f.amount = { op: "between", a: Math.min(a, b), b: Math.max(a, b) }; });
    cut(new RegExp(`(?:\\b(?:at least|not less than|minimum of)|>=) ?${AMT}`, "g"), (m) => { f.amount = { op: "gte", a: amt(m[1], m[2]) }; });
    cut(new RegExp(`(?:\\b(?:at most|not more than|up to|maximum of)|<=) ?${AMT}`, "g"), (m) => { f.amount = { op: "lte", a: amt(m[1], m[2]) }; });
    cut(new RegExp(`(?:\\b(?:over|above|more than|greater than|bigger than|larger than|exceeding)|>) ?${AMT}`, "g"), (m) => { f.amount = { op: "gt", a: amt(m[1], m[2]) }; });
    cut(new RegExp(`(?:\\b(?:under|below|less than|smaller than)|<) ?${AMT}`, "g"), (m) => { f.amount = { op: "lt", a: amt(m[1], m[2]) }; });

    // numbers: a phone number as printed (masked), a phone, till, paybill or account number on the statement,
    // a full phone number, or else an amount
    const idList = new Set(rows.flatMap((r) => [r.partyId, r.account]).filter(Boolean).map((v) => v.toLowerCase()));
    cut(/(^|[^a-z0-9.*])\+?(\d[\d*]*)(?:\.(\d{1,2}))?(k)?(?=$|[^a-z0-9*])/g, (m) => {
      const raw = m[2], cents = m[3], k = m[4];
      if (raw.includes("*")) { (f.ids = f.ids || []).push(raw); return; }
      if (!cents && !k && idList.has(raw)) { (f.ids = f.ids || []).push(raw); return; }
      const ph = phoneDigits(raw);
      if (!cents && !k && /^0[17]\d{8}$/.test(ph)) { f.phone = ph; return; }
      if (!f.amount) f.amount = { op: "eq", a: amt(raw + (cents ? "." + cents : ""), k) };
    });

    // money in or out
    if (/\b(sent me|sent to me|paid me|gave me|received|receive|got|deposits?|deposited|incoming|income|came in|money in)\b/.test(t)) f.dir = "in";
    else if (/\b(paid|pay|payments?|sent|send|spent|spend|withdr\w*|bought|buy|money out|went out)\b/.test(t)) f.dir = "out";

    // a kind of transaction named in full
    const ty = types(rows).find((x) => t.includes(" " + x.type.toLowerCase().replace(/ \(till\)| & bundles/g, "") + " "));
    if (ty) { f.type = ty.type; t = t.replace(ty.type.toLowerCase().replace(/ \(till\)| & bundles/g, ""), " "); }

    // a person or business on the statement, then any other word found on a row
    const words = t.replace(/[^a-z0-9* ]+/g, " ").split(" ").filter((w) => w.length >= 3 && !STOP.has(w) && !/\d/.test(w));
    const named = words.length ? parties(rows).filter((p) => {
      const pw = p.party.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      return words.every((w) => pw.some((x) => x.startsWith(w)));
    }) : [];
    if (named.length === 1) f.party = named[0].key;
    else if (words.length) {
      const hay = rows.map((r) => " " + (r.details + " " + r.party).toLowerCase().replace(/[^a-z0-9*]+/g, " ") + " ");
      const found = words.filter((w) => hay.some((h) => h.includes(" " + w)));
      if (found.length) f.words = found;
    }
    return Object.keys(f).some((k) => k !== "dir") ? f : null;
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
    // A lookup: a receipt, an amount, a date or a full phone number makes the question about particular rows.
    // A name alone stays a question about that person, unless it asks to find or list.
    const f = lookup(text, rows);
    const asks = /\b(find|show|search|list|look up|lookup|which transactions?|any transactions?|transactions? (with|of|on|in|from|to|over|under))\b/.test(t);
    if (f && (f.receipt || f.amount || f.date || f.phone || (f.ids && !named))) {
      if (named && !f.party && !(f.ids && f.ids.length)) f.party = named.key;
      return { id: "find", slot: f };
    }
    if (named) return asks && f && (f.dir || f.type) ? { id: "find", slot: Object.assign(f, { party: f.party || named.key }) } : { id: "party", slot: named.key };
    const ty = types(rows).find((x) => hit(x.type.toLowerCase().replace(/ \(till\)| & bundles/g, "")));
    let best = null, bs = 0;
    for (const q of QUESTIONS) {
      if (q.slot) continue;
      const sc = q.kw.filter(hit).length;
      if (sc > bs) { best = q; bs = sc; }
    }
    if (f && (asks || !best) && (f.words || f.ids || f.party)) return { id: "find", slot: f };
    if (ty && bs < 2) return { id: "type", slot: ty.type };
    return best ? { id: best.id } : null;
  }

  // Lookups to offer as examples, taken from the statement itself: a receipt, a name or number, an amount, a day.
  function examples(rows) {
    if (!rows.length) return [];
    const out = rows.filter((r) => r.withdrawn > 0 && !isCharge(r));
    const ex = [];
    const big = out.slice().sort((x, y) => y.withdrawn - x.withdrawn)[0];
    if (big) ex.push("Find receipt " + big.receipt);
    const p = parties(rows).find((x) => x.partyId && /\*/.test(x.partyId)) || parties(rows).find((x) => x.partyId);
    if (p) ex.push("Transactions with " + p.partyId);
    if (out.length) {
      const amounts = out.map((r) => r.withdrawn).sort((x, y) => x - y);
      const mid = amounts[Math.floor(amounts.length * 0.75)];
      const step = mid >= 10000 ? 5000 : mid >= 1000 ? 1000 : 100;
      ex.push("Payments over " + Math.max(step, Math.floor(mid / step) * step).toLocaleString("en-US"));
    }
    const days = new Map();
    for (const r of rows) days.set(day(r.ts), (days.get(day(r.ts)) || 0) + 1);
    const busy = [...days.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
    if (busy) ex.push("Transactions on " + +busy[0].slice(8) + " " + MONTHS[+busy[0].slice(5, 7) - 1] + " " + busy[0].slice(0, 4));
    return ex;
  }

  const api = { QUESTIONS, answer, match, lookup, examples, parties, types };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MpesaAsk = api;
})(typeof window !== "undefined" ? window : globalThis);
