import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AiDecisionLink } from "./IntentsPanel";

describe("AiDecisionLink", () => {
  it("renders nothing for a trade without a receipt: no link, not a broken one", () => {
    const { container } = render(<AiDecisionLink d={{ kind: "none" }} />);
    expect(container.innerHTML).toBe("");
  });

  it("links the Verification Center in a new tab, with no referrer", () => {
    const url = "https://cloud.near.ai/verify?model=m#receipt=eyJ9";
    render(<AiDecisionLink d={{ kind: "receipt", url, model: "m", requestHash: "a".repeat(64), responseHash: "b".repeat(64), signingAddress: "0x" + "1".repeat(40) }} />);
    const a = screen.getByRole("link", { name: /Verify AI decision/ });
    expect(a.getAttribute("href")).toBe(url);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows a refused receipt as refused, with no link", () => {
    render(<AiDecisionLink d={{ kind: "refused", reason: "the receipt does not sign the hashes recorded with this trade" }} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("AI receipt refused")).toBeTruthy();
  });
});
