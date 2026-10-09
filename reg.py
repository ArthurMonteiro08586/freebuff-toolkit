# freebuff.com GitHub OAuth regger — iterates pool until success
import requests, re, json, time, sys, os, pyotp
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
HERE_DIR = os.path.dirname(os.path.abspath(__file__))
POOL = os.environ.get('FB_POOL', os.path.join(HERE_DIR, 'gh_accounts.json'))
OUT = os.path.join(HERE_DIR, 'freebuff_accounts.jsonl')
STATE = os.path.join(HERE_DIR, 'state.json')

def load_state():
    if os.path.exists(STATE):
        return json.load(open(STATE))
    return {'tried': []}

def save_state(st):
    json.dump(st, open(STATE, 'w'), indent=1)

def hv(page, name):
    m = re.search(r'<input[^>]*name="%s"[^>]*value="([^"]*)"' % re.escape(name), page)
    return m.group(1) if m else None

def try_account(acc):
    login = acc['login']
    s = requests.Session()
    s.headers.update({'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9'})
    # 1) NextAuth csrf + signin/github
    tok = s.get('https://freebuff.com/api/auth/csrf', timeout=30).json()['csrfToken']
    auth_url = s.post('https://freebuff.com/api/auth/signin/github',
                      data={'csrfToken': tok, 'callbackUrl': 'https://freebuff.com/', 'json': 'true'},
                      timeout=30).json()['url']
    # 2) GitHub login page
    r = s.get(auth_url, timeout=30)
    page = r.text
    if 'authenticity_token' not in page:
        return {'login': login, 'status': 'FAIL', 'reason': 'no login form'}
    fields = {
        'authenticity_token': hv(page, 'authenticity_token'), 'login': acc['email'],
        'password': acc['password'], 'webauthn-conditional': 'undefined',
        'javascript-support': 'enabled', 'webauthn-support': 'supported',
        'webauthn-iuvpaa-support': 'unknown', 'webauthn-iuv': 'false',
        'return_to': hv(page, 'return_to'), 'allow_signup': '', 'client_id': hv(page, 'client_id'),
        'integration': '', 'required_field_fcb7': '', 'timestamp': str(int(time.time()*1000)),
        'timestamp_secret': hv(page, 'timestamp_secret'), 'commit': 'Sign in'}
    r = s.post('https://github.com/session', data=fields, allow_redirects=False,
               headers={'Referer': r.url, 'Origin': 'https://github.com'}, timeout=30)
    if r.status_code == 502:
        return {'login': login, 'status': 'FAIL', 'reason': 'gh 502 on /session'}
    if r.status_code not in (301, 302, 303):
        # maybe wrong password -> stays on login with error
        return {'login': login, 'status': 'FAIL', 'reason': f'session {r.status_code}'}
    loc = r.headers['Location']
    # 3) 2FA
    if 'two-factor' in loc or 'two_factor' in loc:
        r2 = s.get(loc if loc.startswith('http') else 'https://github.com'+loc, timeout=30)
        at2 = re.search(r'name="authenticity_token"[^>]*value="([^"]+)"', r2.text)
        if not at2:
            return {'login': login, 'status': 'FAIL', 'reason': 'no 2fa token'}
        r3 = s.post('https://github.com/sessions/two-factor',
                    data={'authenticity_token': at2.group(1), 'app_otp': pyotp.TOTP(acc['totp']).now()},
                    allow_redirects=False, headers={'Referer': r2.url}, timeout=30)
        if r3.status_code not in (301, 302, 303):
            return {'login': login, 'status': 'FAIL', 'reason': f'2fa {r3.status_code}'}
        loc = r3.headers['Location']
    # 4) authorize — follow redirects
    url = loc.replace('&amp;', '&')
    if not url.startswith('http'):
        url = 'https://github.com' + url
    r4 = s.get(url, allow_redirects=True, timeout=(10,20))
    body = r4.text.lower()
    if 'cannot authorize a third party application' in body or 'this account is flagged' in body:
        return {'login': login, 'status': 'FLAGGED', 'reason': 'gh flagged, cannot authorize'}
    if 'two_factor_checkup' in r4.url:
        return {'login': login, 'status': 'FAIL', 'reason': 'checkup page'}
    # 5) freebuff session
    sess = s.get('https://freebuff.com/api/auth/session', timeout=30).json()
    if not sess:
        return {'login': login, 'status': 'FAIL', 'reason': f'fb session empty (final {r4.url[:80]})'}
    cookies = {c.name: c.value for c in s.cookies if 'freebuff' in (c.domain or '')}
    return {'login': login, 'status': 'OK', 'session': sess, 'cookies': cookies,
            'email': acc['email'], 'totp': acc['totp'], 'password': acc['password']}

def main():
    n_max = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    accs = json.load(open(POOL))
    st = load_state()
    tried = set(st['tried'])
    ok = fail = 0
    for acc in accs:
        if acc['login'] in tried:
            continue
        if ok >= n_max:
            break
        tried.add(acc['login'])
        try:
            res = try_account(acc)
        except Exception as e:
            res = {'login': acc['login'], 'status': 'ERROR', 'reason': str(e)[:200]}
        print(f"[{res['status']}] {res['login']} — {res.get('reason','')[:120]}", flush=True)
        if res['status'] == 'OK':
            ok += 1
            with open(OUT, 'a', encoding='utf-8') as f:
                f.write(json.dumps(res, ensure_ascii=False) + '\n')
            print('  user:', json.dumps(res['session'])[:300])
        else:
            fail += 1
        st['tried'] = sorted(tried)
        save_state(st)
        time.sleep(2)
    print(f'DONE ok={ok} fail={fail}')

if __name__ == '__main__':
    main()
