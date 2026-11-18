/* Builds the formatted workbook from parsed rows. Browser: window.MpesaExcel. Node: module.exports. */
(function (root) {
  "use strict";

  const GREEN = "FF1F5C3A", LIGHT = "FFEAF3EC", BAND = "FFF7FAF8", RED = "FFFBE3E1", GREY = "FF6B7280", WHITE = "FFFFFFFF";
  const MONEY = '#,##0.00;-#,##0.00;"";@';
  const MONEY_SHOW0 = '#,##0.00;-#,##0.00;0.00';
  const font = (o) => Object.assign({ name: "Calibri", size: 11 }, o || {});
  const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const thin = { style: "thin", color: { argb: "FFD9E2DC" } };
  const r2 = (v) => Math.round(v * 100) / 100;
  // Excel date serial from a UTC wall-clock timestamp (so times never shift by time zone).
  const toDate = (ts) => new Date(ts);

  // Long text is kept whole: it wraps inside its cell and the row is made tall enough for every line, since a
  // spreadsheet does not always grow a row to fit wrapped text by itself. Lines are counted generously (at 85%
  // of the column's width in characters), so the last one is never cut off.
  const LINE_PT = 15;
  function lineCount(text, width) {
    const cap = Math.max(8, Math.floor(width * 0.85));
    let n = 1, cur = 0;
    for (const w of String(text == null ? "" : text).split(/\s+/).filter(Boolean)) {
      const need = cur ? cur + 1 + w.length : w.length;
      if (need <= cap) { cur = need; continue; }
      if (cur) n++;
      n += Math.floor((w.length - 1) / cap); // a word longer than a line runs over several
      cur = w.length % cap || cap;
    }
    return n;
  }
  function wrapRow(row, cells) {
    let most = 1;
    for (const [c, width] of cells) {
      const cell = row.getCell(c);
      cell.alignment = Object.assign({}, cell.alignment, { wrapText: true });
      most = Math.max(most, lineCount(cell.value, width));
    }
    row.eachCell({ includeEmpty: true }, (cell) => { cell.alignment = Object.assign({}, cell.alignment, { vertical: "top" }); });
    if (most > 1) row.height = most * LINE_PT + 2;
  }

  function styleHeader(row) {
    row.height = 22;
    row.eachCell((c) => {
      c.font = font({ bold: true, color: { argb: WHITE } });
      c.fill = fill(GREEN);
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      c.border = { bottom: thin };
    });
  }

  function build(ExcelJS, rows, s, opts) {
    opts = opts || {};
    const multiFile = new Set(rows.map((r) => r.file)).size > 1;
    const wb = new ExcelJS.Workbook();
    wb.creator = "M-Pesa Statement to Excel";
    wb.created = new Date();
    wb.calcProperties.fullCalcOnLoad = true;

    const sum = wb.addWorksheet("Summary", { views: [{ showGridLines: false }], properties: { tabColor: { argb: GREEN } } });
    const tx = wb.addWorksheet("Transactions", { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
    const inSheet = wb.addWorksheet("Money in", { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
    const outSheet = wb.addWorksheet("Money out", { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
    const mo = wb.addWorksheet("Monthly", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
    // Summary rows the Money in and Money out sheets tie back to (see the key figures below)
    const kpiStart = 9, kpiRowIn = kpiStart + 2, kpiRowOut = kpiStart + 3;
    const cp = wb.addWorksheet("Counterparties", { views: [{ state: "frozen", ySplit: 1 }] });

    // ---------------- Transactions ----------------
    const cols = [
      ["Date & time", 19], ["Receipt No.", 13], ["Details", 58], ["Type", 20], ["Counterparty", 30],
      ["Phone / Till / Paybill", 18], ["Account", 16], ["Status", 11], ["Paid in", 14], ["Withdrawn", 14],
      ["Balance", 15], ["Balance check", 14], ["Expected balance", 16], ["Difference", 13],
    ];
    if (multiFile) cols.push(["Source file", 26]);
    tx.columns = cols.map(([header, width]) => ({ header, width }));
    styleHeader(tx.getRow(1));
    const n = rows.length;
    rows.forEach((r, i) => {
      // The check as live formulas, so it can be audited in Excel: the previous balance plus money in minus
      // money out (blank amounts count as 0), and how far the balance on the statement is from it.
      const rr = i + 2;
      const expected = i === 0 ? null : { formula: `K${rr - 1}+I${rr}-J${rr}`, result: r.expected };
      const diff = i === 0 ? null : { formula: `ROUND(K${rr}-M${rr},2)`, result: r2(r.balance - r.expected) };
      const row = tx.addRow([
        toDate(r.ts), r.receipt, r.details, r.type, r.party, r.partyId, r.account, r.status,
        r.paidIn || null, r.withdrawn || null, r.balance,
        r.check === "Mismatch" ? `Mismatch (exp. ${r.expected != null ? r.expected.toFixed(2) : "?"})` : r.check,
        expected, diff,
      ].concat(multiFile ? [r.file] : []));
      [13, 14].forEach((c) => (row.getCell(c).numFmt = MONEY_SHOW0));
      row.getCell(14).font = font(r.check === "Mismatch" ? { bold: true, color: { argb: "FFB42318" } } : { color: { argb: GREY } });
      row.getCell(1).numFmt = "dd-mmm-yyyy hh:mm:ss";
      [9, 10, 11].forEach((c) => (row.getCell(c).numFmt = MONEY));
      row.getCell(11).numFmt = MONEY_SHOW0;
      if (i % 2) row.eachCell({ includeEmpty: true }, (c) => (c.fill = fill(BAND)));
      row.getCell(9).font = font({ color: { argb: "FF15803D" } });
      row.getCell(10).font = font({ color: { argb: "FFB42318" } });
      const chk = row.getCell(12);
      chk.alignment = { horizontal: "center" };
      if (r.check === "Mismatch") { chk.fill = fill(RED); chk.font = font({ bold: true, color: { argb: "FFB42318" } }); }
      else chk.font = font({ color: { argb: GREY } });
      wrapRow(row, [[3, 58], [5, 30]]); // the details and the counterparty, in full
    });
    tx.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, n + 1), column: cols.length } };
    // totals row
    const tr = tx.addRow([]);
    tr.getCell(8).value = "Totals";
    tr.getCell(9).value = { formula: `SUBTOTAL(9,I2:I${n + 1})`, result: s.totalIn };
    tr.getCell(10).value = { formula: `SUBTOTAL(9,J2:J${n + 1})`, result: s.totalOut };
    tr.eachCell((c) => { c.font = font({ bold: true }); c.border = { top: { style: "medium", color: { argb: GREEN } } }; });
    [9, 10].forEach((c) => (tr.getCell(c).numFmt = MONEY_SHOW0));

    // ---------------- Money in / Money out ----------------
    // Every transaction in one direction, with its details, so each side can be checked line by line. The total
    // follows any filter (SUBTOTAL); the line under it checks the whole sheet against the Summary's figure.
    function sideSheet(ws, key, label, kpiRow, total, argb) {
      const sideCols = [
        ["Date & time", 19], ["Receipt No.", 13], ["Details", 58], ["Type", 20], ["Counterparty", 30],
        ["Phone / Till / Paybill", 18], ["Account", 16], [label, 15], ["Balance after", 15], ["Balance check", 14],
      ].concat(multiFile ? [["Source file", 26]] : []);
      ws.columns = sideCols.map(([header, width]) => ({ header, width }));
      styleHeader(ws.getRow(1));
      const list = rows.filter((r) => r[key] > 0);
      list.forEach((r, i) => {
        const row = ws.addRow([
          toDate(r.ts), r.receipt, r.details, r.type, r.party, r.partyId, r.account, r[key], r.balance,
          r.check === "Mismatch" ? `Mismatch (exp. ${r.expected != null ? r.expected.toFixed(2) : "?"})` : r.check,
        ].concat(multiFile ? [r.file] : []));
        row.getCell(1).numFmt = "dd-mmm-yyyy hh:mm:ss";
        row.getCell(8).numFmt = MONEY_SHOW0;
        row.getCell(9).numFmt = MONEY_SHOW0;
        if (i % 2) row.eachCell({ includeEmpty: true }, (c) => (c.fill = fill(BAND)));
        row.getCell(8).font = font({ color: { argb } });
        const chk = row.getCell(10);
        chk.alignment = { horizontal: "center" };
        if (r.check === "Mismatch") { chk.fill = fill(RED); chk.font = font({ bold: true, color: { argb: "FFB42318" } }); }
        else chk.font = font({ color: { argb: GREY } });
        wrapRow(row, [[3, 58], [5, 30]]); // the details and the counterparty, in full
      });
      const m = list.length;
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, m + 1), column: sideCols.length } };
      const listed = r2(list.reduce((a, r) => a + r[key], 0));
      const tr = ws.addRow([]);
      tr.getCell(7).value = `Total (${m} transactions)`;
      tr.getCell(8).value = { formula: `SUBTOTAL(9,H2:H${m + 1})`, result: listed };
      tr.getCell(8).numFmt = MONEY_SHOW0;
      tr.eachCell((c) => { c.font = font({ bold: true }); c.border = { top: { style: "medium", color: { argb: GREEN } } }; });
      const ok = Math.abs(listed - total) < 0.005;
      const tie = ws.addRow([]);
      tie.getCell(7).value = `Ties to ${label.toLowerCase()} on Summary`;
      tie.getCell(8).value = { formula: `IF(ROUND(SUM(H2:H${m + 1})-Summary!C${kpiRow},2)=0,"OK","CHECK")`, result: ok ? "OK" : "CHECK" };
      tie.getCell(7).font = font({ color: { argb: GREY } });
      tie.getCell(8).font = font({ bold: true, color: { argb: ok ? "FF15803D" : "FFB42318" } });
      tie.getCell(8).alignment = { horizontal: "right" };
      ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:1" };
    }
    sideSheet(inSheet, "paidIn", "Money in", kpiRowIn, s.totalIn, "FF15803D");
    sideSheet(outSheet, "withdrawn", "Money out", kpiRowOut, s.totalOut, "FFB42318");

    const T = (col) => `Transactions!$${col}$2:$${col}$${n + 1}`;

    // ---------------- Monthly ----------------
    mo.columns = [
      { header: "Month", width: 14 }, { header: "Transactions", width: 14 }, { header: "Money in", width: 16 },
      { header: "Money out", width: 16 }, { header: "Net flow", width: 16 }, { header: "Charges & fees", width: 16 },
      { header: "Fuliza drawn", width: 15 }, { header: "Closing balance", width: 17 },
    ];
    styleHeader(mo.getRow(1));
    s.months.forEach((m, i) => {
      const rr = i + 2;
      const [y, mm] = m.month.split("-").map(Number);
      const row = mo.addRow([new Date(Date.UTC(y, mm - 1, 1))]);
      const range = `${T("A")},">="&$A${rr},${T("A")},"<"&EDATE($A${rr},1)`;
      row.getCell(2).value = { formula: `COUNTIFS(${range})`, result: m.n };
      row.getCell(3).value = { formula: `SUMIFS(${T("I")},${range})`, result: r2(m.in) };
      row.getCell(4).value = { formula: `SUMIFS(${T("J")},${range})`, result: r2(m.out) };
      row.getCell(5).value = { formula: `C${rr}-D${rr}`, result: r2(m.in - m.out) };
      row.getCell(6).value = { formula: `SUMIFS(${T("J")},${range},${T("D")},"Transaction charge")+SUMIFS(${T("J")},${range},${T("D")},"Fuliza fee")`, result: r2(m.charges) };
      row.getCell(7).value = { formula: `SUMIFS(${T("I")},${range},${T("D")},"Fuliza drawn")`, result: r2(m.fuliza) };
      row.getCell(8).value = m.close;
      row.getCell(1).numFmt = "mmm yyyy";
      [3, 4, 5, 6, 7, 8].forEach((c) => (row.getCell(c).numFmt = MONEY_SHOW0));
      row.getCell(5).font = font({ bold: true, color: { argb: m.in - m.out < 0 ? "FFB42318" : "FF15803D" } });
      if (i % 2) row.eachCell({ includeEmpty: true }, (c) => (c.fill = fill(BAND)));
    });
    const mEnd = s.months.length + 1;
    const mt = mo.addRow(["Total"]);
    ["B", "C", "D", "E", "F", "G"].forEach((L, k) => {
      const key = ["n", "in", "out", null, "charges", "fuliza"][k];
      const res = key ? r2(s.months.reduce((a, m) => a + m[key], 0)) : r2(s.totalIn - s.totalOut);
      mt.getCell(k + 2).value = { formula: `SUM(${L}2:${L}${mEnd})`, result: res };
      if (k) mt.getCell(k + 2).numFmt = MONEY_SHOW0;
    });
    mt.eachCell((c) => { c.font = font({ bold: true }); c.border = { top: { style: "medium", color: { argb: GREEN } } }; });

    // ---------------- Counterparties ----------------
    cp.columns = [
      { header: "Counterparty", width: 40 }, { header: "Phone / Till / Paybill", width: 20 }, { header: "Type(s)", width: 34 },
      { header: "Transactions", width: 13 }, { header: "Money in", width: 15 }, { header: "Money out", width: 15 }, { header: "Net", width: 15 },
    ];
    styleHeader(cp.getRow(1));
    s.parties.forEach((p, i) => {
      const row = cp.addRow([p.party, p.partyId, p.types, p.n, r2(p.in) || null, r2(p.out) || null, r2(p.in - p.out)]);
      [5, 6].forEach((c) => (row.getCell(c).numFmt = MONEY));
      row.getCell(7).numFmt = MONEY_SHOW0;
      if (i % 2) row.eachCell({ includeEmpty: true }, (c) => (c.fill = fill(BAND)));
      wrapRow(row, [[1, 40], [3, 34]]); // the counterparty and its types, in full
    });
    cp.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, s.parties.length + 1), column: 7 } };

    // ---------------- Summary ----------------
    sum.columns = [{ width: 3 }, { width: 30 }, { width: 18 }, { width: 4 }, { width: 26 }, { width: 10 }, { width: 16 }, { width: 16 }];
    sum.getCell("B2").value = "M-Pesa Statement Summary";
    sum.getCell("B2").font = font({ size: 18, bold: true, color: { argb: GREEN } });
    const fmtDate = (ts) => (ts == null ? "" : new Date(ts).toISOString().slice(0, 10));
    const info = [
      ["Account name", s.name || "Not shown in statement"],
      ["Mobile number", s.mobile || ""],
      ["Statement period", s.period || `${fmtDate(s.from)} to ${fmtDate(s.to)}`],
      ["Transactions covered", `${fmtDate(s.from)} to ${fmtDate(s.to)}`],
    ];
    info.forEach(([k, v], i) => {
      sum.getCell(`B${4 + i}`).value = k;
      sum.getCell(`B${4 + i}`).font = font({ color: { argb: GREY } });
      sum.getCell(`C${4 + i}`).value = v;
    });

    sum.getCell(`B${kpiStart}`).value = "Key figures (KES)";
    sum.getCell(`B${kpiStart}`).font = font({ bold: true, size: 13, color: { argb: GREEN } });
    const typeSum = (t, col) => `SUMIFS(${T(col)},${T("D")},"${t}")`;
    const kpis = [
      ["Opening balance", { formula: `Transactions!K2-Transactions!I2+Transactions!J2`, result: s.opening }],
      ["Money in", { formula: `SUM(${T("I")})`, result: s.totalIn }],
      ["Money out", { formula: `SUM(${T("J")})`, result: s.totalOut }],
      ["Net flow", { formula: `C${kpiStart + 2}-C${kpiStart + 3}`, result: r2(s.totalIn - s.totalOut) }],
      ["Closing balance", { formula: `Transactions!K${n + 1}`, result: s.closing }],
      ["Transactions", { formula: `COUNTA(${T("B")})`, result: s.count }],
      ["Transaction charges & fees", { formula: `${typeSum("Transaction charge", "J")}+${typeSum("Fuliza fee", "J")}`, result: s.charges }],
      ["Fuliza drawn", { formula: typeSum("Fuliza drawn", "I"), result: s.fulizaDrawn }],
      ["Fuliza repaid", { formula: typeSum("Fuliza repayment", "J"), result: s.fulizaRepaid }],
    ];
    kpis.forEach(([k, v], i) => {
      const r = kpiStart + 1 + i;
      sum.getCell(`B${r}`).value = k;
      const c = sum.getCell(`C${r}`);
      c.value = v;
      c.numFmt = k === "Transactions" ? "#,##0" : MONEY_SHOW0;
      c.font = font({ bold: ["Money in", "Money out", "Net flow", "Closing balance"].includes(k) });
      [sum.getCell(`B${r}`), c].forEach((x) => (x.border = { bottom: thin }));
    });

    // by type table (right side)
    sum.getCell("E9").value = "By transaction type";
    sum.getCell("E9").font = font({ bold: true, size: 13, color: { argb: GREEN } });
    const hdr = sum.getRow(10);
    ["Type", "Count", "Money in", "Money out"].forEach((h, i) => (hdr.getCell(5 + i).value = h));
    [5, 6, 7, 8].forEach((c) => {
      const cell = hdr.getCell(c);
      cell.font = font({ bold: true, color: { argb: WHITE } }); cell.fill = fill(GREEN);
      cell.alignment = { horizontal: c === 5 ? "left" : "center" };
    });
    s.byType.forEach((t, i) => {
      const row = sum.getRow(11 + i);
      row.getCell(5).value = t.type;
      row.getCell(6).value = { formula: `COUNTIFS(${T("D")},E${11 + i})`, result: t.n };
      row.getCell(7).value = { formula: `SUMIFS(${T("I")},${T("D")},E${11 + i})`, result: r2(t.in) };
      row.getCell(8).value = { formula: `SUMIFS(${T("J")},${T("D")},E${11 + i})`, result: r2(t.out) };
      [7, 8].forEach((c) => (row.getCell(c).numFmt = MONEY));
      [5, 6, 7, 8].forEach((c) => {
        row.getCell(c).border = { bottom: thin };
        if (i % 2) row.getCell(c).fill = fill(LIGHT);
      });
    });
    const tEnd = 10 + s.byType.length;
    const tt = sum.getRow(tEnd + 1);
    tt.getCell(5).value = "Total";
    tt.getCell(6).value = { formula: `SUM(F11:F${tEnd})`, result: s.count };
    tt.getCell(7).value = { formula: `SUM(G11:G${tEnd})`, result: s.totalIn };
    tt.getCell(8).value = { formula: `SUM(H11:H${tEnd})`, result: s.totalOut };
    [5, 6, 7, 8].forEach((c) => {
      tt.getCell(c).font = font({ bold: true });
      tt.getCell(c).border = { top: { style: "medium", color: { argb: GREEN } } };
      if (c > 6) tt.getCell(c).numFmt = MONEY_SHOW0;
    });

    // checks
    let r = Math.max(kpiStart + kpis.length, tEnd + 1) + 2;
    sum.getCell(`B${r}`).value = "Data checks";
    sum.getCell(`B${r}`).font = font({ bold: true, size: 13, color: { argb: GREEN } });
    const checks = [];
    checks.push(["Running balance", s.mismatches === 0
      ? `All ${s.count - 1} rows reconcile`
      : `${s.mismatches} row(s) don't follow from the previous balance. Filter "Balance check" on the Transactions sheet.`, s.mismatches === 0]);
    if (s.pdfTotals) {
      const dIn = r2(s.totalIn - s.pdfTotals.in), dOut = r2(s.totalOut - s.pdfTotals.out);
      checks.push(["Statement TOTAL (money in)", `PDF ${s.pdfTotals.in.toLocaleString("en-US", { minimumFractionDigits: 2 })}, extracted ${s.totalIn.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, dIn === 0]);
      checks.push(["Statement TOTAL (money out)", `PDF ${s.pdfTotals.out.toLocaleString("en-US", { minimumFractionDigits: 2 })}, extracted ${s.totalOut.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, dOut === 0]);
    }
    if (s.guessed) checks.push(["Direction guessed", `${s.guessed} amount(s) had no clear in/out column`, false]);
    checks.forEach(([k, v, ok], i) => {
      const rr = r + 1 + i;
      sum.getCell(`B${rr}`).value = k;
      const c = sum.getCell(`C${rr}`);
      c.value = (ok ? "OK: " : "CHECK: ") + v;
      c.font = font({ bold: true, color: { argb: ok ? "FF15803D" : "FFB42318" } });
    });
    // the same running-balance check, done again by Excel from the Difference column
    let live = 0;
    if (n >= 2) {
      const cnt = `SUMPRODUCT(--(ABS(Transactions!N3:N${n + 1})>0.005))`;
      const rr = r + 1 + checks.length;
      const ok = s.mismatches === 0;
      sum.getCell(`B${rr}`).value = "Running balance, recalculated by Excel";
      const c = sum.getCell(`C${rr}`);
      c.value = {
        formula: `IF(${cnt}=0,"OK: no row differs from the previous balance plus money in minus money out","CHECK: "&${cnt}&" row(s) differ. Filter Difference on the Transactions sheet.")`,
        result: ok ? "OK: no row differs from the previous balance plus money in minus money out"
          : `CHECK: ${s.mismatches} row(s) differ. Filter Difference on the Transactions sheet.`,
      };
      c.font = font({ bold: true, color: { argb: ok ? "FF15803D" : "FFB42318" } });
      live = 1;
    }

    const noteRow = Math.max(r + checks.length + live + 3, tEnd + 4);
    sum.getCell(`B${noteRow}`).value =
      "Generated in the browser from the M-Pesa PDF. Withdrawn amounts are shown as positive numbers. Charges are separate rows that share the parent receipt number.";
    sum.getCell(`B${noteRow}`).font = font({ italic: true, size: 9, color: { argb: GREY } });
    sum.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    [tx, mo, cp].forEach((ws) => (ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:1" }));
    return wb;
  }

  function toCSV(rows) {
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["Date", "Time", "Receipt No.", "Details", "Type", "Counterparty", "Phone/Till/Paybill", "Account", "Status", "Paid in", "Withdrawn", "Balance", "Balance check"];
    const lines = [head.join(",")];
    for (const r of rows) {
      const iso = new Date(r.ts).toISOString();
      lines.push([iso.slice(0, 10), iso.slice(11, 19), r.receipt, r.details, r.type, r.party, r.partyId, r.account, r.status,
        r.paidIn ? r.paidIn.toFixed(2) : "", r.withdrawn ? r.withdrawn.toFixed(2) : "", r.balance != null ? r.balance.toFixed(2) : "", r.check].map(esc).join(","));
    }
    return "\uFEFF" + lines.join("\r\n");
  }

  const api = { build, toCSV };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MpesaExcel = api;
})(typeof window !== "undefined" ? window : globalThis);
