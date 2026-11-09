import { describe, expect, it } from "vitest";
import { base58ToHex } from "./base58";

describe("base58ToHex", () => {
  it("matches near CLI's hex for vault-v1's code (checked 2026-11-08)", () => {
    expect(base58ToHex("FevckYG3RhhFYhj21xvC2nufv1z5vYmuG6P9nrK3hHCa")).toBe("d9babb2cb8fb14e30fd45753293f513dc7a00743d354c3d0af88e0f93e82653f");
  });
  it("keeps leading zero bytes and rejects other alphabets", () => {
    expect(base58ToHex("11111111111111111111111111111111")).toBe("00".repeat(32));
    expect(() => base58ToHex("0OIl")).toThrow();
  });
});
