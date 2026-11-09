#!/usr/bin/env node
// Generates src/contract/abi.gen.ts (zod schemas and method metadata) from the contract's ABI.
//
//   node scripts/gen-abi.mjs          copy ../target/near/intatto_abi.json (if present) into
//                                     src/contract/intatto_abi.json, then regenerate
//   node scripts/gen-abi.mjs --check  exit 1 if abi.gen.ts is not what the ABI copy generates
//
// The ABI is produced by `cargo near build` from the Rust source, so the UI's types cannot drift
// from the contract: src/contract/abi.test.ts runs the same check in the unit tests.
//
// Only the JSON Schema subset the ABI uses is supported; anything else throws instead of being
// guessed. Plain strings inside the ABI's definitions are all NearToken / U128 / U64 values (the
// contract's account ids carry the "NEAR Account Identifier" description), so they become
// decimal-string schemas.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const built = join(web, "..", "target", "near", "intatto_abi.json");
const copy = join(web, "src", "contract", "intatto_abi.json");
const out = join(web, "src", "contract", "abi.gen.ts");

export function generate(abi) {
  const defs = abi.body.root_schema.definitions;
  const lines = [];
  const emit = (s) => lines.push(s);

  const isAccount = (schema) =>
    typeof schema.description === "string" && schema.description.startsWith("NEAR Account Identifier");
  // A field's doc comment replaces the AccountId description in the ABI, so documented account
  // fields are listed by hand. Every other plain string must be a known number; a new string
  // field fails generation until it is added to one of these lists.
  const ACCOUNT_FIELDS = new Set(["VaultView.agent_id", "Spend.token_id"]);
  const NUMBER_FIELDS = new Set([
    "ExchangeLedger.expected",
    "ExchangeLedger.generation",
    "Policy.daily_cap",
    "Policy.per_tx_cap",
    "TokenPolicy.daily_cap",
    "TokenPolicy.per_tx_cap",
    "Spend.amount",
    "Spend.spend_id",
    "Spend.timestamp",
    "SwapTicket.amount_in",
    "SwapTicket.min_amount_out",
    "SwapTicket.spend_id",
    "TokenBalance.balance",
    "TokenBalance.on_exchange",
    "VaultView.balance",
    "VaultView.withdrawals_locked_until",
    "PromiseOrValueString",
    "withdraw(amount)",
    "withdraw_token(amount)",
    "lock_withdrawals_until(timestamp_ns)",
    "agent_spend(amount)",
    "agent_swap(amount_in)",
    "agent_swap(min_amount_out)",
  ]);

  const INT = { uint16: 65535, uint32: 4294967295, uint64: Number.MAX_SAFE_INTEGER };

  function zod(schema, ctx) {
    if (schema === true) return "z.unknown()";
    if (schema.$ref) {
      const name = schema.$ref.replace("#/definitions/", "");
      if (!(name in defs)) throw new Error(`unknown $ref ${schema.$ref} in ${ctx}`);
      return `${name}Schema`;
    }
    if (schema.anyOf) {
      const nonNull = schema.anyOf.filter((s) => s.type !== "null");
      if (nonNull.length === 1 && schema.anyOf.length === 2) return `${zod(nonNull[0], ctx)}.nullable()`;
      throw new Error(`unsupported anyOf in ${ctx}`);
    }
    if (schema.oneOf) {
      const values = schema.oneOf.map((s) => {
        if (s.type !== "string" || !Array.isArray(s.enum) || s.enum.length !== 1)
          throw new Error(`unsupported oneOf member in ${ctx}`);
        return s.enum[0];
      });
      return `z.enum(${JSON.stringify(values)})`;
    }
    if (Array.isArray(schema.type)) {
      const types = schema.type.filter((t) => t !== "null");
      if (types.length !== 1 || schema.type.length !== 2) throw new Error(`unsupported type list in ${ctx}`);
      return `${zod({ ...schema, type: types[0] }, ctx)}.nullable()`;
    }
    switch (schema.type) {
      case "string":
        if (isAccount(schema) || ACCOUNT_FIELDS.has(ctx)) return "accountId";
        if (NUMBER_FIELDS.has(ctx)) return "uintString";
        throw new Error(`string field ${ctx} is neither a known account nor a known number`);
      case "boolean":
        return "z.boolean()";
      case "integer": {
        const max = INT[schema.format];
        if (max === undefined) throw new Error(`unsupported integer format ${schema.format} in ${ctx}`);
        return `z.number().int().min(0).max(${max})`;
      }
      case "array": {
        const item = zod(schema.items, `${ctx}[]`);
        if (schema.minItems !== undefined && schema.minItems === schema.maxItems)
          return `z.tuple([${Array(schema.minItems).fill(item).join(", ")}])`;
        if (schema.minItems !== undefined || schema.maxItems !== undefined)
          throw new Error(`unsupported array bounds in ${ctx}`);
        return `z.array(${item})`;
      }
      case "object": {
        const required = new Set(schema.required ?? []);
        const props = Object.entries(schema.properties ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => {
            let s = zod(value, `${ctx}.${key}`);
            if (!required.has(key)) {
              // serde(default) fields (an empty list) are filled in; Option fields may be absent.
              if (Array.isArray(value.default) && value.default.length === 0) s = `${s}.default([])`;
              else s = `${s}.optional()`;
            }
            return `  ${key}: ${s},`;
          });
        return `z.object({\n${props.join("\n")}\n})`;
      }
      default:
        throw new Error(`unsupported schema type ${JSON.stringify(schema.type)} in ${ctx}`);
    }
  }

  // Definitions in dependency order, so every schema is declared before it is used.
  const order = [];
  const visit = (name, stack = []) => {
    if (order.includes(name)) return;
    if (stack.includes(name)) throw new Error(`recursive definition ${name}`);
    const refs = JSON.stringify(defs[name]).match(/#\/definitions\/(\w+)/g) ?? [];
    for (const ref of refs) visit(ref.slice("#/definitions/".length), [...stack, name]);
    order.push(name);
  };
  Object.keys(defs).sort().forEach((name) => visit(name));

  emit("// GENERATED by scripts/gen-abi.mjs from src/contract/intatto_abi.json. Do not edit.");
  emit(`// Contract ${abi.metadata.name} ${abi.metadata.version}, ABI built with ${abi.metadata.build?.builder ?? "?"},`);
  emit(`// wasm_hash ${abi.metadata.wasm_hash ?? "?"}.`);
  emit('import { z } from "zod";');
  emit("");
  emit("/** A NEAR account id, as near-account-id validates it (2 to 64 chars). */");
  emit(
    "export const accountId = z.string().min(2).max(64).regex(/^(([a-z\\d]+[-_])*[a-z\\d]+\\.)*([a-z\\d]+[-_])*[a-z\\d]+$/, \"not a valid NEAR account id\");",
  );
  emit("/** A u128 / u64 / NearToken as the contract serializes it: a decimal string, no sign or leading zeros. */");
  emit('export const uintString = z.string().regex(/^(0|[1-9]\\d*)$/, "not a decimal integer string");');
  emit("");
  for (const name of order) {
    const schema = defs[name];
    if (schema === true) {
      emit(`export const ${name}Schema = z.unknown();`);
    } else {
      emit(`export const ${name}Schema = ${zod(schema, name)};`);
    }
    // A type named Promise would shadow the global one in any module importing it.
    const typeName = name === "Promise" ? "PromiseValue" : name;
    emit(`export type ${typeName} = z.infer<typeof ${name}Schema>;`);
    emit("");
  }

  emit("/** Every public method: its kind, whether it takes a deposit, and its argument names. */");
  emit("export const METHODS = {");
  for (const f of [...abi.body.functions].sort((a, b) => a.name.localeCompare(b.name))) {
    const modifiers = f.modifiers ?? [];
    if (modifiers.includes("private") || modifiers.includes("init")) continue;
    const args = (f.params?.args ?? []).map((a) => a.name);
    emit(
      `  ${f.name}: { kind: ${JSON.stringify(f.kind)}, payable: ${modifiers.includes("payable")}, args: ${JSON.stringify(args)} },`,
    );
  }
  emit("} as const;");
  emit("export type MethodName = keyof typeof METHODS;");
  emit("");

  emit("/** Argument schemas of the methods this UI calls or shows. */");
  const argMethods = [
    "get_vault",
    "get_policy",
    "get_exchange_ledger",
    "set_agent",
    "withdraw",
    "withdraw_token",
    "lock_withdrawals_until",
    "reclaim_from_exchange",
    "agent_spend",
    "agent_swap",
  ];
  for (const name of argMethods) {
    const f = abi.body.functions.find((fn) => fn.name === name);
    if (!f) throw new Error(`ABI has no method ${name}`);
    const args = f.params?.args ?? [];
    const props = args.map((a) => `  ${a.name}: ${zod(a.type_schema, `${name}(${a.name})`)},`);
    const camel = name.replace(/_(\w)/g, (_, c) => c.toUpperCase());
    emit(`export const ${camel}Args = z.strictObject({\n${props.join("\n")}\n});`);
    emit(`export type ${camel[0].toUpperCase()}${camel.slice(1)}Args = z.infer<typeof ${camel}Args>;`);
  }
  emit("");
  return lines.join("\n");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes("--check");
  if (!check && existsSync(built)) copyFileSync(built, copy);
  const abi = JSON.parse(readFileSync(copy, "utf8"));
  const code = generate(abi);
  if (check) {
    const current = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (current !== code) {
      console.error("src/contract/abi.gen.ts is out of date; run node scripts/gen-abi.mjs");
      process.exit(1);
    }
    if (existsSync(built) && readFileSync(built, "utf8") !== readFileSync(copy, "utf8")) {
      console.error("src/contract/intatto_abi.json differs from ../target/near/intatto_abi.json");
      process.exit(1);
    }
    console.log("abi.gen.ts is up to date");
  } else {
    writeFileSync(out, code);
    console.log(`wrote ${out}`);
  }
}
