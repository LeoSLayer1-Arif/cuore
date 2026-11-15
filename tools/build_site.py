"""Build the public website (heartware.health) into docs/ for GitHub Pages.

The site is the CUORE homepage plus a "Run CUORE" page. It is static: no
server code, no camera, no measurements. The measuring app stays on the
user's own computer (server.py), so the public site never receives video.

    python3 tools/build_site.py

Source files live in web/ and are copied, never edited here. Every rewrite
must match exactly once, so a change to home.html that breaks an assumption
stops the build instead of publishing a half-converted page.
"""
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
OUT = os.path.join(ROOT, "docs")
MARKER = ".cuore-site"          # only a folder this script made is ever deleted
DOMAIN = "heartware.health"

ASSETS = ["home.css", "home.js", "logo.png", "heart.png", "icon-180.png", "icon-192.png"]

# GitHub Pages can't send response headers, so the policy goes in a meta tag.
# (frame-ancestors and Permissions-Policy can't be set this way; the site has no camera use.)
CSP = ("default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'none'")
CSP_META = f'  <meta http-equiv="Content-Security-Policy" content="{CSP}">\n'
REFERRER_META = '  <meta name="referrer" content="strict-origin-when-cross-origin">\n'

HOSTING_NOTE = (
    '          <li><svg class="ic"><use href="#i-lock"/></svg><div><b>This website</b>'
    '<span>heartware.health is a static page hosted on GitHub Pages. It has no analytics or '
    'trackers and never receives camera video; like any website, the host keeps standard access '
    'logs (such as IP address and time).</span></div></li>\n')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"build_site: expected one '{label}' in the source, found {count}")
    return text.replace(old, new)


def head_meta(html):
    return replace_once(html, '  <meta charset="utf-8">\n', '  <meta charset="utf-8">\n' + CSP_META + REFERRER_META, "charset")


def build_home():
    with open(os.path.join(WEB, "home.html"), encoding="utf-8") as f:
        html = f.read()
    html = head_meta(html)
    # the installable-app tags point at /app, which only exists on the local server
    for tag in ['  <link rel="manifest" href="/static/manifest.json">\n',
                '  <meta name="mobile-web-app-capable" content="yes">\n',
                '  <meta name="apple-mobile-web-app-capable" content="yes">\n',
                '  <meta name="apple-mobile-web-app-title" content="CUORE">\n',
                '  <meta name="apple-mobile-web-app-status-bar-style" content="default">\n']:
        html = replace_once(html, tag, "", tag.strip()[:40])
    # "Open CUORE" can't open a local app from a public website: it leads to the Run page
    rewrites = [
        ('<a class="btn btn-primary nav-cta" href="/app">Open CUORE', '<a class="btn btn-primary nav-cta" href="/run.html">Run CUORE'),
        ('<a class="btn btn-primary" href="/app">Open CUORE</a>', '<a class="btn btn-primary" href="/run.html">Run CUORE</a>'),
        ('<a class="btn btn-primary btn-lg" href="/app">Open CUORE', '<a class="btn btn-primary btn-lg" href="/run.html">Run CUORE'),
        ('<a class="btn btn-invert btn-lg" href="/app">Open CUORE', '<a class="btn btn-invert btn-lg" href="/run.html">Run CUORE'),
        ('<a href="/app">Open CUORE</a>', '<a href="/run.html">Run CUORE</a>'),
    ]
    for old, new in rewrites:
        html = replace_once(html, old, new, old[:40])
    if 'href="/app"' in html:
        raise SystemExit("build_site: a link to /app is left; the public site has no app")
    html = replace_once(html, '        </ul>\n      </div>\n    </section>\n\n    <!-- ===================================================== 08 INTERFACE -->',
                        HOSTING_NOTE + '        </ul>\n      </div>\n    </section>\n\n    <!-- ===================================================== 08 INTERFACE -->',
                        "end of privacy list")
    return html


def build_run():
    with open(os.path.join(WEB, "run.html"), encoding="utf-8") as f:
        return head_meta(f.read())


def main():
    if os.path.exists(OUT):
        if not os.path.exists(os.path.join(OUT, MARKER)):
            raise SystemExit(f"build_site: {OUT} exists and wasn't made by this script; not touching it")
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "static"))
    pages = {"index.html": build_home(), "run.html": build_run()}
    for name, html in pages.items():
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
            f.write(html)
    for asset in ASSETS:
        shutil.copy2(os.path.join(WEB, asset), os.path.join(OUT, "static", asset))
    with open(os.path.join(OUT, "CNAME"), "w") as f:
        f.write(DOMAIN + "\n")                       # GitHub Pages custom domain
    open(os.path.join(OUT, ".nojekyll"), "w").close()  # serve files as they are
    open(os.path.join(OUT, MARKER), "w").close()
    print(f"Built {len(pages)} pages and {len(ASSETS)} assets into {OUT} for {DOMAIN}")


if __name__ == "__main__":
    main()
