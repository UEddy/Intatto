import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AI_VERIFY_NOTE, AiDecisionLink } from "./IntentsPanel";

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

  it("says next to the link what it checks, and that the TEE check depends on NEAR AI's live service", () => {
    render(<AiDecisionLink d={{ kind: "receipt", url: "https://cloud.near.ai/verify?model=m#receipt=eyJ9", model: "m", requestHash: "a".repeat(64), responseHash: "b".repeat(64), signingAddress: "0x" + "1".repeat(40) }} />);
    expect(screen.getByText(AI_VERIFY_NOTE)).toBeTruthy();
    expect(AI_VERIFY_NOTE).toBe(
      "Checks NEAR AI's signature over this trade's request and response hashes, which are in the transaction's arguments. The TEE hardware check runs live on NEAR AI's attestation service; if that service is down, it shows as failed while the signature still verifies.",
    );
    expect(AI_VERIFY_NOTE).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it("shows a refused receipt as refused, with no link", () => {
    render(<AiDecisionLink d={{ kind: "refused", reason: "the receipt does not sign the hashes recorded with this trade" }} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("AI receipt refused")).toBeTruthy();
  });
});
