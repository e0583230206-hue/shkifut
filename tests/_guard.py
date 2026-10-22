"""Shared by the e2e tests: the base URL of the LOCAL test stack, and a hard stop for anything else.

The default is http://localhost:18080 (docker-compose.local.yml). BASE_URL (or the URL argument of the tests that take one)
changes it, but only to a local address. Refused: any other host, anything that looks like the real demo (30206.co.il), and
ports 8080 / 8081, which are where the SSH tunnel to the demo server used to listen (deploy/tunnel.ps1).
The tests log in with /auth/dev-login, change settings and upload files: they must never reach the real site.

    python -I tests/_guard.py [url]     # prints the URL to use, or stops with exit code 2 (used by tests/ui/run_ui.sh)
"""
import os
import sys
import urllib.parse

DEFAULT = "http://localhost:18080"
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")
TUNNEL_PORTS = (8080, 8081)


def base_url(url=None):
    url = (url or os.environ.get("BASE_URL") or DEFAULT).strip().rstrip("/")
    u = urllib.parse.urlparse(url)
    problem = None
    if u.scheme not in ("http", "https") or not u.hostname:
        problem = "not an http(s) address"
    elif u.hostname.lower() not in LOCAL_HOSTS:
        problem = "not a local address"
    elif "30206.co.il" in url.lower():
        problem = "looks like the real demo site"
    elif u.port in TUNNEL_PORTS:
        problem = f"port {u.port} may be the SSH tunnel to the real demo site"
    if problem:
        sys.stderr.write(f"STOP: {url} is refused ({problem}). Tests run only against the local stack, {DEFAULT}.\n")
        sys.exit(2)
    return url


if __name__ == "__main__":
    print(base_url(sys.argv[1] if len(sys.argv) > 1 else None))
