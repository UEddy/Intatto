#!/usr/bin/env python3
"""Pure helpers for the mainnet scripts (scripts/mainnet-*.sh). No network access: every input is a
file or a short argument (an amount, an account id, a path; never data of unbounded size). Exit status 0 means yes / PASS, anything else no / FAIL.

    yocto <NEAR>                       NEAR (decimal) -> yoctoNEAR
    near <yocto>                       yoctoNEAR -> NEAR, exact
    units <amount> <decimals>          token units -> decimal amount
    add <yocto>...                     sum
    mul <a> <b>                        product (bash arithmetic overflows at 2^63)
    sub <a> <b>                        a - b; fails if negative
    ge <a> <b>                         a >= b
    max <a> <b>                        the larger
    fees <protocol config> <kind> <bytes>...
                                       "<send gas> <exec gas>": the protocol's static fees for one
                                       transaction of <kind> (prepaid gas comes on top):
                                         call <method + args bytes>   one FunctionCall
                                         deploy <code bytes> <method + args bytes>
                                                                      DeployContract + FunctionCall
                                         create                       CreateAccount + Transfer +
                                                                      AddKey (full access)
                                         add-fc-key <receiver + method names bytes>
                                         transfer                     one Transfer
                                       Send fees are the larger of the sir/not-sir values.
    fc-allowance <access key list> <public key>
                                       that key's allowance in yoctoNEAR, or "unlimited"
    file-hash <path>                   base58 sha256, as NEAR reports code hashes
    file-size <path>                   bytes
    signed-tx <near display output> <out file>
                                       writes the base64 signed transaction near CLI printed to
                                       <out file> (new, mode 600) as the JSON that `near transaction
                                       send-signed-transaction file-with-base64-signed-transaction`
                                       reads, and prints its hash (sha256 of the unsigned part).
                                       The transaction itself never passes through argv or stdout:
                                       a deploy's is ~360 KB of base64, and Linux refuses any single
                                       argument over 128 KiB (E2BIG, "Argument list too long").
    result <rpc response>              the `result` object, as JSON
    call-result <rpc response>         what a view call returned, as JSON (null if no account/code)
    json <file> <python expr over v>   evaluates the expression over the JSON in <file>
    account <rpc response>             "missing", or "<amount> <code hash or none>"
    logged <exact|prefix> <description> <log file>...
                                       "<seq> <hash>" for each line "<hash> <description>" of the
                                       transaction logs (in the order given) whose description is
                                       <description> (exact) or starts with it (prefix); <seq>
                                       orders lines across all the files
    outcome <tx response> <hash> <explorer> <vault> <expect>
                                       checks a transaction: expect is "success" or
                                       "reject:<reason>" (a spend_rejected / swap_rejected event
                                       from the vault with that reason, and no swap_initiated)
    events <tx response> <vault>       the vault's intatto events, one JSON per line
    fc-key <access key list> <key dir> <receiver> <methods,...>
                                       public key of a function-call key with exactly that
                                       permission whose key file is in <key dir>, or nothing
    utc-ns <ISO 8601 UTC>              nanoseconds since the epoch
    ns-utc <ns>                        ISO 8601 UTC
"""
import base64
import datetime
import hashlib
import json
import os
import re
import sys
from decimal import Decimal

YOCTO = 10**24
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
NO_CODE = "11111111111111111111111111111111"


def b58encode(data):
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def load(path):
    with open(path) as f:
        return json.load(f)


def unknown_account(response):
    cause = (response.get("error") or {}).get("cause") or {}
    return cause.get("name") in ("UNKNOWN_ACCOUNT", "NO_CONTRACT_CODE")


def to_yocto(text):
    value = Decimal(text) * YOCTO
    if value != value.to_integral_value() or value < 0:
        sys.exit(f"not a NEAR amount with at most 24 decimals: {text}")
    return int(value)


def fmt(amount, decimals):
    whole, frac = divmod(int(amount), 10**decimals)
    frac_text = str(frac).rjust(decimals, "0").rstrip("0") if decimals else ""
    return f"{whole}.{frac_text}" if frac_text else str(whole)


