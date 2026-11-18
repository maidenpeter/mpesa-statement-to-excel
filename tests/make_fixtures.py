"""Write the synthetic M-Pesa statements the tests read, and the figures each one must give.

    python tests/make_fixtures.py           write tests/fixtures/synthetic/
    python tests/make_fixtures.py --check   fail if a fresh build differs from the committed files

Every name, phone number, till, paybill, account, receipt and password in these files is invented.
The PDFs copy the structure lib/parser.js reads from a real statement:

- a header block: Customer Name, Mobile Number, Email Address, Statement Period, Request Date;
- a summary table by transaction type that ends in a TOTAL line (money in, then money out);
- the detailed statement with the columns Receipt No., Completion Time, Details, Transaction Status,
  Paid In, Withdrawn and Balance, newest first, withdrawals printed with a minus sign, long details
  wrapped over several lines, charges on their own row under the parent's receipt, the column header
  repeated on every page and a page footer.

The expected figures come from the transactions as generated here, not from the parser, so the tests
check the parser against an independent answer. Standard library only: the PDF writer, its password
encryption (the standard security handler, 128-bit RC4) and the scanned page are all built in this file.
"""
import argparse
import hashlib
import json
import random
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures" / "synthetic"
PASSWORD = "TEST1234"  # invented; opens locked.pdf only

# ---------------------------------------------------------------- PDF writer

# Helvetica widths (per 1000 units of font size) for the characters printed right-aligned.
HELV = {" ": 278, ",": 278, ".": 278, "-": 333, **{d: 556 for d in "0123456789"}}
PAD = bytes.fromhex("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A")


def width(s, size):
    return sum(HELV[c] for c in s) * size / 1000


def esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def rc4(key, data):
    S = list(range(256))
    j = 0
    for i in range(256):
        j = (j + S[i] + key[i % len(key)]) & 255
        S[i], S[j] = S[j], S[i]
    out, i, j = bytearray(), 0, 0
    for b in data:
        i = (i + 1) & 255
        j = (j + S[i]) & 255
        S[i], S[j] = S[j], S[i]
        out.append(b ^ S[(S[i] + S[j]) & 255])
    return bytes(out)


def run_length_encode(data):
    """PDF RunLengthDecode: a length byte below 128 copies that many plus one bytes; 257 minus a length byte
    above 128 repeats the next byte; 128 ends the data."""
    out, i, n = bytearray(), 0, len(data)
    while i < n:
        j = i
        while j < n and j - i < 128 and data[j] == data[i]:
            j += 1
        if j - i >= 2:
            out += bytes([257 - (j - i), data[i]])
            i = j
            continue
        j = i + 1
        while j < n and j - i < 128 and not (j + 1 < n and data[j] == data[j + 1]):
            j += 1
        out += bytes([j - i - 1]) + data[i:j]
        i = j
    return bytes(out + b"\x80")


class Security:
    """The PDF standard security handler, revision 3 (128-bit RC4)."""
    P = -4

    def __init__(self, user, owner, doc_id):
        def pad(pw):
            return (pw.encode("latin-1") + PAD)[:32]
        h = hashlib.md5(pad(owner)).digest()
        for _ in range(50):
            h = hashlib.md5(h).digest()
        o = rc4(h[:16], pad(user))
        for i in range(1, 20):
            o = rc4(bytes(b ^ i for b in h[:16]), o)
        self.O = o
        h = hashlib.md5(pad(user) + o + (self.P & 0xFFFFFFFF).to_bytes(4, "little") + doc_id).digest()
        for _ in range(50):
            h = hashlib.md5(h[:16]).digest()
        self.key = h[:16]
        u = rc4(self.key, hashlib.md5(PAD + doc_id).digest())
        for i in range(1, 20):
            u = rc4(bytes(b ^ i for b in self.key), u)
        self.U = u + bytes(16)

    def encrypt(self, num, data):
        k = hashlib.md5(self.key + num.to_bytes(3, "little") + b"\x00\x00").digest()[:16]
        return rc4(k, data)

    def dict(self):
        return f"<< /Filter /Standard /V 2 /R 3 /Length 128 /P {self.P} /O <{self.O.hex()}> /U <{self.U.hex()}> >>"


