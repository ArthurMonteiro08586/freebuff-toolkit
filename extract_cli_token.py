#!/usr/bin/env python3
"""Extract a freebuff CLI authToken from an existing GitHub-OAuth session.

Flow (reverse-engineered 2026-10-08):
  1. POST https://www.codebuff.com/api/auth/cli/code  {fingerprintId}
       -> {loginUrl (contains auth_code=...), fingerprintHash, expiresAt}
  2. Log in to codebuff.com via NextAuth + GitHub OAuth (same pool as reg.py):
       GET  /api/auth/csrf
       POST /api/auth/signin/github {csrfToken, callbackUrl=<loginUrl>, json:true}
       -> GitHub authorize URL -> POST login form (+ pyotp 2FA) -> authorize app
       -> GitHub consent page (422 first hit) -> parse + POST consent form
       -> follow callback chain back to codebuff.com/onboard?auth_code=...
  3. Fetch /onboard?auth_code=... with the authenticated session.
       Page contains a Next.js RSC server action form "CliLoginApproval"
       (encType="multipart/form-data") with hidden fields $ACTION_KEY,
       $ACTION_ID_*, auth_code, etc.
  4. POST ALL hidden <input> fields of that form as multipart/form-data
       -> server approves the CLI login
  5. Poll GET /api/auth/cli/status?fingerprintId=..&fingerprintHash=..&expiresAt=..
       -> {authToken: "<36 chars>"}  <- this is the CLI token for the gateway

Turnstile (sitekey 0x4AAAAAACvi5pdE5_cnLWnI) is solved via a local
captcha-solver sidecar (POST http://127.0.0.1:8877/solve) and submitted to
/api/auth/signup-challenge before starting OAuth.

Usage:
  python extract_cli_token.py                 # use first un-tried account
  python extract_cli_token.py --login <gh-login>

Inputs:
  gh_accounts.json      [{login,email,password,totp}, ...]   (pool, not in repo)
  freebuff_accounts.jsonl  output of reg.py (session cookies, optional warm start)
Outputs:
  auth_tokens.jsonl     {login, authToken, ts}
  cli_state.json        tried logins
"""
import json
import re
import sys
import time
import uuid
import argparse
import os

import requests

try:
    import pyotp
except ImportError:
    pyotp = None

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
CB = "https://www.codebuff.com"
SIDECAR = "http://127.0.0.1:8877/solve"
TS_SITEKEY = "0x4AAAAAACvi5pdE5_cnLWnI"
TIMEOUT = (10, 20)

HERE = os.path.dirname(os.path.abspath(__file__))
POOL_FILE = os.environ.get("FB_POOL", os.path.join(HERE, "gh_accounts.json"))
ACC_FILE = os.path.join(HERE, "freebuff_accounts.jsonl")
STATE_FILE = os.path.join(HERE, "cli_state.json")
OUT_FILE = os.path.join(HERE, "auth_tokens.jsonl")


def log(*a):
    print(*a, flush=True)


def load_state():
    try:
        return json.load(open(STATE_FILE, encoding="utf-8"))
    except Exception:
        return {"tried": []}


def save_state(st):
    json.dump(st, open(STATE_FILE, "w", encoding="utf-8"))


def solve_turnstile(url):
    r = requests.post(SIDECAR, json={
        "type": "turnstile", "sitekey": TS_SITEKEY, "url": url, "real_page": True,
    }, timeout=(5, 180))
    r.raise_for_status()
    d = r.json()
    tok = d.get("token") or d.get("solution") or d.get("result", {}).get("token")
    if not tok:
        raise RuntimeError(f"sidecar returned no token: {str(d)[:200]}")
    return tok


def signup_challenge(s, base):
    tok = solve_turnstile(base + "/login")
    r = s.post(base + "/api/auth/signup-challenge", json={"token": tok}, timeout=TIMEOUT)
    return r.status_code


def hidden_inputs(html):
    return re.findall(
        r'<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"', html)


def all_form_fields(html):
    """Every <input> with name+value (hidden or not), order preserved."""
    fields = []
    for m in re.finditer(r'<input([^>]*)>', html):
        attrs = dict(re.findall(r'(\w[\w-]*)="([^"]*)"', m.group(1)))
        if "name" in attrs:
            fields.append((attrs["name"], attrs.get("value", "")))
    return fields


def gh_login(s, auth_url, acc):
    """Log in on github.com starting from an OAuth authorize URL.
    Returns the page HTML we land on after authorize/consent."""
    r = s.get(auth_url, timeout=TIMEOUT)
    html = r.text
    # password login form
    fields = dict(all_form_fields(html))
    if "login" in fields or "password" in fields or "session[password]" in html:
        post_url = re.search(r'<form[^>]+action="([^"]+)"', html)
        action = post_url.group(1) if post_url else "https://github.com/session"
        if action.startswith("/"):
            action = "https://github.com" + action
        data = dict(all_form_fields(html))
        data["login"] = acc["email"]
        data["password"] = acc["password"]
        data.pop("webauthn-conditional", None)
        rr = s.post(action, data=data, timeout=TIMEOUT, allow_redirects=False)
        loc = rr.headers.get("Location", "")
        # 2FA?
        if rr.status_code in (200, 302):
            if "two_factor" in rr.url or "app_otp" in rr.text or "otp" in loc.lower():
                if not pyotp or not acc.get("totp"):
                    raise RuntimeError("2FA required but no totp/pyotp")
                code = pyotp.TOTP(acc["totp"]).now()
                page = rr.text if rr.status_code == 200 else s.get(
                    loc if loc.startswith("http") else "https://github.com" + loc,
                    timeout=TIMEOUT).text
                m = re.search(r'<form[^>]+action="([^"]+)"', page)
                action2 = m.group(1) if m else "https://github.com/sessions/two-factor"
                if action2.startswith("/"):
                    action2 = "https://github.com" + action2
                data2 = dict(all_form_fields(page))
                data2["app_otp"] = code
                rr2 = s.post(action2, data=data2, timeout=TIMEOUT,
                             allow_redirects=False)
                loc = rr2.headers.get("Location", "")
                if loc:
                    r = s.get(loc if loc.startswith("http")
                              else "https://github.com" + loc, timeout=TIMEOUT)
                    html = r.text
                else:
                    html = rr2.text
            else:
                if loc:
                    r = s.get(loc if loc.startswith("http")
                              else "https://github.com" + loc, timeout=TIMEOUT,
                              allow_redirects=False)
                    html = r.text
                    if "meta" in html and "refresh" in html:
                        m = re.search(r'url=([^"\']+)', html)
                        if m:
                            r = s.get(m.group(1), timeout=TIMEOUT)
                            html = r.text
                else:
                    html = rr.text
    return html


