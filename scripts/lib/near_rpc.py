#!/usr/bin/env python3
"""Read-only NEAR JSON-RPC client for the testnet scripts.

    near_rpc.py endpoint <network>            print the RPC URL near CLI uses for <network>
    near_rpc.py call <network> <method> <params json>
                                              print the response, one JSON object on one line
    near_rpc.py call <network> <method> -     the same, reading the params JSON from stdin, for
                                              params of any size (one argv string is capped at
                                              128 KiB on Linux)

The endpoint, and its API key if any, come from near CLI's own config (near-cli-rs 0.30.1:
`dirs::config_dir()/near-cli/config.toml`, connection `network_connection.<network>`, key sent as
`x-api-key`), so the scripts read from exactly the node near CLI sends transactions to.

A response is printed only if it is one complete JSON-RPC 2.0 object answering this request:
either a result, or an error that is a definitive answer (UNKNOWN_ACCOUNT, NO_CONTRACT_CODE, ...).
Rate limiting (HTTP 429, or a rate-limit message in the body), other HTTP errors, network errors,
bodies that are not exactly one JSON object, and errors the node reports as transient are retried,
up to ATTEMPTS times. Each wait honors a positive Retry-After (seconds or an HTTP date), capped at
MAX_DELAY_S; otherwise, including Retry-After: 0, it backs off exponentially with jitter (about 1,
2, 4, 8, 16 s). No wait is ever shorter than MIN_DELAY_S: on 2026-11-12 FastNEAR answered HTTP 429
with Retry-After: 0, and five retries at 0.0 s all failed. After that, or for an error this client does not
know, it prints why and the raw response to stderr and exits with status 3. It never turns an
unusable response into an answer.

Error names are those of near-jsonrpc-primitives 0.37.3 (the version near-cli-rs 0.30.1 uses):
`error.name` is HANDLER_ERROR, REQUEST_VALIDATION_ERROR or INTERNAL_ERROR, and `error.cause.name`
the specific error.
"""
import email.utils
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

ATTEMPTS = 6
FIRST_DELAY_S = 1.0
MIN_DELAY_S = 1.0
MAX_DELAY_S = 30.0
TIMEOUT_S = 90
RAW_SHOWN = 4000

# Answers: the node looked and this is what it found.
DEFINITIVE = {
    "UNKNOWN_ACCOUNT",
    "INVALID_ACCOUNT",
    "NO_CONTRACT_CODE",
    "NO_GLOBAL_CONTRACT_CODE",
    "UNKNOWN_ACCESS_KEY",
    "UNKNOWN_GAS_KEY",
    "CONTRACT_EXECUTION_ERROR",
    "TOO_LARGE_CONTRACT_STATE",
    "GARBAGE_COLLECTED_BLOCK",
    "INVALID_TRANSACTION",
}
# The node could not answer this time.
TRANSIENT = {
    "INTERNAL_ERROR",
    "NO_SYNCED_BLOCKS",
    "NOT_SYNCED_YET",
    "UNAVAILABLE_SHARD",
    "DOES_NOT_TRACK_SHARD",
    "UNKNOWN_BLOCK",
    "TIMEOUT_ERROR",
    "REQUEST_ROUTED",
}
# A transaction the node has not seen may simply not have reached it yet: retried, and only
# accepted as the answer ("not found") once every attempt says so.
SETTLES = {"UNKNOWN_TRANSACTION"}
RATE_LIMIT_MARKERS = ("rate limit", "rate-limit", "ratelimit", "too many requests")


class Retry(Exception):
    """This attempt failed in a way worth retrying."""

    def __init__(self, reason, raw, delay=None):
        super().__init__(reason)
        self.reason, self.raw, self.delay = reason, raw, delay


class Fatal(Exception):
    """This request cannot succeed; retrying would not help."""

    def __init__(self, reason, raw):
        super().__init__(reason)
        self.reason, self.raw = reason, raw


def config_path():
    # What `dirs::config_dir()` returns, which near-cli-rs uses.
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    elif os.name == "nt":
        base = os.environ["APPDATA"]
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "near-cli", "config.toml")


def connection(network):
    try:
        import tomllib
    except ImportError:
        sys.exit("near_rpc.py needs Python 3.11 or later (tomllib)")
    path = config_path()
    try:
        with open(path, "rb") as file:
            config = tomllib.load(file)
    except OSError as error:
        sys.exit(f"cannot read near CLI config {path}: {error}")
    connection = config.get("network_connection", {}).get(network)
    if not connection or not connection.get("rpc_url"):
        sys.exit(f"near CLI config {path} has no network_connection.{network}.rpc_url")
    return connection["rpc_url"], connection.get("rpc_api_key")


def is_rate_limit(text):
    text = text.lower()
    return any(marker in text for marker in RATE_LIMIT_MARKERS)


