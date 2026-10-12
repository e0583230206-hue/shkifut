"""One-time authorisation of dr@30206.co.il to post to the Chat space. Run on YOUR computer.

    python bridge/chat_oauth.py --client <client_secret_....json of the *Desktop app* OAuth client> \
        --push root@45.93.95.182 --key ~/.ssh/thechannel_deploy

What happens:
  1. a browser opens Google's consent page (a local helper receives the answer on http://127.0.0.1:<port>);
  2. you sign in as dr@30206.co.il and allow "send messages in Google Chat";
  3. the script checks that the account really is dr@ (not another account), then stores the refresh token in
     /opt/bridge/.env on the server over SSH. Nothing secret is printed or written to this computer.
Run it again whenever the authorisation has to be renewed (the bridge posts an alert in the space when that happens).
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

SCOPES = "https://www.googleapis.com/auth/chat.messages.create openid email"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"


def pkce():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def jwt_payload(id_token):
    """The id_token comes straight from Google over TLS in the token response, so its payload can be read as is."""
    part = id_token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def wait_for_code(state, port_holder, timeout=300):
    """Local server that receives Google's redirect. Returns the authorisation code."""
    result = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state", [""])[0] != state:
                self.send_response(400); self.end_headers(); self.wfile.write(b"state mismatch"); return
            result["code"] = q.get("code", [""])[0]
            result["error"] = q.get("error", [""])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<html dir=rtl><body style='font:20px sans-serif;padding:2em'>ההרשאה התקבלה. אפשר לסגור את החלון ולחזור לטרמינל.</body></html>".encode("utf-8"))
            done.set()

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port_holder.append(srv.server_address[1])
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return result, done, srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--client", required=True)
    ap.add_argument("--account", default="dr@30206.co.il")
    ap.add_argument("--push", help="ssh target, e.g. root@45.93.95.182")
    ap.add_argument("--key", help="ssh private key file")
    ap.add_argument("--env-file", default="/opt/bridge/.env")
    args = ap.parse_args()

    with open(args.client, encoding="utf-8") as f:
        cfg = json.load(f)
    c = cfg.get("installed") or cfg.get("web")
    if "installed" not in cfg:
        sys.exit("This is not a *Desktop app* OAuth client (the JSON has no 'installed' section). Create one as described in the guide.")
    client_id, client_secret = c["client_id"], c["client_secret"]

    verifier, challenge = pkce()
    state = secrets.token_urlsafe(24)
    port = []
    result, done, srv = wait_for_code(state, port)
    redirect = f"http://127.0.0.1:{port[0]}"
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": SCOPES, "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256", "access_type": "offline", "prompt": "consent",
        "login_hint": args.account,
    })
    print(f"Opening the Google consent page. Sign in as {args.account}.")
    print("If no window opens, copy this address into the browser:\n" + url + "\n")
    webbrowser.open(url)
    if not done.wait(300):
        sys.exit("Timed out waiting for the browser (5 minutes).")
    srv.shutdown()
    if result.get("error") or not result.get("code"):
        sys.exit("Google returned an error: " + (result.get("error") or "no code"))

    data = urllib.parse.urlencode({"code": result["code"], "client_id": client_id, "client_secret": client_secret,
                                   "redirect_uri": redirect, "grant_type": "authorization_code", "code_verifier": verifier}).encode()
    try:
        tok = json.loads(urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=data), timeout=30).read())
    except urllib.error.HTTPError as e:
        sys.exit("Token exchange failed: " + e.read().decode()[:300])

    email = (jwt_payload(tok["id_token"]).get("email") or "").lower() if tok.get("id_token") else ""
    if email != args.account.lower():
        sys.exit(f"You authorised {email or 'an unknown account'}, not {args.account}. Nothing was saved. Run again and choose {args.account}.")
    if "chat.messages.create" not in tok.get("scope", ""):
        sys.exit("The chat.messages.create permission was not granted (tick it on the consent page). Nothing was saved.")
    if not tok.get("refresh_token"):
        sys.exit("Google returned no refresh token. Remove the app at myaccount.google.com/permissions and run again.")
    print(f"Authorised: {email}; permission granted; refresh token received (length {len(tok['refresh_token'])}).")

    if not args.push:
        sys.exit("No --push target: the token was NOT saved anywhere (it is not printed). Run again with --push.")
    here = os.path.dirname(os.path.abspath(__file__))
    ssh = ["ssh"] + (["-i", args.key, "-o", "IdentitiesOnly=yes"] if args.key else []) + [args.push]
    scp = ["scp"] + (["-i", args.key, "-o", "IdentitiesOnly=yes"] if args.key else [])
    subprocess.run(scp + [os.path.join(here, "server_env_update.py"), f"{args.push}:/tmp/server_env_update.py"], check=True, capture_output=True)
    payload = json.dumps({"GCHAT_OAUTH_CLIENT_ID": client_id, "GCHAT_OAUTH_CLIENT_SECRET": client_secret, "GCHAT_REFRESH_TOKEN": tok["refresh_token"]})
    r = subprocess.run(ssh + [f"python3 /tmp/server_env_update.py {args.env_file}; rm -f /tmp/server_env_update.py"], input=payload, text=True, capture_output=True)
    print(r.stdout.strip())
    if r.returncode != 0:
        sys.exit("Saving on the server failed: " + r.stderr.strip()[:300])
    print("Saved on the server. Now restart the bridge:  cd /opt/bridge && docker compose up -d --no-deps bridge")


if __name__ == "__main__":
    main()