def gh_consent(s, html):
    """Handle the GitHub OAuth consent page (POST to authorize the app)."""
    if "authorize" not in html and "authenticity_token" not in html:
        return html
    m = re.search(r'<form[^>]+action="([^"]*authorize[^"]*)"', html)
    if not m:
        return html
    action = m.group(1)
    if action.startswith("/"):
        action = "https://github.com" + action
    data = dict(all_form_fields(html))
    r = s.post(action, data=data, timeout=TIMEOUT)
    return r.text


def meta_refresh(html):
    m = re.search(r'url=([^"\']+)', html)
    return m.group(1) if m else None


def nextauth_github(s, base, callback_url):
    csrf = s.get(base + "/api/auth/csrf", timeout=TIMEOUT).json()["csrfToken"]
    r = s.post(base + "/api/auth/signin/github",
               data={"csrfToken": csrf, "callbackUrl": callback_url, "json": "true"},
               headers={"Content-Type": "application/x-www-form-urlencoded"},
               timeout=TIMEOUT)
    return r.json()["url"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--login", default=None)
    args = ap.parse_args()

    pool = json.load(open(POOL_FILE, encoding="utf-8"))
    st = load_state()
    tried = set(st["tried"])
    if args.login:
        acc = next(a for a in pool if a["login"] == args.login)
    else:
        acc = next((a for a in pool if a["login"] not in tried), None)
    if not acc:
        log("no untried accounts left")
        return 1
    log(f"[*] account {acc['login']}")

    s = requests.Session()
    s.headers.update({"User-Agent": UA})

    # 1) CLI code
    fp = "codebuff-cli-" + uuid.uuid4().hex[:8]
    r = s.post(CB + "/api/auth/cli/code", json={"fingerprintId": fp}, timeout=TIMEOUT)
    if r.status_code != 200:
        # maybe need signup-challenge first
        signup_challenge(s, CB)
        r = s.post(CB + "/api/auth/cli/code", json={"fingerprintId": fp}, timeout=TIMEOUT)
    d = r.json()
    login_url = d["loginUrl"]
    auth_code = re.search(r"auth_code=([^&]+)", login_url).group(1)
    log(f"[*] cli code ok, auth_code={auth_code[:8]}..., expires={d.get('expiresAt')}")

    # 2) OAuth into codebuff with callbackUrl = loginUrl
    gh_url = nextauth_github(s, CB, login_url)
    html = gh_login(s, gh_url, acc)
    st["tried"].append(acc["login"])
    save_state(st)
    if "OAuth application authorized" in html or meta_refresh(html):
        target = meta_refresh(html)
        if target:
            html = s.get(target, timeout=TIMEOUT).text
    html = gh_consent(s, html)

    # 3) onboard page with the action form
    time.sleep(1)
    ob = s.get(f"{CB}/onboard?auth_code={auth_code}", timeout=TIMEOUT)
    if ob.status_code != 200 or "ACTION_KEY" not in ob.text:
        ob = s.get(f"{CB}/onboard?auth_code={auth_code}", timeout=TIMEOUT)
    if "ACTION_KEY" not in ob.text:
        log(f"[!] no CliLoginApproval form on onboard page ({ob.status_code}, {len(ob.text)}b)")
        open(os.path.join(HERE, "onboard_debug.html"), "w",
             encoding="utf-8").write(ob.text)
        return 2

    # 4) POST ALL hidden fields as multipart
    fields = all_form_fields(ob.text)
    files = [(n, (None, v)) for n, v in fields]
    r = s.post(ob.url, files=files, timeout=(10, 60),
               headers={"Origin": CB, "Referer": ob.url})
    log(f"[*] approval POST {r.status_code} ({len(r.text)}b)")

    # 5) poll cli status for authToken
    token = None
    for i in range(30):
        r = s.get(CB + "/api/auth/cli/status", params={
            "fingerprintId": fp,
            "fingerprintHash": d.get("fingerprintHash", ""),
            "expiresAt": d.get("expiresAt", ""),
        }, timeout=TIMEOUT)
        try:
            j = r.json()
        except Exception:
            j = {}
        token = j.get("authToken")
        if token:
            break
        time.sleep(2)
    if not token:
        log("[!] no authToken after polling")
        return 3
    rec = {"login": acc["login"], "authToken": token, "ts": int(time.time())}
    with open(OUT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")
    log(f"[+] OK {acc['login']} token len={len(token)} -> auth_tokens.jsonl")
    return 0


if __name__ == "__main__":
    sys.exit(main())
