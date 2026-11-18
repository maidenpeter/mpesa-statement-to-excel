(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

  const state = { files: [], rows: [], summary: null };
  let seq = 0;
  const KES = (v) => (v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- downloads: platform capability when hosted, plain link otherwise ----------
  let downloads = null;
  (async () => { try { if (window.claude && typeof window.claude.use === "function") downloads = await window.claude.use("downloads"); } catch (e) { downloads = null; } })();
  async function saveFile(filename, blob) {
    if (downloads) {
      try { await downloads.save({ filename, data: blob }); toast("Saved " + filename); return; }
      catch (e) {
        if (e && e.code === "declined") return;
        if (e && e.code === "rate_limited") { toast("A save is already waiting for your confirmation"); return; }
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    // a phone may ask before saving; keep the file available until it has had time to answer
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  }
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- reading PDFs ----------
  async function extractPages(buf, password, onPage) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)), password: password || undefined, isEvalSupported: false }).promise;
    const pages = [];
    let chars = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      onPage && onPage(i, pdf.numPages);
      const tc = await (await pdf.getPage(i)).getTextContent();
      pages.push(tc.items.map((it) => {
        chars += it.str.length;
        return { str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.hypot(it.transform[2], it.transform[3]) };
      }));
    }
    pdf.destroy();
    if (chars < 20) throw Object.assign(new Error("This PDF has no readable text (it looks scanned). Download the statement again from the M-Pesa app."), { user: true });
    return pages;
  }

  async function processFile(f, password) {
    f.status = "busy"; f.msg = "Opening"; renderFiles();
    try {
      const pages = await extractPages(f.buf, password, (i, n) => { f.msg = `Reading page ${i} of ${n}`; renderFiles(); });
      const doc = MpesaParser.parseDocument(pages, f.name);
      if (!doc.rows.length) throw Object.assign(new Error("No transactions found. Is this an M-Pesa statement?"), { user: true });
      f.doc = doc; f.status = "ok";
      const from = new Date(doc.rows[0].ts).toISOString().slice(0, 10), to = new Date(doc.rows[doc.rows.length - 1].ts).toISOString().slice(0, 10);
      f.msg = `${doc.rows.length.toLocaleString()} transactions, ${from} to ${to}`;
    } catch (e) {
      f.doc = null; f.status = "err";
      if (e && e.name === "PasswordException") {
        f.needsPw = true;
        f.msg = e.code === 2 ? "Wrong password. Try again." : "This file is password-protected. Enter its password.";
      } else {
        f.needsPw = false;
        f.msg = e && e.user ? e.message : "Couldn't read this file" + (e && e.message ? `: ${e.message}` : ".");
        if (!(e && e.user)) console.error(e);
      }
    }
    renderFiles();
    recompute();
  }

  // A file is a PDF if it starts like one. Phones often hand over a file with no ".pdf" in its name and no type
  // (from an email app, WhatsApp or a cloud drive), so the name and type are not enough to go on.
  const isPdf = (buf) => {
    const head = new Uint8Array(buf.slice(0, 1024));
    for (let i = 0; i + 4 < head.length; i++) {
      if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true; // %PDF-
    }
    return false;
  };

  async function addFiles(list) {
    const files = [...list];
    if (!files.length) return;
    let added = 0;
    for (const file of files) {
      const buf = await file.arrayBuffer();
      if (!isPdf(buf)) { toast((file.name || "That file") + " is not a PDF. Choose the statement PDF."); continue; }
      state.files.push({ id: ++seq, name: file.name || "statement.pdf", buf, status: "busy", msg: "Queued" });
      added++;
    }
    if (!added) return;
    renderFiles();
    for (const f of state.files.filter((x) => x.status === "busy" && x.msg === "Queued")) await processFile(f, $("#pw").value.trim());
  }

  function renderFiles() {
    const ul = $("#files");
    ul.innerHTML = state.files.map((f) => `
      <li class="file ${f.status === "err" ? "err" : ""}" data-id="${f.id}">
        ${f.status === "busy" ? '<div class="spin" aria-label="Working"></div>' : `<div class="dot ${f.status}"></div>`}
        <div>
          <div class="name">${esc(f.name)}</div>
          <div class="msg">${esc(f.msg || "")}</div>
          ${f.status === "err" && f.needsPw ? `<form class="retry"><input type="password" placeholder="Password for this file" aria-label="Password for ${esc(f.name)}" autocomplete="off"><button class="btn small" type="submit">Open</button></form>` : ""}
        </div>
        <button class="x" title="Remove" aria-label="Remove ${esc(f.name)}">&times;</button>
      </li>`).join("");
  }

  $("#files").addEventListener("click", (e) => {
    const li = e.target.closest(".file"); if (!li) return;
    if (e.target.closest(".x")) { state.files = state.files.filter((f) => f.id !== +li.dataset.id); renderFiles(); recompute(); }
  });
  $("#files").addEventListener("submit", (e) => {
    e.preventDefault();
    const li = e.target.closest(".file"); const f = state.files.find((x) => x.id === +li.dataset.id);
    const pw = e.target.querySelector("input").value.trim();
    if (f) processFile(f, pw);
  });

  // ---------- results ----------
  function recompute() {
    const docs = state.files.filter((f) => f.status === "ok").map((f) => f.doc);
    if (!docs.length) { state.rows = []; state.summary = null; $("#results").style.display = "none"; return; }
    // fresh copies so re-merging never reuses mutated rows
    const fresh = docs.map((d) => ({ ...d, rows: d.rows.map((r) => ({ ...r })) }));
    state.rows = MpesaParser.combine(fresh);
    state.summary = MpesaParser.summarize(state.rows, fresh);
    renderResults();
  }

  function renderResults() {
    const s = state.summary, rows = state.rows;
    $("#results").style.display = "block";
    const d = (ts) => new Date(ts).toISOString().slice(0, 10);
    $("#resTitle").textContent = s.name ? s.name : "Statement";
    $("#resSub").innerHTML = esc(`${s.mobile ? s.mobile + " | " : ""}${s.count.toLocaleString()} transactions from `) + `<span class="nw">${d(s.from)}</span> to <span class="nw">${d(s.to)}</span>`;
    const net = s.totalIn - s.totalOut;
    $("#kpis").innerHTML = [
      ["Money in", KES(s.totalIn), "in", true], ["Money out", KES(s.totalOut), "out", true],
      ["Net flow", (net < 0 ? "-" : "") + KES(Math.abs(net)), net < 0 ? "out" : "in", true],
      ["Opening balance", KES(s.opening)], ["Closing balance", KES(s.closing)],
      ["Charges & fees", KES(s.charges)], ["Fuliza drawn", KES(s.fulizaDrawn)],
    ].map(([k, v, cls, big]) => `<div class="kpi ${big ? "big" : ""}"><div class="k">${k}</div><div class="v num ${cls || ""}">${v}</div></div>`).join("");

    const checks = [];
    if (s.mismatches === 0) checks.push(["ok", `<b>Balances reconcile.</b> All ${(s.count - 1).toLocaleString()} rows follow from the previous balance.`]);
    else checks.push(["bad", `<b>${s.mismatches} row(s) don't follow from the previous balance.</b> They're highlighted below and flagged in the workbook. A gap between two statements, or a missing page, causes this. <button type="button" class="linkish" id="showBad">Show them</button>`]);
    if (s.pdfTotals) {
      const ok = Math.abs(s.totalIn - s.pdfTotals.in) < 0.005 && Math.abs(s.totalOut - s.pdfTotals.out) < 0.005;
      checks.push([ok ? "ok" : "bad", ok
        ? `<b>Totals match the statement summary</b> (in ${KES(s.pdfTotals.in)}, out ${KES(s.pdfTotals.out)}).`
        : `<b>Totals differ from the statement summary.</b> PDF says in ${KES(s.pdfTotals.in)} / out ${KES(s.pdfTotals.out)}; extracted in ${KES(s.totalIn)} / out ${KES(s.totalOut)}.`]);
    }
    if (s.guessed) checks.push(["bad", `<b>${s.guessed} amount(s)</b> had no clear in/out column. Their direction was inferred from the balance.`]);
    $("#checks").innerHTML = checks.map(([c, t]) => `<div class="check ${c}">${t}</div>`).join("");

    // each type opens its own transactions in the list, for checking one line of the summary at a time
    $("#types tbody").innerHTML = s.byType.map((t) => `<tr><td><button type="button" class="linkish" data-type="${esc(t.type)}" title="Show these transactions">${esc(t.type)}</button></td><td class="r">${t.n}</td><td class="r">${t.out ? KES(t.out) : ""}</td><td class="r">${t.in ? KES(t.in) : ""}</td></tr>`).join("");
    const sel = $("#typeFilter"), cur = sel.value;
    sel.innerHTML = '<option value="">All types</option>' + s.byType.map((t) => `<option ${t.type === cur ? "selected" : ""}>${esc(t.type)}</option>`).join("");
    renderTable();
  }

  const LIMIT = 300;
  function renderTable() {
    const q = $("#q").value.trim().toLowerCase(), type = $("#typeFilter").value, dir = $("#dirFilter").value;
    const list = state.rows.filter((r) => (!type || r.type === type) &&
      (!dir || (dir === "in" ? r.paidIn > 0 : dir === "out" ? r.withdrawn > 0 : r.check === "Mismatch")) &&
      (!q || (r.details + " " + r.party + " " + r.partyId + " " + r.receipt + " " + r.account).toLowerCase().includes(q)));
    const shown = list.slice().reverse().slice(0, LIMIT);
    // the money in and out of what is listed, so a filtered view can be checked against the statement
    const tin = list.reduce((a, r) => a + r.paidIn, 0), tout = list.reduce((a, r) => a + r.withdrawn, 0);
    const sums = ` | in ${KES(tin)} | out ${KES(tout)}`;
    $("#count").textContent = (list.length > LIMIT ? `Newest ${LIMIT} of ${list.length.toLocaleString()} shown. The workbook has all of them.` : `${list.length.toLocaleString()} shown`) + sums;
    $("#tx tbody").innerHTML = shown.map((r) => {
      const t = new Date(r.ts).toISOString();
      return `<tr class="${r.check === "Mismatch" ? "bad" : ""}" ${r.check === "Mismatch" ? `title="Expected balance ${KES(r.expected)}"` : ""}>
        <td class="when">${t.slice(0, 10)}<br><span class="count">${t.slice(11, 16)}</span></td>
        <td class="mono">${esc(r.receipt)}</td>
        <td>${esc(r.details)}<br><span class="pill">${esc(r.type)}</span></td>
        <td class="r in">${r.paidIn ? KES(r.paidIn) : ""}</td>
        <td class="r out">${r.withdrawn ? KES(r.withdrawn) : ""}</td>
        <td class="r">${r.balance != null ? KES(r.balance) : ""}</td></tr>`;
    }).join("");
  }
  $("#q").addEventListener("input", renderTable);
  $("#typeFilter").addEventListener("change", renderTable);
  $("#dirFilter").addEventListener("change", renderTable);
  // shortcuts into the list: a type in the By type table, or the rows that don't reconcile
  const showIn = (type, dir) => {
    $("#typeFilter").value = type; $("#dirFilter").value = dir; $("#q").value = "";
    renderTable();
    $("#tx").closest(".card").scrollIntoView({ block: "start" });
  };
  $("#types").addEventListener("click", (e) => { const b = e.target.closest("button[data-type]"); if (b) showIn(b.dataset.type, ""); });
  $("#checks").addEventListener("click", (e) => { if (e.target.closest("#showBad")) showIn("", "bad"); });

  function baseName() {
    const s = state.summary;
    const who = (s.name || "MPesa").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "MPesa";
    const d = (ts) => new Date(ts).toISOString().slice(0, 10);
    return `MPesa_${who}_${d(s.from)}_to_${d(s.to)}`;
  }
  $("#dlXlsx").addEventListener("click", async (e) => {
    const b = e.currentTarget; if (!state.rows.length) return;
    b.disabled = true; const label = b.lastChild.textContent; b.lastChild.textContent = " Building workbook";
    try {
      const wb = MpesaExcel.build(ExcelJS, state.rows, state.summary);
      const buf = await wb.xlsx.writeBuffer();
      await saveFile(baseName() + ".xlsx", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    } catch (err) { console.error(err); toast("Couldn't build the workbook: " + err.message); }
    finally { b.disabled = false; b.lastChild.textContent = label; }
  });
  $("#dlCsv").addEventListener("click", async () => {
    if (!state.rows.length) return;
    await saveFile(baseName() + ".csv", new Blob([MpesaExcel.toCSV(state.rows)], { type: "text/csv" }));
  });

  // ---------- inputs ----------
  const drop = $("#drop");
  $("#fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  $("#pwToggle").addEventListener("click", (e) => {
    const i = $("#pw"); const show = i.type === "password";
    i.type = show ? "text" : "password"; e.currentTarget.textContent = show ? "Hide" : "Show";
    e.currentTarget.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  // re-try locked files when the main password changes
  $("#pw").addEventListener("change", () => {
    const pw = $("#pw").value.trim();
    state.files.filter((f) => f.status === "err" && f.needsPw).forEach((f) => processFile(f, pw));
  });
})();