def retry_after(headers, now=None):
    """Seconds a positive Retry-After header asks to wait (delta-seconds or HTTP date), capped at
    MAX_DELAY_S; None if the header is absent, unparsable, zero or in the past."""
    value = headers.get("Retry-After") if headers else None
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            when = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if when is None:
            return None
        seconds = when.timestamp() - (time.time() if now is None else now)
    if seconds != seconds or seconds <= 0:  # NaN, zero or past: no usable hint
        return None
    return min(seconds, MAX_DELAY_S)


def backoff(number, delay=None):
    """The wait before attempt number + 1: `delay` (a server's Retry-After) if given, else
    FIRST_DELAY_S * 2^(number - 1) with +/-20% jitter, capped at MAX_DELAY_S; never below
    MIN_DELAY_S."""
    if delay is None:
        delay = min(FIRST_DELAY_S * 2 ** (number - 1), MAX_DELAY_S) * random.uniform(0.8, 1.2)
    return max(delay, MIN_DELAY_S)


def attempt(url, api_key, method, params, request_id):
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    request = urllib.request.Request(
        url,
        data=body.encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    if api_key:
        request.add_header("x-api-key", str(api_key))
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            status, raw = response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        if error.code == 429 or is_rate_limit(raw):
            raise Retry(f"rate limited (HTTP {error.code})", raw, retry_after(error.headers))
        if error.code in (408, 425) or error.code >= 500:
            raise Retry(f"HTTP {error.code}", raw, retry_after(error.headers))
        raise Fatal(f"HTTP {error.code}", raw)
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
        raise Retry(f"network error: {error}", "")
    if status != 200:
        raise Retry(f"HTTP {status}", raw)

    try:
        # json.loads rejects anything after the first value ("Extra data"), so two responses
        # run together, as curl --retry writes them to one stream, never parse.
        response = json.loads(raw)
    except ValueError as error:
        reason = "rate limited" if is_rate_limit(raw) else f"response is not one JSON value ({error})"
        raise Retry(reason, raw)
    if not isinstance(response, dict) or response.get("jsonrpc") != "2.0":
        reason = "rate limited" if is_rate_limit(raw) else "response is not a JSON-RPC 2.0 object"
        raise Retry(reason, raw)
    if response.get("id") != request_id:
        raise Retry(f"response id {response.get('id')!r} does not match request id", raw)
    if ("result" in response) == ("error" in response):
        raise Retry("response has neither or both of result and error", raw)
    if "result" in response:
        return response, None

    error = response["error"]
    if not isinstance(error, dict):
        raise Retry("error is not an object", raw)
    kind = error.get("name")
    cause = error.get("cause") if isinstance(error.get("cause"), dict) else {}
    name = cause.get("name")
    if is_rate_limit(json.dumps(error)):
        raise Retry("rate limited", raw)
    if kind == "REQUEST_VALIDATION_ERROR":
        raise Fatal(f"request rejected: {name}", raw)
    if kind == "INTERNAL_ERROR" or name in TRANSIENT:
        raise Retry(f"node error {kind}/{name}", raw)
    if kind == "HANDLER_ERROR" and name in DEFINITIVE:
        return response, None
    if kind == "HANDLER_ERROR" and name in SETTLES:
        return response, name
    raise Fatal(f"unrecognised error {kind}/{name}", raw)


def call(network, method, params):
    url, api_key = connection(network)
    request_id = f"intatto-{os.getpid()}-{random.randrange(1 << 30)}"
    settled = None
    for number in range(1, ATTEMPTS + 1):
        try:
            response, settling = attempt(url, api_key, method, params, request_id)
            if settling is None:
                return response
            settled, failure = response, Retry(f"{settling}, may not have reached the node yet", "")
        except Fatal as error:
            fail(method, url, number, error.reason, error.raw)
        except Retry as error:
            failure = error
            settled = None
        if number == ATTEMPTS:
            break
        delay = backoff(number, failure.delay)
        print(
            f"near_rpc: {method} attempt {number}/{ATTEMPTS} failed ({failure.reason}); "
            f"retrying in {delay:.1f}s",
            file=sys.stderr,
        )
        time.sleep(delay)
    if settled is not None:
        return settled
    fail(method, url, ATTEMPTS, failure.reason, failure.raw)


def fail(method, url, attempts, reason, raw):
    shown = raw if len(raw) <= RAW_SHOWN else raw[:RAW_SHOWN] + f"... ({len(raw)} bytes)"
    print(
        f"near_rpc: {method} to {url} failed after {attempts} attempt(s): {reason}\n"
        f"near_rpc: raw response: {shown if raw else '(none)'}",
        file=sys.stderr,
    )
    sys.exit(3)


def main(argv):
    if len(argv) == 2 and argv[0] == "endpoint":
        print(connection(argv[1])[0])
    elif len(argv) == 4 and argv[0] == "call":
        try:
            params = json.loads(sys.stdin.read() if argv[3] == "-" else argv[3])
        except ValueError as error:
            sys.exit(f"near_rpc.py: params are not JSON: {error}")
        print(json.dumps(call(argv[1], argv[2], params), separators=(",", ":")))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
