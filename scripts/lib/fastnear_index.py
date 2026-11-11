"""Lookups the chain itself cannot answer, from FastNEAR's keyless indexer APIs.

    python3 -I scripts/lib/fastnear_index.py owners <mainnet|testnet> <vault account>
    python3 -I scripts/lib/fastnear_index.py tokens <mainnet|testnet> <account>

`owners`: every account that ever owned a vault on the vault contract, one per line: the
`owner_id` of every `deposit` and `token_deposit` event (standard "intatto") in the contract's
whole transaction history. A vault exists only after one of those, so this is the complete set of
owners, as far as the indexer knows them. The contract has no view that lists owners;
scripts/mainnet-teardown.sh uses this to make sure no one else still holds funds in the vault
before it is deleted.

`tokens`: every fungible-token contract the indexer has seen the account hold a balance on, one
per line. The indexer's balances can lag, so callers check each contract's `ft_balance_of` on
chain; this only says which contracts to check.

Any error, unreadable response, or count that does not add up exits non-zero with a message: a
partial list must never pass for a complete one.
"""

import json
import sys
import time
import urllib.error
import urllib.request

BASE = {"mainnet": "https://tx.main.fastnear.com", "testnet": "https://tx.test.fastnear.com"}
ACCOUNT_API = {"mainnet": "https://api.fastnear.com", "testnet": "https://test.api.fastnear.com"}
PAGE = 200  # /v0/account maximum
CHUNK = 20  # /v0/transactions maximum
ATTEMPTS = 5


def fail(message):
    sys.exit(f"fastnear_index: {message}")


def post(url, body):
    return fetch(url, json.dumps(body).encode())


def fetch(url, data=None):
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    for attempt in range(1, ATTEMPTS + 1):
        request = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            status = getattr(e, "code", None)
            if attempt == ATTEMPTS or (status is not None and status not in (429, 500, 502, 503, 504)):
                fail(f"{url} failed after {attempt} attempt(s): {e}")
            time.sleep(min(2**attempt, 20))
    fail(f"{url}: no answer")


def all_hashes(base, vault):
    hashes, token, expected = [], None, None
    while True:
        body = {"account_id": vault, "limit": PAGE}
        if token:
            body["resume_token"] = token
        page = post(f"{base}/v0/account", body)
        rows = page.get("account_txs")
        if not isinstance(rows, list):
            fail(f"unexpected /v0/account response: {json.dumps(page)[:300]}")
        if expected is None:
            expected = page.get("txs_count")
        hashes += [row["transaction_hash"] for row in rows]
        token = page.get("resume_token")
        if not token or not rows:
            break
    unique = list(dict.fromkeys(hashes))
    if not isinstance(expected, int) or len(unique) != expected:
        fail(f"listed {len(unique)} transactions for {vault}, the indexer counts {expected}")
    return unique


def owners_in(base, vault, hashes):
    owners, seen = set(), 0
    for i in range(0, len(hashes), CHUNK):
        chunk = hashes[i : i + CHUNK]
        page = post(f"{base}/v0/transactions", {"tx_hashes": chunk})
        txs = page.get("transactions")
        if not isinstance(txs, list) or len(txs) != len(chunk):
            fail(f"asked for {len(chunk)} transactions, got {len(txs) if isinstance(txs, list) else 'none'}")
        for tx in txs:
            seen += 1
            for receipt in tx.get("receipts", []):
                outcome = receipt["execution_outcome"]["outcome"]
                if outcome["executor_id"] != vault:
                    continue
                for log in outcome["logs"]:
                    if not log.startswith("EVENT_JSON:"):
                        continue
                    event = json.loads(log[len("EVENT_JSON:") :])
                    if event.get("standard") == "intatto" and event.get("event") in ("deposit", "token_deposit"):
                        for item in event["data"] if isinstance(event["data"], list) else [event["data"]]:
                            owners.add(item["owner_id"])
    if seen != len(hashes):
        fail(f"read {seen} of {len(hashes)} transactions")
    return owners


def tokens_of(network, account):
    page = fetch(f"{ACCOUNT_API[network]}/v1/account/{account}/ft")
    tokens = page.get("tokens") if isinstance(page, dict) else None
    if not isinstance(tokens, list) or page.get("account_id") != account:
        fail(f"unexpected /v1/account/{account}/ft response: {json.dumps(page)[:300]}")
    return sorted({t["contract_id"] for t in tokens})


def main(command, network, account):
    if network not in BASE:
        fail(f"unknown network {network}")
    if command == "owners":
        hashes = all_hashes(BASE[network], account)
        for owner in sorted(owners_in(BASE[network], account, hashes)):
            print(owner)
        print(f"fastnear_index: {len(hashes)} transactions of {account} read", file=sys.stderr)
    elif command == "tokens":
        for contract in tokens_of(network, account):
            print(contract)
    else:
        fail(f"unknown command {command}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        fail("usage: fastnear_index.py <owners|tokens> <mainnet|testnet> <account>")
    main(*sys.argv[1:])
