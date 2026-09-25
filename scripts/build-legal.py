#!/usr/bin/env python3
"""Regenerate /privacy, /terms, /safety from the app repo's markdown.

The markdown in the PoolHelp repo is the source of truth (it also feeds the
in-app legal screens). Run this after any edit there, commit, push, redeploy.
Usage: python3 scripts/build-legal.py [path-to-poolhelp-repo]
"""
import html
import re
import sys
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else '../PoolHelp')
SITE = Path(__file__).resolve().parent.parent

PAGES = [
    ('PRIVACY.md', 'privacy', 'Privacy Policy'),
    ('TERMS.md', 'terms', 'Terms of Service'),
    ('SAFETY.md', 'safety', 'Safety & Disclaimer'),
]

SHELL = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — PoolHelp</title>
<meta name="description" content="PoolHelp {title}.">
<link rel="stylesheet" href="/assets/style.css">
<link rel="icon" href="/assets/img/favicon.png">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
<link rel="canonical" href="https://poolhelp.app/{slug}/">
<meta name="robots" content="index,follow">
</head>
<body>
<div class="water" aria-hidden="true"></div>
<header class="site">
  <div class="wrap">
    <a class="brand" href="/"><img src="/assets/img/favicon.png" alt="" width="28" height="28">PoolHelp</a>
    <nav class="top" aria-label="Site">
      <a href="/#features" class="hide-sm">Features</a>
      <a href="/#pricing" class="hide-sm">Pricing</a>
      <a href="/help/">Help</a>
      <a href="/support/">Support</a>
    </nav>
  </div>
</header>
<main><article class="doc">
{body}
</article></main>
<footer class="site">
  <div class="wrap">
    <span>© 2026 Sabesoft LLC · support@poolhelp.app</span>
    <nav aria-label="Legal">
      <a href="/privacy/">Privacy</a>
      <a href="/terms/">Terms</a>
      <a href="/safety/">Safety</a>
      <a href="/help/">Help</a>
      <a href="/support/">Support</a>
    </nav>
  </div>
</footer>
</body>
</html>
"""

A_TAG = re.compile(r'<a\b[^>]*>.*?</a>', re.S)

def outside_links(text: str, fn) -> str:
    """Apply fn to the stretches of text that are not already inside an <a>."""
    parts, pos = [], 0
    for m in A_TAG.finditer(text):
        parts.append(fn(text[pos:m.start()]))
        parts.append(m.group(0))
        pos = m.end()
    parts.append(fn(text[pos:]))
    return ''.join(parts)

def md_link(m: re.Match) -> str:
    text, href = m.group(1), m.group(2)
    rel = ' rel="noopener"' if href.startswith('http') else ''
    return f'<a href="{href}"{rel}>{text}</a>'

def autolink(text: str) -> str:
    # Linkify explicit URLs and the bare policy domains the docs mention.
    text = re.sub(r'(https?://[^\s<)]+)', r'<a href="\1" rel="noopener">\1</a>', text)
    text = re.sub(r'(?<![/\w])((?:revenuecat|sentry)\.(?:com|io)/privacy)',
                  r'<a href="https://\1" rel="noopener">\1</a>', text)
    return text.replace('support@poolhelp.app',
                        '<a href="mailto:support@poolhelp.app">support@poolhelp.app</a>')

def inline(text: str) -> str:
    out = html.escape(text, quote=False)
    out = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', out)
    # Markdown links first (relative, mailto: and http(s) hrefs); the
    # autolinkers then only touch text that is not already inside an <a>.
    out = re.sub(r'\[([^\]]+)\]\(((?:https?://|mailto:|/)[^)\s]+)\)', md_link, out)
    return outside_links(out, autolink)

def md_to_html(md: str) -> str:
    lines, out, para, ul = md.splitlines(), [], [], False
    def flush_para():
        nonlocal para
        if para:
            out.append(f'<p>{inline(" ".join(para))}</p>')
            para = []
    def close_ul():
        nonlocal ul
        if ul:
            out.append('</ul>')
            ul = False
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith('### '):
            flush_para(); close_ul(); out.append(f'<h3>{inline(s[4:])}</h3>')
        elif s.startswith('## '):
            flush_para(); close_ul(); out.append(f'<h2>{inline(s[3:])}</h2>')
        elif s.startswith('# '):
            flush_para(); close_ul(); out.append(f'<h1>{inline(s[2:])}</h1>')
        elif s.startswith('- '):
            flush_para()
            if not ul:
                out.append('<ul>'); ul = True
            out.append(f'<li>{inline(s[2:])}</li>')
        elif s == '':
            flush_para()
            # A blank line between bullets keeps one list: only close it when
            # the next non-blank line is not another bullet.
            nxt = next((l.strip() for l in lines[i + 1:] if l.strip()), '')
            if not nxt.startswith('- '):
                close_ul()
        else:
            close_ul(); para.append(s)
    flush_para(); close_ul()
    body = '\n'.join(out)
    # The "Last updated" line reads better as a subtitle, bold or not.
    body = re.sub(r'<p>(?:<strong>)?(Last updated:)(?:</strong>)?([^<]*?)(?:</strong>)?</p>',
                  r'<p class="updated"><strong>\1\2</strong></p>', body)
    return body

for src, slug, title in PAGES:
    md = (REPO / src).read_text()
    page = SHELL.format(title=title, slug=slug, body=md_to_html(md))
    dest = SITE / slug / 'index.html'
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(page)
    print(f'{slug}/index.html  ←  {src}  ({len(page)} bytes)')
