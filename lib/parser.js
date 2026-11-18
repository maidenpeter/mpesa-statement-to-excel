/* M-Pesa statement parser.
 * Input: pages of positioned text items (from pdf.js getTextContent).
 * Output: transactions with type, counterparty and balance reconciliation.
 * Works in the browser (window.MpesaParser) and in Node (module.exports).
 */
(function (root) {
  "use strict";

  const RX_RECEIPT = /^[A-Z0-9]{8,12}$/;
  const RX_RECEIPT_TAIL = /^[A-Z0-9]{1,4}$/;
  const RX_AMOUNT = /^\(?-?[\d,]*\d\.\d{2}\)?$/;
  const RX_DATE = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})$/;
  const RX_TIME = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const RX_STATUS = /^(completed|failed|pending|reversed|declined|cancelled|canceled|expired|authorized)$/i;
  const RX_HEADER_WORD = /^(receipt|no\.?|completion|initiation|time|date|details|description|particulars|transactio|transaction|n|status|paid|in|out|withdrawn|withdraw|balance|confirmed|reason|type|other|party|info|linked|id|a\/c|ac|acc\.?|account|debit|credit|money)$/i;
  const RX_FOOTER = /(^page\s+\d+(\s+of\s+\d+)?$|disclaimer|produced for your personal use|safaricom\s+plc|terms and conditions|www\.safaricom|customer care)/i;
  const RX_PAGE = /^page\s+\d+(\s+of\s+\d+)?$/i;

  // ---------- geometry ----------
  function toWords(items) {
    const out = [];
    for (const it of items) {
      const s = it.str;
      if (!s || !s.trim()) continue;
      const cw = (it.w || s.length * 4) / Math.max(s.length, 1);
      const re = /\S+/g;
      let m;
      while ((m = re.exec(s))) {
        out.push({ t: m[0], x: it.x + m.index * cw, r: it.x + (m.index + m[0].length) * cw, y: it.y, h: it.h || 8 });
      }
    }
    return out;
  }

  function toLines(words) {
    const ws = words.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const w of ws) {
      const last = lines[lines.length - 1];
      const tol = Math.max(1.5, Math.min(w.h, 12) * 0.35);
      if (last && Math.abs(last.y - w.y) <= tol) last.words.push(w);
      else lines.push({ y: w.y, words: [w] });
    }
    for (const l of lines) {
      l.words.sort((a, b) => a.x - b.x);
      l.text = l.words.map((w) => w.t).join(" ");
    }
    return lines;
  }

  // Find the transaction table header and return column anchors.
  function findHeader(lines) {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].words.some((w) => /^receipt/i.test(w.t))) continue;
      const band = lines.filter((l) => l === lines[i] || (Math.abs(l.y - lines[i].y) <= 16 &&
        l.words.filter((w) => RX_HEADER_WORD.test(w.t)).length >= l.words.length * 0.8));
      const ws = band.flatMap((l) => l.words).sort((a, b) => a.x - b.x);
      const find = (rx, after) => ws.find((w) => rx.test(w.t) && (after == null || w.x > after + 1));
      const receipt = find(/^receipt/i);
      const details = find(/^(details|description|particulars)$/i);
      const balance = find(/^balance$/i);
      if (!receipt || !details || !balance) continue;
      const time = find(/^(completion|date|time)$/i);
      const status = find(/^(transact|status)/i, details.x);
      const paid = find(/^paid$/i, details.x) || find(/^(in|credit|credits|money)$/i, details.x);
      const withdrawn = find(/^(withdraw|debit|out$)/i, paid ? paid.x : details.x) ||
        (paid && find(/^paid$/i, paid.x));
      const cols = [
        { key: "receipt", x: receipt.x },
        time && { key: "time", x: time.x },
        { key: "details", x: details.x },
        status && { key: "status", x: status.x },
        paid && { key: "paid", x: paid.x },
        withdrawn && { key: "withdrawn", x: withdrawn.x },
        { key: "balance", x: balance.x },
      ].filter(Boolean);
      // Columns after Balance (business statements) close the balance column.
      const after = ws.filter((w) => w.x > balance.r + 8 && /^[A-Z]/i.test(w.t));
      if (after.length) cols.push({ key: "extra", x: Math.min(...after.map((w) => w.x)) });
      cols.sort((a, b) => a.x - b.x);
      const bottom = Math.min(...band.map((l) => l.y));
      return { cols, bottom };
    }
    return null;
  }

  function colOf(cols, x) {
    let k = null;
    for (const c of cols) if (x >= c.x - 4) k = c.key;
    return k || cols[0].key;
  }
  const anchorX = (cols, key) => (cols.find((c) => c.key === key) || {}).x;

  function parseAmount(t) {
    const neg = /^\(.*\)$/.test(t) || t.includes("-");
    const v = parseFloat(t.replace(/[(),\-]/g, ""));
    return { v: isNaN(v) ? null : v, neg };
  }

  function parseDateTime(dateTok, timeTok) {
    if (!dateTok) return null;
    let y, mo, d;
    let m = dateTok.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = dateTok.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
      if (!m) return null;
      d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000;
    }
    let hh = 0, mi = 0, ss = 0;
    if (timeTok) { const t = timeTok.split(":"); hh = +t[0]; mi = +t[1]; ss = +(t[2] || 0); }
    return Date.UTC(y, mo - 1, d, hh, mi, ss);
  }

  // ---------- page -> raw rows ----------
  function parsePage(items, prevHeader, docVotes, forcedMode) {
    const lines = toLines(toWords(items));
    const header = findHeader(lines) || prevHeader;
    if (!header) return { header: null, rows: [], meta: lines };
    const { cols } = header;
    const ownHeader = header !== prevHeader;
    const timeX = anchorX(cols, "time") ?? anchorX(cols, "details");
    const statusX = anchorX(cols, "status") ?? anchorX(cols, "paid") ?? anchorX(cols, "balance");
    const leftEdge = cols[0].x - 10;

    const isAnchor = (l) => l.words.some((w) => w.x < timeX - 2 && RX_RECEIPT.test(w.t) && /[A-Z]/.test(w.t));
    // Page footers go. A line with a footer's words ("Safaricom PLC", "customer care") stays when it is a
    // transaction's first line or sits wholly in the Details column: there it is a payment's details, as printed.
    const detailsXf = anchorX(cols, "details");
    const inDetails = (l) => l.words.every((w) => w.x >= detailsXf - 4 && w.x < statusX - 4);
    let body = lines.filter((l) => !ownHeader || l.y < header.bottom - 1);
    body = body.filter((l) => RX_PAGE.test(l.text) ? false : !(RX_FOOTER.test(l.text) && !isAnchor(l) && !inDetails(l)));
    const anchors = body.filter(isAnchor);
    if (!anchors.length) return { header, rows: [], meta: lines.filter((l) => l.y >= header.bottom - 1) };

    // Keep only lines that can belong to the table.
    const valid = body.filter((l) => {
      if (anchors.includes(l)) return true;
      if (l.words.some((w) => w.x < leftEdge)) return false;
      const recWords = l.words.filter((w) => colOf(cols, w.x) === "receipt");
      return !recWords.some((w) => !RX_RECEIPT_TAIL.test(w.t));
    });
    const hs = valid.flatMap((l) => l.words.map((w) => w.h)).sort((a, b) => a - b);
    const fh = hs.length ? Math.min(14, Math.max(5, hs[Math.floor(hs.length / 2)])) : 8;

    // Split into blocks wherever the vertical gap is bigger than normal line leading (row padding).
    const blocks = [];
    for (const l of valid) {
      const last = blocks[blocks.length - 1];
      if (last && last.lines[last.lines.length - 1].y - l.y <= fh * 1.45) last.lines.push(l);
      else blocks.push({ lines: [l] });
    }
    blocks.forEach((b) => { b.anchors = b.lines.filter((l) => anchors.includes(l)); });

    // Vote on cell alignment from unambiguous multi-line rows.
    const votes = docVotes || { top: 0, middle: 0, bottom: 0 };
    const isA = (l) => anchors.includes(l);
    for (const b of blocks) {
      const L = b.lines;
      if (L.length < 2) continue;
      if (b.anchors.length === 1) {
        const i = L.indexOf(b.anchors[0]);
        votes[i === 0 ? "top" : i === L.length - 1 ? "bottom" : "middle"] += 3;
        continue;
      }
      // merged rows: which end of the block holds a receipt line
      if (isA(L[0]) && !isA(L[L.length - 1])) votes.top++;
      if (!isA(L[0]) && isA(L[L.length - 1])) votes.bottom++;
      // middle-aligned single-line cells sit half a line off the wrapped text
      for (let i = 1; i < L.length; i++) {
        if (isA(L[i]) !== isA(L[i - 1]) && L[i - 1].y - L[i].y < fh * 0.7) votes.middle++;
      }
    }
    let mode = forcedMode || "middle";
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    if (!forcedMode && best[1] > 0) mode = best[0];

    const groups = anchors.map((a) => ({ anchor: a, lines: [] }));
    const gIndex = new Map(anchors.map((a, i) => [a, i]));
    const pick = (l) => {
      const above = anchors.filter((a) => a.y >= l.y - 0.5);
      const below = anchors.filter((a) => a.y <= l.y + 0.5);
      const near = anchors.reduce((p, a) => (Math.abs(a.y - l.y) < Math.abs(p.y - l.y) ? a : p), anchors[0]);
      if (mode === "top" && above.length) return above[above.length - 1];
      if (mode === "bottom" && below.length) return below[0];
      return near;
    };
    const spill = [];
    const firstAnchorY = anchors[0].y;
    for (const b of blocks) {
      if (b.anchors.length === 1) { groups[gIndex.get(b.anchors[0])].lines.push(...b.lines); continue; }
      if (b.anchors.length > 1) {
        for (const l of b.lines) groups[gIndex.get(anchors.includes(l) ? l : pick(l))].lines.push(l);
        continue;
      }
      // block with no receipt: continuation of a row split across pages, or stray text
      if (b.lines[0].y > firstAnchorY) { spill.push(...b.lines); continue; }
      // set apart below the rows and in a footer's words: a footer inside the Details column, not a row's details
      if (b.lines.some((l) => RX_FOOTER.test(l.text))) continue;
      const a = pick(b.lines[0]);
      if (Math.abs(a.y - b.lines[0].y) <= fh * 3.5) groups[gIndex.get(a)].lines.push(...b.lines);
    }
    const detailsX0 = anchorX(cols, "details");
    const spillDetails = spill.flatMap((l) => l.words.filter((w) => w.x >= detailsX0 - 4 && w.x < statusX - 4).map((w) => w.t)).join(" ");

    const rows = groups.map((g) => {
      const ls = g.lines.slice().sort((a, b) => b.y - a.y);
      const all = ls.flatMap((l) => l.words.map((w) => ({ ...w, ly: l.y })));
      const byCol = (key) => all.filter((w) => colOf(cols, w.x) === key);
      const receipt = byCol("receipt").filter((w) => /^[A-Z0-9]+$/.test(w.t)).sort((a, b) => b.ly - a.ly || a.x - b.x).map((w) => w.t).join("");
      const timeWords = all.filter((w) => w.x < (anchorX(cols, "details") ?? Infinity) - 4 && (RX_DATE.test(w.t) || RX_TIME.test(w.t)));
      const dateTok = (timeWords.find((w) => RX_DATE.test(w.t)) || {}).t;
      const timeTok = (timeWords.find((w) => RX_TIME.test(w.t)) || {}).t;
      const detailsX = anchorX(cols, "details");
      const details = all
        .filter((w) => w.x >= detailsX - 4 && w.x < statusX - 4)
        .sort((a, b) => b.ly - a.ly || a.x - b.x)
        .map((w) => w.t).join(" ").replace(/\s+/g, " ").trim();
      const status = all.filter((w) => w.x >= statusX - 4 && RX_STATUS.test(w.t)).map((w) => w.t).join(" ");
      const extraX = anchorX(cols, "extra") ?? Infinity;
      const nums = all
        .filter((w) => w.x >= statusX - 30 && w.x < extraX - 4 && RX_AMOUNT.test(w.t))
        .sort((a, b) => a.r - b.r);
      let balance = null, paidIn = 0, withdrawn = 0, ambiguous = null, negBalance = false;
      if (nums.length) {
        const b = nums.pop();
        const pb = parseAmount(b.t);
        balance = pb.v; negBalance = pb.neg;
        if (negBalance && balance != null) balance = -balance;
        for (const n of nums) {
          const { v, neg } = parseAmount(n.t);
          if (!v) continue;
          const c = colOf(cols, n.r - 1);
          if (neg || c === "withdrawn") withdrawn += v;
          else if (c === "paid") paidIn += v;
          else ambiguous = v;
        }
      }
      return {
        receipt, dateTok, timeTok, ts: parseDateTime(dateTok, timeTok),
        details, status: status || "", paidIn: round2(paidIn), withdrawn: round2(withdrawn),
        ambiguous, balance,
      };
    });
    return { header, rows, mode, spillDetails, meta: lines.filter((l) => l.y >= (ownHeader ? header.bottom - 1 : Infinity)) };
  }

  const round2 = (v) => Math.round(v * 100) / 100;

  // Statement header details (name, number, period) and the summary TOTAL line.
  function parseMeta(lines) {
    const text = lines.map((l) => l.text).join("\n");
    const pick = (rx) => { const m = text.match(rx); return m ? m[1].trim() : ""; };
    const meta = {
      name: pick(/Customer\s+Name\s*:?\s*(.+)/i),
      mobile: pick(/Mobile\s+Number\s*:?\s*([+\d\s*]+)/i),
      email: pick(/Email\s+Address\s*:?\s*(\S+)/i),
      period: pick(/Statement\s+Period\s*:?\s*(.+)/i),
      requested: pick(/Request\s+Date\s*:?\s*(.+)/i),
    };
    const tot = lines.find((l) => /^TOTAL\s*:?/i.test(l.text));
    if (tot) {
      const n = tot.words.filter((w) => RX_AMOUNT.test(w.t)).map((w) => parseAmount(w.t).v);
      if (n.length >= 2) { meta.pdfTotalIn = n[0]; meta.pdfTotalOut = n[1]; }
    }
    return meta;
  }

  // ---------- classification ----------
  const RULES = [
    ["Fuliza fee", /(overdraft|fuliza|od)\b.*\b(fee|charge|interest)|access fee/i],
    ["Transaction charge", /\bcharges?\b/i],
    ["Fuliza drawn", /overdraft of credit party|fuliza\s+(loan\s+)?disburs/i],
    ["Fuliza repayment", /od loan repayment|overdraft.*repay|fuliza.*repay/i],
    ["Reversal", /reversal|reversed/i],
    ["Pochi la Biashara", /small business|pochi/i],
    ["Send money", /^customer (transfer|send money)\b.*\bto\b|^send money/i],
    ["Received money", /^funds received from|^customer transfer from|received from/i],
    ["Paybill", /pay\s?bill/i],
    ["Buy Goods (Till)", /merchant payment|buy goods|lipa na m-?pesa|till payment/i],
    ["Agent withdrawal", /withdrawal at agent|withdraw.*agent/i],
    ["ATM withdrawal", /\batm\b/i],
    ["Agent deposit", /deposit of funds at agent|deposit.*agent/i],
    ["Airtime & bundles", /airtime|recharge for customer|bundle/i],
    ["M-Shwari", /m-?shwari/i],
    ["KCB M-PESA", /kcb m-?pesa/i],
    ["Business payment in", /business payment from|salary payment|b2c/i],
    ["Promotion / Bonga", /promotion payment|bonga/i],
    ["Savings / investment", /lock savings|ziidi|mmf|money market/i],
  ];

  function classify(details, paidIn, withdrawn) {
    let type = null;
    for (const [name, rx] of RULES) if (rx.test(details)) { type = name; break; }
    if (!type) type = paidIn > 0 ? "Other money in" : withdrawn > 0 ? "Other money out" : "Other";
    let party = "", partyId = "", account = "";
    const m = details.match(/(?:\bto|\bfrom|\btill|\bagent)\s+([A-Z0-9*+]{3,})\s*-\s*(.+)$/i);
    if (m && !/charge/i.test(type)) {
      partyId = m[1];
      let rest = m[2];
      const acc = rest.match(/\s+Acc\.\s*(?:No\.?)?\s*:?\s*(.+)$/i) || rest.match(/\s+Account\s+(?:No\.?|Number)\s*:?\s*(.+)$/i);
      if (acc) { account = acc[1].trim(); rest = rest.slice(0, acc.index); }
      party = rest.replace(/\s+via\s+API.*$/i, "").replace(/\.\s*Original conversation.*$/i, "").trim();
    } else if (type === "Airtime & bundles") party = "Safaricom (airtime/bundles)";
    else if (type === "M-Shwari") party = "M-Shwari";
    else if (type === "Fuliza drawn" || type === "Fuliza repayment" || type === "Fuliza fee") party = "Fuliza";
    return { type, party, partyId, account };
  }

  // ---------- reconciliation ----------
  // rows must be chronological. Fixes in/out direction using balance deltas and flags breaks.
  function reconcile(rows) {
    const EPS = 0.005;
    const check = (prev, r) => {
      if (prev == null || r.balance == null) return null;
      return Math.abs(prev + r.paidIn - r.withdrawn - r.balance) < EPS;
    };
    const resolve = (prev, r) => {
      const a = r.ambiguous;
      if (a == null) return;
      if (prev != null && r.balance != null) {
        if (Math.abs(prev + a - r.balance) < EPS) { r.paidIn = round2(r.paidIn + a); r.ambiguous = null; return; }
        if (Math.abs(prev - a - r.balance) < EPS) { r.withdrawn = round2(r.withdrawn + a); r.ambiguous = null; return; }
      }
    };
    for (let i = 0; i < rows.length; i++) {
      const prev = i ? rows[i - 1].balance : null;
      const r = rows[i];
      resolve(prev, r);
      // a single amount sitting in the wrong column: the balance says which way it went
      if (prev != null && r.balance != null && !check(prev, r)) {
        const a = r.paidIn + r.withdrawn;
        if (r.paidIn && !r.withdrawn && Math.abs(prev - a - r.balance) < EPS) { r.withdrawn = a; r.paidIn = 0; }
        else if (r.withdrawn && !r.paidIn && Math.abs(prev + a - r.balance) < EPS) { r.paidIn = a; r.withdrawn = 0; }
      }
    }
    // same-second rows can be listed in either order: try swapping neighbors that break the chain
    for (let i = 1; i < rows.length - 1; i++) {
      const a = rows[i], b = rows[i + 1];
      if (a.ts !== b.ts) continue;
      const p = rows[i - 1].balance;
      if (check(p, a) && check(a.balance, b)) continue;
      if (check(p, b) && check(b.balance, a)) { rows[i] = b; rows[i + 1] = a; }
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.ambiguous != null) { // still unknown: fall back to "paid in" only if balance went up
        if (i && rows[i - 1].balance != null && r.balance != null && r.balance > rows[i - 1].balance) r.paidIn = round2(r.paidIn + r.ambiguous);
        else r.withdrawn = round2(r.withdrawn + r.ambiguous);
        r.ambiguous = null;
        r.guessed = true;
      }
      const ok = i === 0 ? null : check(rows[i - 1].balance, r);
      r.check = ok === null ? "Start" : ok ? "OK" : "Mismatch";
      r.expected = i === 0 || rows[i - 1].balance == null ? null : round2(rows[i - 1].balance + r.paidIn - r.withdrawn);
    }
    return rows;
  }

  // ---------- one document ----------
  function parseDocument(pages, fileName) {
    // pass 1: learn cell alignment across the whole document
    const votes = { top: 0, middle: 0, bottom: 0 };
    let h = null;
    for (const items of pages) { const r = parsePage(items, h, votes); if (r.header) h = r.header; }
    const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    const mode = top[1] > 0 ? top[0] : "middle";
    // pass 2: build rows
    let header = null;
    let raw = [];
    let metaLines = [];
    pages.forEach((items, pi) => {
      const res = parsePage(items, header, null, mode);
      if (res.header) header = res.header;
      if (res.spillDetails && raw.length) raw[raw.length - 1].details = (raw[raw.length - 1].details + " " + res.spillDetails).trim();
      if (pi === 0) metaLines = toLines(toWords(items)).filter((l) => !res.header || l.y >= res.header.bottom - 1);
      raw = raw.concat(res.rows);
    });
    if (!header) throw new Error("Could not find the transaction table. Is this an M-Pesa statement?");
    const meta = parseMeta(metaLines);
    raw = raw.filter((r) => r.receipt && r.ts != null);
    const first = raw[0], last = raw[raw.length - 1];
    const newestFirst = !first || first.ts >= last.ts;
    const chrono = newestFirst ? raw.slice().reverse() : raw.slice();
    chrono.forEach((r) => { r.file = fileName; });
    return { meta, rows: chrono, newestFirst };
  }

  // ---------- merge several statements ----------
  function combine(docs) {
    const seen = new Set();
    let rows = [];
    for (const d of docs) for (const r of d.rows) {
      const key = [r.receipt, r.ts, r.details, r.paidIn, r.withdrawn, r.ambiguous, r.balance].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
    rows = rows.map((r, i) => ({ ...r, _i: i })).sort((a, b) => a.ts - b.ts || a._i - b._i);
    reconcile(rows);
    for (const r of rows) Object.assign(r, classify(r.details, r.paidIn, r.withdrawn));
    return rows;
  }

  // ---------- aggregates ----------
  function summarize(rows, docs) {
    const sum = (f) => round2(rows.reduce((s, r) => s + f(r), 0));
    const first = rows[0], last = rows[rows.length - 1];
    const opening = first ? round2(first.balance - first.paidIn + first.withdrawn) : 0;
    const byType = {};
    const months = {};
    const parties = {};
    for (const r of rows) {
      const t = (byType[r.type] = byType[r.type] || { type: r.type, n: 0, in: 0, out: 0 });
      t.n++; t.in += r.paidIn; t.out += r.withdrawn;
      const d = new Date(r.ts);
      const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const m = (months[mk] = months[mk] || { month: mk, n: 0, in: 0, out: 0, charges: 0, fuliza: 0, close: 0 });
      m.n++; m.in += r.paidIn; m.out += r.withdrawn; m.close = r.balance;
      if (r.type === "Transaction charge" || r.type === "Fuliza fee") m.charges += r.withdrawn;
      if (r.type === "Fuliza drawn") m.fuliza += r.paidIn;
      if (r.party) {
        const pk = r.party.toUpperCase() + "|" + r.partyId;
        const p = (parties[pk] = parties[pk] || { party: r.party, partyId: r.partyId, types: new Set(), n: 0, in: 0, out: 0 });
        p.n++; p.in += r.paidIn; p.out += r.withdrawn; p.types.add(r.type);
      }
    }
    const metas = docs.map((d) => d.meta);
    const pick = (k) => (metas.find((m) => m[k]) || {})[k] || "";
    return {
      name: pick("name"), mobile: pick("mobile"), period: metas.map((m) => m.period).filter(Boolean).join("; "),
      opening, closing: last ? last.balance : 0,
      totalIn: sum((r) => r.paidIn), totalOut: sum((r) => r.withdrawn),
      charges: sum((r) => (r.type === "Transaction charge" || r.type === "Fuliza fee" ? r.withdrawn : 0)),
      fulizaDrawn: sum((r) => (r.type === "Fuliza drawn" ? r.paidIn : 0)),
      fulizaRepaid: sum((r) => (r.type === "Fuliza repayment" ? r.withdrawn : 0)),
      count: rows.length, mismatches: rows.filter((r) => r.check === "Mismatch").length,
      guessed: rows.filter((r) => r.guessed).length,
      from: first ? first.ts : null, to: last ? last.ts : null,
      pdfTotals: docs.length === 1 && metas[0].pdfTotalIn != null ? { in: metas[0].pdfTotalIn, out: metas[0].pdfTotalOut } : null,
      byType: Object.values(byType).sort((a, b) => b.in + b.out - (a.in + a.out)),
      months: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)),
      parties: Object.values(parties).map((p) => ({ ...p, types: [...p.types].join(", ") }))
        .sort((a, b) => b.in + b.out - (a.in + a.out)),
    };
  }

  const api = { parsePage, parseDocument, combine, summarize, classify, reconcile, _toWords: toWords, _toLines: toLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MpesaParser = api;
})(typeof window !== "undefined" ? window : globalThis);
