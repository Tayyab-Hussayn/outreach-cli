"""
Website email finder for the Google Maps scraper.

The scraper engine only returns emails through a paid API key, so this module
finds them itself: it reads each business's own website (homepage plus a few
contact/about pages) and collects the addresses published there.
"""

import re
import sys
from concurrent.futures import ThreadPoolExecutor
from html import unescape
from urllib.parse import urljoin, urlparse, unquote

import requests

TIMEOUT = 8
MAX_PAGES_PER_SITE = 4
MAX_PAGE_BYTES = 1_500_000
WORKERS = 6

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/130.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

# "Websites" that are really social/listing pages: not the business's own site, no use scanning.
SKIP_HOSTS = (
    "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "youtube.com",
    "tiktok.com", "wa.me", "whatsapp.com", "linktr.ee", "foodpanda.pk", "foodpanda.com",
    "google.com", "goo.gl", "maps.app.goo.gl", "tripadvisor.com", "yelp.com",
)

CONTACT_PATHS = ("/contact", "/contact-us", "/contactus", "/about", "/about-us")
CONTACT_HINT = re.compile(r"contact|about|reach|get-in-touch|support", re.I)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,24}")
CFEMAIL_RE = re.compile(r'data-cfemail="([0-9a-fA-F]+)"')
MAILTO_RE = re.compile(r'href=["\']mailto:([^"\'?>\s]+)', re.I)
HREF_RE = re.compile(r'href=["\']([^"\'#]+)', re.I)
# "name [at] domain [dot] com" style obfuscation
OBFUSCATED_RE = re.compile(
    r"([A-Za-z0-9._%+\-]+)\s*[\[\(\{]\s*at\s*[\]\)\}]\s*([A-Za-z0-9\-]+(?:\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*[A-Za-z0-9\-]+)+)",
    re.I,
)

JUNK_TLDS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "css", "js", "woff", "woff2", "ico", "pdf", "mp4"}
JUNK_DOMAINS = (
    "example.com", "example.org", "domain.com", "email.com", "yourdomain.com", "yoursite.com",
    "sentry.io", "sentry.wixpress.com", "wixpress.com", "wix.com", "godaddy.com",
    "squarespace.com", "shopify.com", "myshopify.com", "wordpress.com", "w3.org", "schema.org",
)
JUNK_LOCALS = {"name", "yourname", "your", "email", "youremail", "user", "username", "test", "example",
               "john", "johndoe", "firstname", "lastname", "someone", "you", "mail"}
# Roles first: a business inbox beats a personal one for outreach.
ROLE_LOCALS = ("info", "contact", "hello", "sales", "support", "enquiry", "enquiries", "inquiry",
               "inquiries", "reservations", "reservation", "booking", "bookings", "orders", "admin", "office")


def _decode_cfemail(hexstr):
    """Decodes Cloudflare's email protection (data-cfemail)."""
    try:
        key = int(hexstr[:2], 16)
        return "".join(chr(int(hexstr[i:i + 2], 16) ^ key) for i in range(2, len(hexstr), 2))
    except ValueError:
        return None


def _is_valid(email):
    email = email.strip().strip(".,;:<>()[]\"'").lower()
    if email.count("@") != 1 or len(email) > 254:
        return None
    local, domain = email.split("@")
    if not local or local in JUNK_LOCALS or len(local) > 64:
        return None
    tld = domain.rsplit(".", 1)[-1]
    if tld in JUNK_TLDS or not tld.isalpha():
        return None
    if any(domain == d or domain.endswith("." + d) for d in JUNK_DOMAINS):
        return None
    if re.search(r"\d{6,}x?\d*$", local) and len(local) > 20:  # hash-like tracking ids
        return None
    if ".." in email or domain.startswith(("-", ".")):
        return None
    return email


