"""Fail if a text file in the repo holds a non-ASCII character or a phrase that reads as machine-written.

    python tests/check_text.py

The vendored builds (lib/*.min.js) are left out. The third-party license texts in LICENSES/ are checked
for plain ASCII only, since their wording is not ours to change.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT = {".html", ".css", ".js", ".mjs", ".py", ".md", ".json", ".txt", ".yml", ".yaml", ".gitignore", ".gitattributes"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", "output", "private"}
BANNED = [
    "delve", "leverage", "leveraging", "seamless", "seamlessly", "robust", "not just", "not only", "in today's",
    "fast-paced", "cutting-edge", "game-changer", "game changer", "unlock", "unleash", "empower", "elevate",
    "tapestry", "testament to", "dive into", "deep dive", "harness", "synergy", "holistic", "streamline",
    "revolutionize", "revolutionise", "best-in-class", "world-class", "state-of-the-art", "furthermore", "moreover",
    "in conclusion", "worth noting", "it is important to note", "navigate the", "ever-evolving", "embark",
    "realm", "showcase", "meticulous", "pivotal", "paramount", "supercharge", "next-level", "journey",
]
PATTERN = re.compile(r"\b(" + "|".join(re.escape(b) for b in BANNED) + r")\b", re.I)


def files():
    for p in sorted(ROOT.rglob("*")):
        rel = p.relative_to(ROOT)
        if not p.is_file() or set(rel.parts) & SKIP_DIRS:
            continue
        if p.suffix.lower() in TEXT or p.name in TEXT:
            if not (rel.parts[0] == "lib" and p.name.endswith(".min.js")):
                yield p, rel


def main():
    problems, count = [], 0
    for p, rel in files():
        count += 1
        own = rel.parts[0] != "LICENSES" and p.resolve() != Path(__file__).resolve()
        for i, line in enumerate(p.read_bytes().split(b"\n"), 1):
            if any(b > 127 for b in line):
                problems.append(f"{rel.as_posix()}:{i}: non-ASCII")
            if own:
                for m in PATTERN.finditer(line.decode("ascii", "replace")):
                    problems.append(f"{rel.as_posix()}:{i}: phrase '{m.group(0)}'")
    print(f"{count} text files checked.")
    if problems:
        print(f"{len(problems)} problems:")
        for x in problems:
            print("  " + x)
        sys.exit(1)
    print("All plain ASCII, no flagged phrases.")


if __name__ == "__main__":
    main()
