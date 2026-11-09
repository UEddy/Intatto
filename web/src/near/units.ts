/**
 * Token amounts are bigints in the token's smallest unit, always. Conversion to and from text is
 * exact: no floating point anywhere.
 */

export const NEAR_DECIMALS = 24;
export const YOCTO_PER_NEAR = 10n ** 24n;

const UINT = /^(0|[1-9]\d*)$/;

/** Parses a decimal integer string as the contract serializes u128 / u64. */
export function toBig(raw: string): bigint {
  if (!UINT.test(raw)) throw new Error(`not a decimal integer string: ${JSON.stringify(raw)}`);
  return BigInt(raw);
}

export interface FormatOptions {
  /** Most fraction digits shown; the value is truncated (never rounded up). Default: all. */
  readonly maxFraction?: number;
  /** Group the whole part in thousands. Default true. */
  readonly group?: boolean;
}

/** 1234500000 with 6 decimals -> "1,234.5". Truncation is marked with a trailing "…". */
export function formatUnits(amount: bigint, decimals: number, options: FormatOptions = {}): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(`bad decimals ${decimals}`);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let fraction = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  let truncated = false;
  const max = options.maxFraction;
  if (max !== undefined && fraction.length > max) {
    truncated = /[1-9]/.test(fraction.slice(max));
    fraction = fraction.slice(0, max).replace(/0+$/, "");
  }
  const wholeText = options.group === false ? whole.toString() : groupThousands(whole.toString());
  // A non-zero amount that shows as 0 says so instead of claiming zero.
  if (whole === 0n && fraction === "" && abs !== 0n) return `${negative ? "-" : ""}<0.${"0".repeat(Math.max(0, (max ?? 1) - 1))}1`;
  return `${negative ? "-" : ""}${wholeText}${fraction ? `.${fraction}` : ""}${truncated ? "…" : ""}`;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export type ParseResult = { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly error: string };

/**
 * "1.5" with 24 decimals -> 1500000000000000000000000n. Accepts digits with one optional "." and
 * optional thousands commas; rejects signs, exponents, and more fraction digits than the token has.
 */
export function parseUnits(text: string, decimals: number): ParseResult {
  const trimmed = text.trim().replace(/,/g, "");
  if (trimmed === "") return { ok: false, error: "Enter an amount" };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) return { ok: false, error: "Not a number" };
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    return { ok: false, error: `At most ${decimals} digit${decimals === 1 ? "" : "s"} after the decimal point` };
  }
  const value = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return { ok: true, value };
}

/** yoctoNEAR -> "1.5 NEAR"-style text without the unit. */
export function formatNear(yocto: bigint, options: FormatOptions = {}): string {
  return formatUnits(yocto, NEAR_DECIMALS, options);
}

/** Tera-gas text for display: 30000000000000 -> "30". */
export function formatTgas(gas: bigint): string {
  return formatUnits(gas, 12);
}
