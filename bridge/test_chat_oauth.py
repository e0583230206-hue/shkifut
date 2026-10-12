"""python -I bridge/test_chat_oauth.py   (Google, the browser and SSH are simulated)"""
import base64
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chat_oauth  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def id_token(email):
    body = base64.urlsafe_b64encode(json.dumps({"email": email}).encode()).rstrip(b"=").decode()
    return f"x.{body}.y"


def run_main(account_email, scope="https://www.googleapis.com/auth/chat.messages.create openid email", refresh="REFRESH-SECRET-VALUE", client_kind="installed", push=True):
    client = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump({client_kind: {"client_id": "cid.apps.googleusercontent.com", "client_secret": "CLIENT-SECRET-VALUE"}}, client)
    client.close()
    sent = {}
    seen_url = {}

    def fake_browser(url):  # the "user" signs in: Google redirects the browser to the local helper
        seen_url["url"] = url
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        cb = urllib.parse.urlparse(q["redirect_uri"][0])
        path = "/?" + urllib.parse.urlencode({"code": "AUTHCODE", "state": q["state"][0]})

        def browser():  # plain http.client: urllib.request.urlopen is mocked in this test (it stands for Google)
            import http.client
            conn = http.client.HTTPConnection(cb.hostname, cb.port, timeout=10)
            conn.request("GET", path)
            conn.getresponse().read()
        threading.Thread(target=browser, daemon=True).start()
        return True

    class Resp(io.BytesIO):
        pass

    def fake_urlopen(req, timeout=None):
        sent["token_request"] = urllib.parse.parse_qs(req.data.decode())
        return Resp(json.dumps({"id_token": id_token(account_email), "scope": scope, "refresh_token": refresh, "access_token": "a"}).encode())

    def fake_run(cmd, **kw):
        if cmd[0] == "ssh":
            sent["ssh"] = cmd
            sent["ssh_input"] = kw.get("input")
            return subprocess.CompletedProcess(cmd, 0, stdout="updated GCHAT_REFRESH_TOKEN (length 21)\n", stderr="")
        sent["scp"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")

    argv = ["chat_oauth.py", "--client", client.name] + (["--push", "root@host", "--key", "k"] if push else [])
    out = io.StringIO()
    code = 0
    with mock.patch.object(sys, "argv", argv), mock.patch("webbrowser.open", fake_browser), \
            mock.patch("urllib.request.urlopen", fake_urlopen), mock.patch("subprocess.run", fake_run), contextlib.redirect_stdout(out):
        try:
            chat_oauth.main()
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 1
            if isinstance(e.code, str):
                out.write(e.code)
    os.unlink(client.name)
    return code, out.getvalue(), sent, seen_url


class Tests(unittest.TestCase):
    def test_pkce_challenge_matches_verifier(self):
        import hashlib
        v, c = chat_oauth.pkce()
        self.assertEqual(c, base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode())

    def test_happy_path_asks_for_the_right_things_and_pushes_over_ssh(self):
        code, out, sent, seen = run_main("dr@30206.co.il")
        self.assertEqual(code, 0, out)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(seen["url"]).query)
        self.assertEqual(q["login_hint"], ["dr@30206.co.il"])
        self.assertEqual(q["access_type"], ["offline"])
        self.assertEqual(q["prompt"], ["consent"])
        self.assertEqual(q["code_challenge_method"], ["S256"])
        self.assertIn("chat.messages.create", q["scope"][0])
        self.assertTrue(q["redirect_uri"][0].startswith("http://127.0.0.1:"))
        tr = sent["token_request"]
        self.assertEqual(tr["grant_type"], ["authorization_code"])
        self.assertEqual(tr["code"], ["AUTHCODE"])
        self.assertTrue(tr["code_verifier"][0])
        payload = json.loads(sent["ssh_input"])
        self.assertEqual(sorted(payload), ["GCHAT_OAUTH_CLIENT_ID", "GCHAT_OAUTH_CLIENT_SECRET", "GCHAT_REFRESH_TOKEN"])
        self.assertEqual(payload["GCHAT_REFRESH_TOKEN"], "REFRESH-SECRET-VALUE")
        self.assertEqual(sent["ssh"][:3], ["ssh", "-i", "k"])

    def test_nothing_secret_is_printed(self):
        code, out, sent, seen = run_main("dr@30206.co.il")
        for secret in ("REFRESH-SECRET-VALUE", "CLIENT-SECRET-VALUE"):
            self.assertNotIn(secret, out)

    def test_wrong_account_is_refused_and_nothing_is_saved(self):
        code, out, sent, seen = run_main("someone.else@gmail.com")
        self.assertNotEqual(code, 0)
        self.assertIn("not dr@30206.co.il", out)
        self.assertNotIn("ssh", sent)

    def test_missing_permission_or_token_is_refused(self):
        code, out, sent, _ = run_main("dr@30206.co.il", scope="openid email")
        self.assertNotEqual(code, 0)
        self.assertNotIn("ssh", sent)
        code, out, sent, _ = run_main("dr@30206.co.il", refresh="")
        self.assertNotEqual(code, 0)
        self.assertNotIn("ssh", sent)

    def test_web_client_is_rejected_with_an_explanation(self):
        code, out, sent, _ = run_main("dr@30206.co.il", client_kind="web")
        self.assertNotEqual(code, 0)
        self.assertIn("Desktop app", out)

    def test_without_push_the_token_is_not_stored_anywhere(self):
        code, out, sent, _ = run_main("dr@30206.co.il", push=False)
        self.assertNotEqual(code, 0)
        self.assertIn("NOT saved", out)
        self.assertNotIn("REFRESH-SECRET-VALUE", out)

    def test_state_mismatch_is_ignored(self):
        port = []
        result, done, srv = chat_oauth.wait_for_code("good-state", port)
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port[0]}/?code=evil&state=bad", timeout=5)
        except Exception:
            pass
        self.assertFalse(done.is_set())
        urllib.request.urlopen(f"http://127.0.0.1:{port[0]}/?code=ok&state=good-state", timeout=5).read()
        self.assertTrue(done.wait(3))
        self.assertEqual(result["code"], "ok")
        srv.shutdown()


class ServerUpdater(unittest.TestCase):
    def test_merge_keeps_lines_permissions_and_backs_up(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, ".env")
        open(p, "w").write("A=1\nGCHAT_REFRESH_TOKEN=\nB=2\n")
        os.chmod(p, 0o600)
        r = subprocess.run([sys.executable, os.path.join(HERE, "server_env_update.py"), p], input=json.dumps({"GCHAT_REFRESH_TOKEN": "tok", "NEW_ONE": "x"}), text=True, capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(open(p).read(), "A=1\nGCHAT_REFRESH_TOKEN=tok\nB=2\nNEW_ONE=x\n")
        self.assertNotIn("tok", r.stdout.replace("GCHAT_REFRESH_TOKEN", ""))
        if os.name != "nt":
            self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)
        self.assertTrue(any(f.startswith(".env.bak.") for f in os.listdir(d)))

    def test_refuses_values_with_newlines(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, ".env")
        open(p, "w").write("A=1\n")
        r = subprocess.run([sys.executable, os.path.join(HERE, "server_env_update.py"), p], input=json.dumps({"X": "a\nb"}), text=True, capture_output=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(open(p).read(), "A=1\n")


if __name__ == "__main__":
    unittest.main(verbosity=1)