class Writer:
    def __init__(self, name, password=None):
        self.id = hashlib.md5(("synthetic-mpesa-statement-" + name).encode()).digest()
        self.sec = Security(password, password + "-owner", self.id) if password else None
        self.objs, self.n = {}, 0

    def reserve(self):
        self.n += 1
        return self.n

    def add(self, body):
        num = self.reserve()
        self.objs[num] = body
        return num

    def stream(self, data, extra="", run_length=False):
        # No zlib: its output can differ between builds, and the files must come out byte for byte the same
        # on every machine. Text streams are stored as they are; the scanned page is run-length encoded.
        num = self.reserve()
        filt = ""
        if run_length:
            data, filt = run_length_encode(data), " /Filter /RunLengthDecode"
        if self.sec:
            data = self.sec.encrypt(num, data)
        self.objs[num] = f"<< /Length {len(data)}{filt}{extra} >>\nstream\n".encode() + data + b"\nendstream"
        return num

    def finish(self, root):
        enc = self.add(self.sec.dict().encode()) if self.sec else None
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = {}
        for num in range(1, self.n + 1):
            offsets[num] = len(out)
            out += f"{num} 0 obj\n".encode() + self.objs[num] + b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {self.n + 1}\n0000000000 65535 f \n".encode()
        for num in range(1, self.n + 1):
            out += f"{offsets[num]:010d} 00000 n \n".encode()
        ident = self.id.hex()
        encrypt = f" /Encrypt {enc} 0 R" if enc else ""
        out += (f"trailer\n<< /Size {self.n + 1} /Root {root} 0 R /ID [<{ident}> <{ident}>]{encrypt} >>\n"
                f"startxref\n{xref}\n%%EOF\n").encode()
        return bytes(out)


def pdf_document(name, pages, password=None, image=None):
    w = Writer(name, password)
    catalog, pages_num = w.reserve(), w.reserve()
    f1 = w.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    f2 = w.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    kids = []
    for ops in pages:
        xobj = ""
        if image is not None:
            iw, ih, pixels = image
            im = w.stream(pixels, f" /Type /XObject /Subtype /Image /Width {iw} /Height {ih} /ColorSpace /DeviceGray /BitsPerComponent 8",
                          run_length=True)
            xobj = f" /XObject << /Im1 {im} 0 R >>"
        content = w.stream("".join(ops).encode("ascii"))
        kids.append(w.add((f"<< /Type /Page /Parent {pages_num} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 {f1} 0 R "
                           f"/F2 {f2} 0 R >>{xobj} >> /Contents {content} 0 R >>").encode()))
    w.objs[pages_num] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode()
    w.objs[catalog] = f"<< /Type /Catalog /Pages {pages_num} 0 R >>".encode()
    return w.finish(catalog)


def text(x, y, s, size=7, bold=False):
    return f"BT /{'F2' if bold else 'F1'} {size} Tf 1 0 0 1 {x:.2f} {y:.2f} Tm ({esc(s)}) Tj ET\n"


def rtext(right, y, s, size=7, bold=False):
    return text(right - width(s, size), y, s, size, bold)


def rule(x1, y, x2, w=0.4, grey=0.6):
    return f"{w} w {grey} G {x1} {y:.2f} m {x2} {y:.2f} l S 0 G\n"


# ---------------------------------------------------------------- transactions

PEOPLE = ["WANJIRU TESTER", "OTIENO SAMPLE", "AKINYI EXAMPLE", "KIPRONO DEMO", "NJERI PLACEHOLDER",
          "MUTUA FICTION", "CHEPKOECH INVENTED", "BARASA MOCK"]
BILLERS = [("400100", "TEST POWER PREPAID", True), ("400200", "SAMPLE WATER COMPANY", False),
           ("400300", "DEMO ACADEMY SCHOOL FEES", True), ("400400", "EXAMPLE TV SUBSCRIPTION", False)]
TILLS = [("5100001", "MAMA TEST KIOSK"), ("5100002", "SAMPLE SUPERMARKET"), ("5100003", "DEMO PHARMACY"),
         ("5100004", "EXAMPLE BUTCHERY")]