def vault_events(response, vault):
    result = response["result"]
    for outcome in [result["transaction_outcome"]] + result["receipts_outcome"]:
        if outcome["outcome"]["executor_id"] != vault:
            continue
        for log in outcome["outcome"]["logs"]:
            if log.startswith("EVENT_JSON:"):
                event = json.loads(log[len("EVENT_JSON:"):])
                if event.get("standard") == "intatto":
                    yield event


def failure(response):
    result = response["result"]
    for outcome in [result["transaction_outcome"]] + result["receipts_outcome"]:
        fail = outcome["outcome"]["status"].get("Failure")
        if fail:
            text = json.dumps(fail)
            match = re.search(r'"ExecutionError": "([^"]*)"', text)
            return match.group(1) if match else text
    return None


def main(cmd, args):
    if cmd == "yocto":
        print(to_yocto(args[0]))
    elif cmd == "near":
        print(fmt(args[0], 24))
    elif cmd == "units":
        print(fmt(args[0], int(args[1])))
    elif cmd == "add":
        print(sum(int(a) for a in args))
    elif cmd == "mul":
        print(int(args[0]) * int(args[1]))
    elif cmd == "sub":
        a, b = int(args[0]), int(args[1])
        if a < b:
            sys.exit(f"sub: {a} < {b}, the result would be negative")
        print(a - b)
    elif cmd == "ge":
        sys.exit(0 if int(args[0]) >= int(args[1]) else 1)
    elif cmd == "max":
        print(max(int(args[0]), int(args[1])))
    elif cmd == "fees":
        costs = load(args[0])["result"]["runtime_config"]["transaction_costs"]
        action = costs["action_creation_config"]
        def fee(f, n=1):
            return n * max(int(f["send_sir"]), int(f["send_not_sir"])), n * int(f["execution"])
        parts = [fee(costs["action_receipt_creation_config"])]
        kind = args[1]
        if kind in ("call", "deploy"):
            call_bytes = int(args[-1])
            parts += [fee(action["function_call_cost"]), fee(action["function_call_cost_per_byte"], call_bytes)]
        if kind == "deploy":
            parts += [fee(action["deploy_contract_cost"]), fee(action["deploy_contract_cost_per_byte"], int(args[2]))]
        elif kind == "create":
            parts += [fee(action["create_account_cost"]), fee(action["transfer_cost"]),
                      fee(action["add_key_cost"]["full_access_cost"])]
        elif kind == "add-fc-key":
            parts += [fee(action["add_key_cost"]["function_call_cost"]),
                      fee(action["add_key_cost"]["function_call_cost_per_byte"], int(args[2]))]
        elif kind == "transfer":
            parts += [fee(action["transfer_cost"])]
        elif kind != "call":
            sys.exit(f"fees: unknown kind {kind}")
        print(sum(p[0] for p in parts), sum(p[1] for p in parts))
    elif cmd == "fc-allowance":
        for key in load(args[0])["result"]["keys"]:
            if key["public_key"] == args[1]:
                permission = key["access_key"]["permission"]
                allowance = permission["FunctionCall"].get("allowance") if isinstance(permission, dict) else None
                print(allowance if allowance is not None else "unlimited")
                return
        sys.exit(f"no key {args[1]}")
    elif cmd == "file-hash":
        with open(args[0], "rb") as f:
            print(b58encode(hashlib.sha256(f.read()).digest()))
    elif cmd == "file-size":
        print(os.path.getsize(args[0]))
    elif cmd == "signed-tx":
        log, out = args
        with open(log) as f:
            text = re.sub(r"\x1b\[[0-9;]*m", "", f.read())
        match = re.search(r"Signed transaction \(serialized as base64\):\s+(\S+)", text)
        if not match:
            sys.exit("no signed transaction found in near CLI output")
        signed = match.group(1)
        raw = base64.b64decode(signed, validate=True)
        if len(raw) < 65 or raw[-65] != 0:
            sys.exit("expected an ed25519-signed transaction")
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"signed_transaction_as_base64": signed}, f)
        print(b58encode(hashlib.sha256(raw[:-65]).digest()))
    elif cmd == "result":
        print(json.dumps(load(args[0])["result"]))
    elif cmd == "call-result":
        response = load(args[0])
        result = response.get("result") or {}
        # An account with no code: some nodes answer NO_CONTRACT_CODE, others a result whose
        # `error` is "...CompilationError(CodeDoesNotExist ...)". Both mean no contract.
        if unknown_account(response) or "CodeDoesNotExist" in str(result.get("error", "")):
            print("null")
        elif "error" in response or "error" in result:
            sys.exit(f"view failed: {json.dumps(response.get('error') or result.get('error'))}")
        elif "error" in response:
            sys.exit(f"view failed: {json.dumps(response['error'])}")
        else:
            print(bytes(response["result"]["result"]).decode())
    elif cmd == "json":
        v = load(args[0])
        print(json.dumps(eval(args[1], {"v": v, "int": int, "len": len})).strip('"'))
    elif cmd == "account":
        response = load(args[0])
        if unknown_account(response):
            print("missing")
        else:
            r = response["result"]
            print(r["amount"], "none" if r["code_hash"] == NO_CODE else r["code_hash"])
    elif cmd == "events":
        for event in vault_events(load(args[0]), args[1]):
            print(json.dumps(event))
    elif cmd == "logged":
        mode, text, files = args[0], args[1], args[2:]
        if mode not in ("exact", "prefix"):
            sys.exit(f"bad mode {mode}")
        seq = 0
        for name in files:
            with open(name, encoding="utf-8") as f:
                for line in f:
                    seq += 1
                    tx_hash, _, description = line.rstrip("\n").partition(" ")
                    if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{43,44}", tx_hash):
                        sys.exit(f"{name}: not a transaction log line: {line.strip()!r}")
                    if description == text or (mode == "prefix" and description.startswith(text)):
                        print(seq, tx_hash)
    elif cmd == "outcome":
        path, tx_hash, explorer, vault, expect = args
        print(f"    tx:        {explorer}{tx_hash}")
        response = load(path)
        if "error" in response:
            print(f"    result:    FAIL (RPC: {json.dumps(response['error'])})")
            sys.exit(1)
        events = list(vault_events(response, vault))
        fail = failure(response)
        names = [e["event"] for e in events]
        print(f"    events:    {', '.join(names) or 'none'}")
        if expect == "success":
            ok = fail is None
            print(f"    result:    {'PASS' if ok else 'FAIL: ' + str(fail)}")
        else:
            reason = expect.split(":", 1)[1]
            rejected = [e for e in events if e["event"] in ("spend_rejected", "swap_rejected")]
            got = rejected[0]["data"]["reason"] if rejected else None
            ok = fail is not None and got == reason and "swap_initiated" not in names
            print(f"    expected:  rejected with {reason}, nothing initiated")
            print(f"    actual:    {'rejected with ' + got if got else 'no rejection event'}; {fail or 'succeeded'}")
            print(f"    result:    {'PASS' if ok else 'FAIL'}")
        sys.exit(0 if ok else 1)
    elif cmd == "fc-key":
        keys, key_dir, receiver, methods = args[0], args[1], args[2], sorted(args[3].split(","))
        for key in load(keys)["result"]["keys"]:
            permission = key["access_key"]["permission"]
            fc = permission.get("FunctionCall") if isinstance(permission, dict) else None
            if not fc or fc["receiver_id"] != receiver or sorted(fc["method_names"]) != methods:
                continue
            if os.path.exists(os.path.join(key_dir, key["public_key"].replace(":", "_") + ".json")):
                print(key["public_key"])
                return
    elif cmd == "utc-ns":
        when = datetime.datetime.fromisoformat(args[0].replace("Z", "+00:00"))
        if when.tzinfo is None or when.utcoffset() != datetime.timedelta(0):
            sys.exit("give the time in UTC, ending in Z")
        print(int(when.timestamp()) * 10**9)
    elif cmd == "ns-utc":
        print(datetime.datetime.fromtimestamp(int(args[0]) // 10**9, datetime.UTC).isoformat().replace("+00:00", "Z"))
    else:
        sys.exit(f"unknown helper command {cmd}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
