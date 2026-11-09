import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { nextArrivals, useArrivals } from "./useArrivals";

describe("arrivals", () => {
  it("treats the first set as already there, and later new keys as arrivals", () => {
    const a = nextArrivals(null, ["x", "y"]);
    expect(a.added).toEqual([]);
    const b = nextArrivals(a.seen, ["z", "x", "y"]);
    expect(b.added).toEqual(["z"]);
    expect(nextArrivals(b.seen, ["z", "x", "y"]).added).toEqual([]);
  });

  it("marks only what a later poll brought", () => {
    const { result, rerender } = renderHook(({ keys }: { keys: string[] | undefined }) => useArrivals(keys), { initialProps: { keys: undefined as string[] | undefined } });
    rerender({ keys: ["b", "a"] });
    expect([...result.current]).toEqual([]);
    act(() => rerender({ keys: ["c", "b", "a"] }));
    expect([...result.current]).toEqual(["c"]);
  });
});