AGENTS = [("300001", "TEST AGENCIES"), ("300002", "SAMPLE MOBILE SHOP")]
EMPLOYER = ("600100", "EXAMPLE SACCO LTD")
FULIZA_PAYBILL = "299999"
# Invented charge tables: (up to this many shillings, charge in shillings).
SEND_CHARGE = [(100, 0), (500, 7), (1000, 13), (1500, 23), (2500, 33), (3500, 53), (5000, 57), (7500, 78), (10000, 90), (20000, 105)]
WITHDRAW_CHARGE = [(100, 11), (2500, 29), (3500, 52), (5000, 69), (7500, 87), (10000, 115), (20000, 185)]
PAYBILL_CHARGE = [(500, 0), (1000, 10), (2500, 20), (5000, 30), (20000, 40)]
CATEGORY = {"Send money": "SEND MONEY", "Received money": "RECEIVED MONEY", "Agent deposit": "AGENT DEPOSIT",
            "Agent withdrawal": "AGENT WITHDRAWAL", "Paybill": "LIPA NA M-PESA (PAYBILL)",
            "Buy Goods (Till)": "LIPA NA M-PESA (BUY GOODS)"}


def tier(table, cents):
    for top, charge in table:
        if cents <= top * 100:
            return charge * 100
    return table[-1][1] * 100


def phone(rng):
    return f"0700***{rng.randint(100, 999)}"


def receipt(rng, used):
    while True:
        r = "ZQ" + "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ0123456789") for _ in range(8))
        if r not in used:
            used.add(r)
            return r