def extract_emails_from_html(html):
    found = []
    text = unescape(html)
    for m in MAILTO_RE.finditer(text):
        found.append(unquote(m.group(1)))
    for m in CFEMAIL_RE.finditer(text):
        decoded = _decode_cfemail(m.group(1))
        if decoded:
            found.append(decoded)
    for m in OBFUSCATED_RE.finditer(text):
        domain = re.sub(r"\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*", ".", m.group(2), flags=re.I)
        found.append(f"{m.group(1)}@{domain}")
    # Drop script/style bodies for the plain-text pass, so JS/CSS noise doesn't leak in.
    visible = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
    found.extend(EMAIL_RE.findall(visible))

    result = []
    for raw in found:
        email = _is_valid(raw)
        if email and email not in result:
            result.append(email)
    return result


def _fetch(session, url):
    try:
        resp = session.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True, stream=True)
        ctype = resp.headers.get("Content-Type", "")
        if resp.status_code != 200 or ("html" not in ctype and "text" not in ctype):
            resp.close()
            return None, None
        body = resp.raw.read(MAX_PAGE_BYTES, decode_content=True)
        resp.close()
        return body.decode(resp.encoding or "utf-8", errors="replace"), resp.url
    except Exception:
        return None, None


def _normalize_site(website):
    if not website or not isinstance(website, str):
        return None
    url = website.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    host = (urlparse(url).hostname or "").lower()
    if not host or "." not in host:
        return None
    if any(host == h or host.endswith("." + h) for h in SKIP_HOSTS):
        return None
    return url


def _rank(email, site_host):
    local, domain = email.split("@")
    site = site_host.removeprefix("www.")
    own = domain == site or domain.endswith("." + site) or site.endswith("." + domain)
    role = local.split("+")[0] in ROLE_LOCALS
    return (0 if own else 1, 0 if role else 1)


def find_emails_for_website(website):
    """Returns a list of emails found on the business's website (best first). Never raises."""
    base = _normalize_site(website)
    if not base:
        return []
    session = requests.Session()
    try:
        html, final_url = _fetch(session, base)
        if html is None and base.startswith("https://"):
            html, final_url = _fetch(session, "http://" + base[len("https://"):])
        if html is None:
            return []

        site_host = (urlparse(final_url).hostname or "").lower()
        origin = f"{urlparse(final_url).scheme}://{urlparse(final_url).netloc}"
        emails = list(extract_emails_from_html(html))

        # Candidate sub-pages: contact-looking links on the homepage first, then common paths.
        candidates = []
        for href in HREF_RE.findall(html):
            full = urljoin(final_url, unescape(href))
            p = urlparse(full)
            if (p.hostname or "").lower().removeprefix("www.") != site_host.removeprefix("www."):
                continue
            if CONTACT_HINT.search(p.path) and not re.search(r"\.(png|jpe?g|gif|svg|pdf|css|js)$", p.path, re.I):
                if full not in candidates and full.rstrip("/") != final_url.rstrip("/"):
                    candidates.append(full)
        for path in CONTACT_PATHS:
            full = origin + path
            if full not in candidates:
                candidates.append(full)

        fetched = 1
        for url in candidates:
            if fetched >= MAX_PAGES_PER_SITE or (emails and fetched >= 2):
                break
            page, _ = _fetch(session, url)
            if page is None:
                continue
            fetched += 1
            for e in extract_emails_from_html(page):
                if e not in emails:
                    emails.append(e)

        emails.sort(key=lambda e: _rank(e, site_host))
        return emails
    except Exception:
        return []
    finally:
        session.close()


def enrich_with_emails(places, log=lambda msg: None):
    """Adds an `emails` list to every place (empty when none found). Mutates and returns `places`."""
    targets = [p for p in places if isinstance(p, dict)]
    websites = [p.get("website") if isinstance(p.get("website"), str) and p.get("website", "").startswith("http") else None
                for p in targets]
    log(f"[Emails] Scanning {sum(1 for w in websites if w)} website(s) for contact emails...")
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(lambda w: find_emails_for_website(w) if w else [], websites))
    for place, emails in zip(targets, results):
        place["emails"] = emails
    log(f"[Emails] Found emails for {sum(1 for r in results if r)} of {len(targets)} place(s).")
    return places


if __name__ == "__main__":
    for site in sys.argv[1:]:
        print(site, "->", find_emails_for_website(site))
