"""Drive a sessionfarm profile from Python using only the standard library.

No playwright, no vendor SDK, no Node. sessionfarm speaks plain HTTP for
leases and Chrome DevTools Protocol for the browser, so any language with an
HTTP client can use it.

    SESSIONFARM_TOKEN=secret node dist/cli.js serve
    python examples/agent.py
"""

import json
import os
import time
import urllib.request as request

BASE = os.environ.get("SESSIONFARM_URL", "http://127.0.0.1:8787")
TOKEN = os.environ.get("SESSIONFARM_TOKEN", "secret")
PROFILE = os.environ.get("SESSIONFARM_PROFILE", "client-b")


def call(method, path, body=None, base=BASE):
    data = json.dumps(body).encode() if body is not None else None
    req = request.Request(
        base + path,
        data=data,
        method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    return json.loads(request.urlopen(req, timeout=30).read() or b"{}")


def main():
    lease = call("POST", f"/profiles/{PROFILE}/acquire", {"holder": "python-agent"})
    print("lease:", lease["leaseId"])
    try:
        # The cdpUrl is a websocket, but Chrome serves plain HTTP on the same
        # port, which is enough to open and inspect pages without any library.
        cdp = lease["cdpUrl"].split("/devtools/")[0].replace("ws://", "http://")
        print("browser:", call("GET", "/json/version", base=cdp)["Browser"])

        # Chrome takes the target URL as the raw query string here, not as ?url=
        call("PUT", "/json/new?https://example.com", base=cdp)
        time.sleep(2)

        pages = [t["url"] for t in call("GET", "/json/list", base=cdp) if t["type"] == "page"]
        print("pages:", pages)
    finally:
        # Always release. The lease has a TTL, but holding it until then blocks
        # every other agent that wants this profile.
        call("POST", f"/profiles/{PROFILE}/release", {"leaseId": lease["leaseId"]})
        print("released")


if __name__ == "__main__":
    main()