def generate(seed, start, end, events, opening, fuliza=False):
    """Chronological rows. Amounts in cents. Linked rows (a payment, its charge, a Fuliza draw) share a
    receipt and a completion time, as on a real statement."""
    rng = random.Random(seed)
    t0, t1 = datetime.fromisoformat(start), datetime.fromisoformat(end)
    span = int((t1 - t0).total_seconds())
    times = sorted(rng.sample(range(3600, span - 3600), events))
    used, rows = set(), []
    state = {"bal": opening, "owed": 0}
    names = rng.sample(PEOPLE, len(PEOPLE))
    people = [(phone(rng), names[i]) for i in range(len(PEOPLE))]

    def row(rc, ts, details, typ, cents_in=0, cents_out=0, party="", party_id="", account=""):
        state["bal"] += cents_in - cents_out
        assert state["bal"] >= 0
        rows.append(dict(receipt=rc, ts=ts, details=details, status="Completed", paid=cents_in, out=cents_out,
                         balance=state["bal"], type=typ, party=party, partyId=party_id, account=account))

    def amount(lo, hi, cents=False):
        v = rng.randint(lo, hi) * 100
        return v + (rng.choice([25, 50, 75]) if cents and rng.random() < 0.3 else 0)

    def pay_out(ts, rc, cents, charge, lines):
        """Pay out cents plus charge, drawing on Fuliza for any shortfall."""
        need = cents + charge
        if need > state["bal"]:
            short = need - state["bal"]
            fee = max(100, -(-short // 100))
            row(rc, ts, "OverDraft of Credit Party", "Fuliza drawn", cents_in=short + fee, party="Fuliza")
            row(rc, ts, "Overdraft Access Fee", "Fuliza fee", cents_out=fee, party="Fuliza")
            state["owed"] += short + fee
        for args in lines:
            row(rc, ts, *args)

    for k, sec in enumerate(times):
        ts = t0 + timedelta(seconds=sec)
        rc = receipt(rng, used)
        # a Fuliza user spends more than comes in, so payments often run past the balance
        weights = [1.2, 3, 2, 3, 0.4, 0.3, 2, 0.3, 0.2] if fuliza else [3, 3, 2, 3, 1.5, 1, 2, 0.6, 0.6]
        kind = "receive" if k == 0 else rng.choices(
            ["receive", "send", "paybill", "buygoods", "withdraw", "deposit", "airtime", "salary", "mshwari"],
            weights=weights)[0]
        spend = {"send": amount(100, 4500), "paybill": amount(300, 6000, True), "buygoods": amount(50, 2500, True),
                 "withdraw": amount(500, 8000), "airtime": amount(20, 400), "mshwari": amount(200, 3000)}.get(kind)
        # Fuliza covers payments and airtime, not cash withdrawals or savings
        if spend is not None and (not fuliza or kind in ("withdraw", "mshwari")) and spend + 20000 > state["bal"]:
            kind, spend = "receive", None
        if kind in ("receive", "deposit", "salary"):
            if kind == "receive":
                ph, nm = rng.choice(people)
                cents = amount(300, 12000)
                row(rc, ts, f"Funds received from {ph} - {nm}", "Received money", cents_in=cents, party=nm, party_id=ph)
            elif kind == "deposit":
                till, nm = rng.choice(AGENTS)
                cents = amount(1000, 15000)
                row(rc, ts, f"Deposit of Funds at Agent Till {till} - {nm}", "Agent deposit", cents_in=cents, party=nm, party_id=till)
            else:
                cents = amount(8000, 30000)
                ref = "ZZ" + "".join(rng.choice("0123456789") for _ in range(10))
                row(rc, ts, f"Business Payment from {EMPLOYER[0]} - {EMPLOYER[1]} via API. Original conversation ID is {ref}.",
                    "Business payment in", cents_in=cents, party=EMPLOYER[1], party_id=EMPLOYER[0])
            if state["owed"]:
                repay = min(state["owed"], cents)
                state["owed"] -= repay
                row(receipt(rng, used), ts, f"OD Loan Repayment to {FULIZA_PAYBILL} - M-PESA Overdraw", "Fuliza repayment",
                    cents_out=repay, party="M-PESA Overdraw", party_id=FULIZA_PAYBILL)
        elif kind == "send":
            ph, nm = rng.choice(people)
            ch = tier(SEND_CHARGE, spend)
            lines = [(f"Customer Transfer to {ph} - {nm}", "Send money", 0, spend, nm, ph)]
            if ch:
                lines.append(("Customer Transfer of Funds Charge", "Transaction charge", 0, ch))
            pay_out(ts, rc, spend, ch, lines)
        elif kind == "paybill":
            no, nm, charged = rng.choice(BILLERS)
            acct = "".join(rng.choice("0123456789") for _ in range(rng.choice([6, 8, 11])))
            ch = tier(PAYBILL_CHARGE, spend) if charged else 0
            lines = [(f"Pay Bill Online to {no} - {nm} Acc. {acct}", "Paybill", 0, spend, nm, no, acct)]
            if ch:
                lines.append(("Pay Bill Charge", "Transaction charge", 0, ch))
            pay_out(ts, rc, spend, ch, lines)
        elif kind == "buygoods":
            till, nm = rng.choice(TILLS)
            pay_out(ts, rc, spend, 0, [(f"Merchant Payment to {till} - {nm}", "Buy Goods (Till)", 0, spend, nm, till)])
        elif kind == "withdraw":
            till, nm = rng.choice(AGENTS)
            ch = tier(WITHDRAW_CHARGE, spend)
            pay_out(ts, rc, spend, ch, [(f"Customer Withdrawal At Agent Till {till} - {nm}", "Agent withdrawal", 0, spend, nm, till),
                                        ("Withdrawal Charge", "Transaction charge", 0, ch)])
        elif kind == "airtime":
            pay_out(ts, rc, spend, 0, [("Airtime Purchase", "Airtime & bundles", 0, spend, "Safaricom (airtime/bundles)")])
        else:
            pay_out(ts, rc, spend, 0, [("M-Shwari Deposit", "M-Shwari", 0, spend, "M-Shwari")])
    return rows


# ---------------------------------------------------------------- layout

class NoSplit(Exception):
    """No wrapped row fell across a page break."""


X = dict(receipt=30, time=95, details=175, status=345, paid=405, withdrawn=465, balance=525)
RIGHT = dict(paid=458, withdrawn=518, balance=578)
LEAD, ROW_GAP, BOTTOM, WRAP = 8.5, 14.5, 72, 40
STANDARD = dict(x=X, right=RIGHT, wrap=WRAP, time_lines=1, centre=None)
# Closer to many generated PDF tables: each heading centred over its column, a narrow Details column whose text
# starts at the column's left edge (well left of its heading), and the completion time on two lines.
CENTRED = dict(x=dict(receipt=33, time=95, details=163, status=333, paid=391, withdrawn=455, balance=519),
               right=dict(paid=449, withdrawn=513, balance=577), wrap=30, time_lines=2,
               centre=dict(receipt=(30, 92), time=(92, 160), details=(160, 330), status=(330, 388), paid=(388, 452),
                           withdrawn=(452, 516), balance=(516, 580)))


def money(c):
    return f"{c // 100:,}.{c % 100:02d}"


def wrap(s, n=WRAP):
    lines, cur = [], ""
    for word in s.split():
        if cur and len(cur) + 1 + len(word) > n:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}" if cur else word
    return lines + [cur]


def table_header(y, lay=STANDARD):
    ops = [rule(30, y + 9, 580, 0.6, 0.3)]
    for key, label in [("receipt", "Receipt No."), ("time", "Completion Time"), ("details", "Details"),
                       ("status", "Transaction Status"), ("paid", "Paid In"), ("withdrawn", "Withdrawn"), ("balance", "Balance")]:
        if lay["centre"]:  # centred over the column (bold Helvetica is about 4.1pt a character at 7pt)
            left, right = lay["centre"][key]
            ops.append(text((left + right) / 2 - len(label) * 2.05, y, label, bold=True))
        else:
            ops.append(text(lay["x"][key], y, label, bold=True))
    ops.append(rule(30, y - 4, 580, 0.6, 0.3))
    return ops


def render(spec, listing, total_in, total_out):
    """listing: rows as printed, newest first. Returns pages (lists of drawing operations)."""
    pages, ops = [], []
    lay = spec.get("layout", STANDARD)
    ops.append(text(30, 805, "M-PESA STATEMENT", 12, True))
    for i, (label, value) in enumerate([("Customer Name:", spec["customer"]), ("Mobile Number:", spec["mobile"]),
                                        ("Email Address:", spec["email"]), ("Statement Period:", spec["period"]),
                                        ("Request Date:", spec["requested"])]):
        ops += [text(30, 785 - 12 * i, label, 8, True), text(120, 785 - 12 * i, value, 8)]
    # summary by transaction type
    cats = {}
    for r in spec["all_rows"]:
        c = cats.setdefault(CATEGORY.get(r["type"], "OTHERS"), [0, 0])
        c[0] += r["paid"]
        c[1] += r["out"]
    ops += [text(30, 712, "SUMMARY", 9, True), text(30, 698, "TRANSACTION TYPE", 7, True),
            text(296, 698, "PAID IN", 7, True), text(391, 698, "PAID OUT", 7, True), rule(30, 694, 430)]
    y = 686
    for name in list(CATEGORY.values()) + ["OTHERS"]:
        cin, cout = cats.get(name, (0, 0))
        ops += [text(30, y, name), rtext(330, y, money(cin)), rtext(430, y, money(cout))]
        y -= 11
    ops += [rule(30, y + 7, 430), text(30, y - 2, "TOTAL:", 7, True), rtext(330, y - 2, money(total_in), 7, True),
            rtext(430, y - 2, money(total_out), 7, True)]
    ops.append(text(30, 585, "DETAILED STATEMENT", 9, True))
    ops += table_header(566, lay)
    y, split_done = 552, False
    first_row_y = {True: 552, False: 791}

    def new_page():
        nonlocal ops, y
        pages.append(ops)
        ops = table_header(805, lay)
        y = first_row_y[False]

    for r in listing:
        lines = wrap(r["details"], lay["wrap"])
        k = max(len(lines), lay["time_lines"])
        bottom = y - (k - 1) * LEAD
        if bottom < BOTTOM:
            fit = int((y - BOTTOM) // LEAD) + 1
            if spec.get("split") and not split_done and k >= 2 and 1 <= fit < k:
                # a row that runs over the page break: its first lines here, the rest at the top of the next page
                split_done = True
                draw_row(ops, r, lines[:fit], y, "top", lay)
                rest = lines[fit:]
                spec["split_row"] = dict(receipt=r["receipt"], time=r["ts"].strftime("%Y-%m-%d %H:%M:%S"), page=len(pages) + 1,
                                         lines_here=fit, lines_on_next_page=len(rest))
                new_page()
                for i, line in enumerate(rest):
                    ops.append(text(lay["x"]["details"], y - i * LEAD, line))
                y -= (len(rest) - 1) * LEAD + ROW_GAP
                ops.append(rule(30, y + ROW_GAP / 2 + 2, 580, 0.3, 0.8))
                continue
            new_page()
            bottom = y - (k - 1) * LEAD
        draw_row(ops, r, lines, y, spec.get("align", "top"), lay)
        y = bottom - ROW_GAP
        ops.append(rule(30, y + ROW_GAP / 2 + 2, 580, 0.3, 0.8))
    if spec.get("split") and not split_done:
        raise NoSplit(spec["name"])
    pages.append(ops)
    n = len(pages)
    for i, p in enumerate(pages, 1):
        p.append(text(30, 48, "Disclaimer: This record is produced for your personal use. It is a synthetic test statement.", 6))
        p.append(text(270, 34, f"Page {i} of {n}", 7))
    return pages


def draw_row(ops, r, lines, y, align, lay=STANDARD):
    k = max(len(lines), lay["time_lines"])
    cy = y if align == "top" else y - (k - 1) * LEAD / 2
    X_, R_ = lay["x"], lay["right"]
    for i, line in enumerate(lines):
        ops.append(text(X_["details"], y - i * LEAD, line))
    ops.append(text(X_["receipt"], cy, r["receipt"]))
    if lay["time_lines"] == 2:  # the date on one line, the time under it
        ops += [text(X_["time"], cy, r["ts"].strftime("%Y-%m-%d")), text(X_["time"], cy - LEAD, r["ts"].strftime("%H:%M:%S"))]
    else:
        ops.append(text(X_["time"], cy, r["ts"].strftime("%Y-%m-%d %H:%M:%S")))
    ops.append(text(X_["status"], cy, r["status"]))
    if r["paid"]:
        ops.append(rtext(R_["paid"], cy, money(r["paid"])))
    if r["out"]:
        ops.append(rtext(R_["withdrawn"], cy, "-" + money(r["out"])))
    ops.append(rtext(R_["balance"], cy, money(r["balance"])))


def listing_order(rows, invert_pairs=False):
    """Newest first. With invert_pairs, a payment and its charge (two rows in the same second) are printed in
    the order they happened, so the parser has to put them back in balance order."""
    out, swapped = list(reversed(rows)), 0
    if invert_pairs:
        i = 0
        while i < len(out) - 1:
            same = [j for j in range(i, len(out)) if out[j]["ts"] == out[i]["ts"]]
            if len(same) == 2 and same[-1] < len(out) - 1:
                out[i], out[i + 1] = out[i + 1], out[i]
                swapped += 1
            i = same[-1] + 1
    return out, swapped


def scanned_page():
    """A grey page with bars where text would be: a picture of a statement with no text layer."""
    w, h = 600, 850
    px = bytearray(b"\xff" * (w * h))
    rng = random.Random(99)
    for top in list(range(40, 160, 18)) + list(range(260, 800, 14)):
        x = 30
        while x < 560:
            run = rng.randint(20, 90)
            for yy in range(top, top + 6):
                px[yy * w + x: yy * w + min(x + run, 570)] = b"\x50" * (min(x + run, 570) - x)
            x += run + rng.randint(8, 30)
    return w, h, bytes(px)


# ---------------------------------------------------------------- fixtures

def ksh(c):
    return round(c / 100, 2)


def expected_rows(rows, broken=None):
    out = []
    for i, r in enumerate(rows):
        check = "Start" if i == 0 else ("Mismatch" if broken is not None and i == broken else "OK")
        out.append(dict(receipt=r["receipt"], time=r["ts"].strftime("%Y-%m-%d %H:%M:%S"), details=r["details"],
                        status=r["status"], paidIn=ksh(r["paid"]), withdrawn=ksh(r["out"]), balance=ksh(r["balance"]),
                        type=r["type"], party=r["party"], partyId=r["partyId"], account=r["account"], check=check))
    return out


def summary(rows, spec_list, mismatches=0):
    first, last = rows[0], rows[-1]
    by = lambda typ, key: ksh(sum(r[key] for r in rows if r["type"] in typ))
    single = len(spec_list) == 1
    return dict(
        name=spec_list[0]["customer"], mobile=spec_list[0]["mobile"],
        period="; ".join(s["period"] for s in spec_list),
        count=len(rows), totalIn=ksh(sum(r["paid"] for r in rows)), totalOut=ksh(sum(r["out"] for r in rows)),
        opening=ksh(first["balance"] - first["paid"] + first["out"]), closing=ksh(last["balance"]),
        charges=by(("Transaction charge", "Fuliza fee"), "out"), fulizaDrawn=by(("Fuliza drawn",), "paid"),
        fulizaRepaid=by(("Fuliza repayment",), "out"), mismatches=mismatches, guessed=0,
        pdfTotals=dict(**{"in": ksh(spec_list[0]["total_in"]), "out": ksh(spec_list[0]["total_out"])}) if single else None,
    )


def fixed(opening, items):
    """Rows written out by hand: (time, receipt, details, type, paid, out, counterparty, number, account), in cents."""
    bal, rows = opening, []
    for ts, rc, details, typ, paid, out, party, pid, acct in items:
        bal += paid - out
        rows.append(dict(receipt=rc, ts=datetime.fromisoformat(ts), details=details, status="Completed", paid=paid, out=out,
                         balance=bal, type=typ, party=party, partyId=pid, account=acct))
    return rows


def person(spec):
    return dict(customer="AMANI TESTER", mobile="254700000000", email="amani.tester@example.com", **spec)


def build(out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    files, expect = {}, {"password": PASSWORD, "statements": {}, "merges": {}}

    def statement(spec, rows, listing_rows=None, password=None, broken=None, mismatches=0):
        spec = person(spec)
        spec["all_rows"] = rows
        spec["total_in"] = sum(r["paid"] for r in rows)
        spec["total_out"] = sum(r["out"] for r in rows)
        shown = listing_rows if listing_rows is not None else rows
        listing, swapped = listing_order(shown, spec.get("invert_pairs"))
        pages = render(spec, listing, spec["total_in"], spec["total_out"])
        files[spec["name"] + ".pdf"] = pdf_document(spec["name"], pages, password)
        e = expect["statements"][spec["name"] + ".pdf"] = dict(
            pages=len(pages), password=bool(password), summary=summary(shown, [spec], mismatches),
            rows=expected_rows(shown, broken))
        if spec.get("invert_pairs"):
            e["pairs_printed_out_of_order"] = swapped
        if "split_row" in spec:
            e["split_row"] = spec["split_row"]
        return spec

    rows = generate(11, "2026-01-01", "2026-02-01", 14, 325000)
    statement(dict(name="clean_month", period="01 Jan 2026 - 31 Jan 2026", requested="02 Feb 2026"), rows)

    # the first seed from 12 up where a page break falls inside a wrapped row, so one row runs onto the next page
    for seed in range(12, 100):
        rows = generate(seed, "2026-02-01", "2026-04-01", 50, 1250000)
        try:
            statement(dict(name="multi_page", period="01 Feb 2026 - 31 Mar 2026", requested="01 Apr 2026",
                           split=True, invert_pairs=True), rows)
            break
        except NoSplit:
            continue
    else:
        raise SystemExit("multi_page: no seed gave a row across a page break")

    rows = generate(13, "2026-04-01", "2026-05-01", 30, 780000)
    cut_a, cut_b = datetime(2026, 4, 21), datetime(2026, 4, 10)
    a = [r for r in rows if r["ts"] < cut_a]
    b = [r for r in rows if r["ts"] >= cut_b]
    sa = statement(dict(name="overlap_a", period="01 Apr 2026 - 20 Apr 2026", requested="21 Apr 2026"), a)
    sb = statement(dict(name="overlap_b", period="10 Apr 2026 - 30 Apr 2026", requested="01 May 2026"), b)
    merged = [r for r in rows if r["ts"] < cut_a or r["ts"] >= cut_b]
    expect["merges"]["overlap"] = dict(files=["overlap_a.pdf", "overlap_b.pdf"], overlapping_rows=len(a) + len(b) - len(merged),
                                       summary=summary(merged, [sa, sb]), rows=expected_rows(merged))

    rows = generate(34, "2026-05-01", "2026-06-01", 22, 15000, fuliza=True)
    assert any(r["type"] == "Fuliza drawn" for r in rows) and any(r["type"] == "Fuliza repayment" for r in rows)
    statement(dict(name="fuliza", period="01 May 2026 - 31 May 2026", requested="01 Jun 2026", align="middle"), rows)

    rows = generate(15, "2026-06-01", "2026-07-01", 16, 500000)
    # drop one stand-alone payment from the printed rows; the summary TOTAL still counts it
    lone = [i for i in range(2, len(rows) - 2) if rows[i]["out"] and rows[i - 1]["ts"] != rows[i]["ts"] != rows[i + 1]["ts"]]
    gone = lone[len(lone) // 2]
    nxt = rows[gone + 1]
    d = rows[gone]["out"]
    # the parser may move a lone amount to the other column when the balance says so; make sure it cannot here
    assert d and d != 2 * (nxt["paid"] or nxt["out"])
    shown = rows[:gone] + rows[gone + 1:]
    statement(dict(name="balance_break", period="01 Jun 2026 - 30 Jun 2026", requested="01 Jul 2026"), rows,
              listing_rows=shown, broken=gone, mismatches=1)
    # the summary's TOTAL line counts the dropped row, so the statement's totals and the rows disagree
    expect["statements"]["balance_break.pdf"]["dropped_row"] = dict(receipt=rows[gone]["receipt"], withdrawn=ksh(d))

    rows = generate(16, "2026-07-01", "2026-08-01", 10, 410000)
    statement(dict(name="locked", period="01 Jul 2026 - 31 Jul 2026", requested="01 Aug 2026"), rows, password=PASSWORD)

    # Details that use the words of a page footer ("Safaricom PLC", "customer care"), on a row's first line and on a
    # wrapped line, must come out exactly as printed. The paybill and till numbers here are invented.
    rows = fixed(250000, [
        ("2026-08-02 09:15:00", "ZQD0000001", "Funds received from 0700***301 - WANJIRU TESTER", "Received money", 600000, 0, "WANJIRU TESTER", "0700***301", ""),
        ("2026-08-05 12:30:00", "ZQD0000002", "Pay Bill to 299001 - SAFARICOM PLC", "Paybill", 0, 150000, "SAFARICOM PLC", "299001", ""),
        ("2026-08-05 12:30:00", "ZQD0000002", "Pay Bill Charge", "Transaction charge", 0, 1000, "", "", ""),
        ("2026-08-09 18:45:00", "ZQD0000003", "Pay Bill Online to 299002 - HOME FIBRE BY SAFARICOM PLC Acc. 0700000001", "Paybill", 0, 290000,
         "HOME FIBRE BY SAFARICOM PLC", "299002", "0700000001"),
        ("2026-08-12 08:05:00", "ZQD0000004", "Pay Bill Online to 400500 - SAMPLE INSURANCE CUSTOMER CARE DESK Acc. 12345678", "Paybill", 0, 50000,
         "SAMPLE INSURANCE CUSTOMER CARE DESK", "400500", "12345678"),
        ("2026-08-25 10:10:00", "ZQD0000005", "Funds received from 0700***302 - OTIENO SAMPLE", "Received money", 200000, 0, "OTIENO SAMPLE", "0700***302", ""),
    ])
    statement(dict(name="details_as_printed", period="01 Aug 2026 - 31 Aug 2026", requested="01 Sep 2026"), rows)

    # headings centred over their columns, details starting well left of their heading, the time on two lines
    rows = generate(17, "2026-09-01", "2026-10-01", 16, 420000)
    statement(dict(name="centred_headings", period="01 Sep 2026 - 30 Sep 2026", requested="01 Oct 2026", layout=CENTRED), rows)
    # the same, with each row's other cells centred on its wrapped details
    rows = generate(18, "2026-10-01", "2026-11-01", 16, 380000)
    statement(dict(name="centred_middle", period="01 Oct 2026 - 31 Oct 2026", requested="01 Nov 2026", layout=CENTRED,
                   align="middle"), rows)

    files["scanned.pdf"] = pdf_document("scanned", [["q 595 0 0 842 0 0 cm /Im1 Do Q\n"]], image=scanned_page())
    expect["statements"]["scanned.pdf"] = dict(pages=1, password=False, error="no text layer")

    files["expected.json"] = (json.dumps(expect, indent=1, sort_keys=True) + "\n").encode("ascii")
    for name, data in files.items():
        (out_dir / name).write_bytes(data)
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="rebuild in a temporary folder and compare with the committed files")
    args = ap.parse_args()
    if not args.check:
        files = build(OUT)
        for name, data in sorted(files.items()):
            print(f"{name:20} {len(data):>8,} bytes")
        return
    with tempfile.TemporaryDirectory() as tmp:
        files = build(Path(tmp))
        bad = [n for n, data in files.items() if not (OUT / n).exists() or (OUT / n).read_bytes() != data]
        extra = sorted(p.name for p in OUT.iterdir() if p.name not in files)
    if bad or extra:
        print("Fixtures out of date:", ", ".join(bad + extra), "- run python tests/make_fixtures.py")
        sys.exit(1)
    print(f"{len(files)} fixture files match a fresh build.")


if __name__ == "__main__":
    main()
