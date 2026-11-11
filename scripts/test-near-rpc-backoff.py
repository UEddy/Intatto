#!/usr/bin/env python3
"""Regression test for scripts/lib/near_rpc.py's retry waits (2026-11-12): FastNEAR answered HTTP
429 with Retry-After: 0, and near_rpc retried five times at 0.0 s, so the run aborted.

    python3 -I scripts/test-near-rpc-backoff.py

A local HTTP server plays the RPC node; nothing touches the network. Sleeps are recorded, not slept.
Checks: Retry-After: 0, a missing header and junk fall back to exponential backoff with jitter
(1, 2, 4, 8, 16 s +/- 20%); a positive Retry-After (seconds or HTTP date) is honored, capped at 30 s;
no wait is ever below 1 s; and a request that keeps failing gives up after ATTEMPTS tries.
"""
import email.utils
import http.server
import importlib.util
import json
import os
import sys
import threading
import time

sys.dont_write_bytecode = True  # no __pycache__ next to scripts/lib/near_rpc.py
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("near_rpc", os.path.join(HERE, "lib", "near_rpc.py"))
near_rpc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(near_rpc)

PASSED = FAILED = 0


def check(what, ok):
    global PASSED, FAILED
    print(f"{'PASS' if ok else 'FAIL'}: {what}")
    if ok:
        PASSED += 1
    else:
        FAILED += 1


class Node(http.server.BaseHTTPRequestHandler):
    # Each test sets the answers: a list of (status, Retry-After or None); then success.
    answers = []

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if Node.answers:
            status, after = Node.answers.pop(0)
            self.send_response(status)
            if after is not None:
                self.send_header("Retry-After", after)
            self.end_headers()
            self.wfile.write(b"Too Many Requests")
            return
        body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"ok": True}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Node)
threading.Thread(target=server.serve_forever, daemon=True).start()
near_rpc.connection = lambda network: (f"http://127.0.0.1:{server.server_port}/", None)
sleeps = []
near_rpc.time.sleep = sleeps.append


def run(answers):
    Node.answers = list(answers)
    sleeps.clear()
    try:
        return near_rpc.call("mainnet", "status", []), list(sleeps)
    except SystemExit:
        return None, list(sleeps)


# Retry-After: 0, five times: exponential backoff, never 0.
response, waits = run([(429, "0")] * 5)
check("429 with Retry-After: 0 is retried until it succeeds", response is not None and response["result"] == {"ok": True})
check(f"waits back off exponentially with jitter: {[round(w, 2) for w in waits]}",
      len(waits) == 5 and all(0.8 * 2**i <= w <= 1.2 * 2**i for i, w in enumerate(waits)))
check("no wait is shorter than 1 s", all(w >= 1.0 for w in waits))

# No header and a junk header: the same backoff.
_, waits = run([(429, None), (429, "soon"), (503, None)])
check(f"missing or unparsable Retry-After backs off: {[round(w, 2) for w in waits]}",
      len(waits) == 3 and all(0.8 * 2**i <= w <= 1.2 * 2**i for i, w in enumerate(waits)))

# A positive Retry-After is honored, capped at MAX_DELAY_S, and never below 1 s.
_, waits = run([(429, "3"), (429, "120"), (429, "0.2")])
check(f"positive Retry-After is honored, capped at 30 s, floored at 1 s: {waits}", waits == [3.0, 30.0, 1.0])

# An HTTP-date Retry-After.
when = email.utils.formatdate(time.time() + 10, usegmt=True)
_, waits = run([(429, when)])
check(f"HTTP-date Retry-After is honored: {[round(w, 1) for w in waits]}", len(waits) == 1 and 8.0 <= waits[0] <= 10.0)

# A node that never recovers: gives up after ATTEMPTS tries, with ATTEMPTS - 1 waits.
response, waits = run([(429, "0")] * (near_rpc.ATTEMPTS + 2))
check(f"gives up after {near_rpc.ATTEMPTS} attempts ({len(waits)} waits, {round(sum(waits))} s in all)",
      response is None and len(waits) == near_rpc.ATTEMPTS - 1)

server.shutdown()
print(f"{PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
