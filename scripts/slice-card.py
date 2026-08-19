#!/usr/bin/env python3
"""Slice the README's hero image out of the LIVE dashboard, using the product's own CSS.

Not a redraw and not a new product surface: the running dashboard is fetched, and its own
<style> block and its own <article class="card"> markup are written into a minimal page. The
pixels are exactly what a user sees; only the surrounding chrome is dropped, so the README's
first screen is the incident card rather than a header and a counter row.

usage: slice-card.py <dashboard-url> <out.html> [n-cards]
"""
import re
import sys
import urllib.request

url, out = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 2

html = urllib.request.urlopen(url, timeout=10).read().decode("utf-8")
style = re.search(r"<style>.*?</style>", html, re.S)
if not style:
    sys.exit("no <style> block in the dashboard HTML")
cards = re.findall(r'<article class="card.*?</article>', html, re.S)[:n]
if not cards:
    sys.exit("no incident cards in the dashboard HTML - nothing to show")

with open(out, "w") as f:
    f.write(
        '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">'
        + style.group(0)
        + "<style>body{margin:0;padding:24px;background:var(--bg)}"
          "main{max-width:920px;margin:0 auto}</style>"
          "</head><body><main>" + "".join(cards) + "</main></body></html>"
    )
print(f"  sliced {len(cards)} card(s) from the live dashboard")
