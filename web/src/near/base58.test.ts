import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode, base58ToHex } from "./base58";

describe("base58ToHex", () => {
  it("matches near CLI's hex for vault-v1's code (checked 2026-11-08)", () => {
    expect(base58ToHex("FevckYG3RhhFYhj21xvC2nufv1z5vYmuG6P9nrK3hHCa")).toBe("d9babb2cb8fb14e30fd45753293f513dc7a00743d354c3d0af88e0f93e82653f");
  });
  it("keeps leading zero bytes and rejects other alphabets", () => {
    expect(base58ToHex("11111111111111111111111111111111")).toBe("00".repeat(32));
    expect(() => base58ToHex("0OIl")).toThrow();
  });
});

describe("base58Encode", () => {
  it("is base58Decode's inverse, leading zeros included", () => {
    for (const text of ["5aGuMWbXy1QM5ocroB2mkvTagtHmYvxze5KY1jLvwmUi", "HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC", "11111111111111111111111111111111", "1112"]) {
      expect(base58Encode(base58Decode(text))).toBe(text);
    }
    expect(base58Encode(new Uint8Array())).toBe("");
  });
});
