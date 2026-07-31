import { describe, expect, it } from "vitest";

import {
  classifyBrowserAccessError,
  classifySiteOutcome,
  createSiteObservation,
  isSiteObservationFresh,
} from "./site-outcome.mjs";

describe("site outcome classification", () => {
  it.each([
    ["net::ERR_TIMED_OUT", "navigation_timeout"],
    ["net::ERR_CONNECTION_CLOSED", "connection_closed"],
    ["net::ERR_CERT_COMMON_NAME_INVALID", "tls_certificate_error"],
  ])("classifies %s as %s", (message, kind) => {
    expect(classifyBrowserAccessError(message)).toMatchObject({
      kind,
      persistable: true,
    });
  });

  it("does not persist browser execution policy failures as site facts", () => {
    const access = classifyBrowserAccessError("blocked_by_browser_url_policy");
    expect(access).toMatchObject({
      kind: "browser_execution_error",
      retryable: true,
      persistable: false,
    });
    expect(createSiteObservation("https://shop.test", {
      kind: "access_error",
      access,
    })).toBeNull();
  });

  it.each([
    "Timed out waiting for CDP command Page.captureScreenshot",
    "screenshot_render_blank",
    "browser_operation_timeout:visual_screenshot:10000",
  ])("keeps screenshot/control failure %s out of site observations", (message) => {
    const access = classifyBrowserAccessError(message);
    expect(access).toMatchObject({
      kind: "browser_execution_error",
      retryable: true,
      persistable: false,
    });
    expect(createSiteObservation("https://shop.test", {
      kind: "access_error",
      access,
    })).toBeNull();
  });

  it("keeps official store handoffs distinct from brand portfolios", () => {
    expect(classifySiteOutcome({
      officialStoreUrl: "https://official-shop.test/catalog",
    })).toEqual({
      kind: "official_store_handoff",
      terminal: false,
      officialStoreUrl: "https://official-shop.test/catalog",
    });
    expect(classifySiteOutcome({
      portfolioOrigins: ["https://brand-a.test", "https://brand-b.test"],
    })).toEqual({
      kind: "portfolio",
      terminal: false,
    });
  });

  it("expires persisted access observations", () => {
    const checkedAt = "2026-07-29T00:00:00.000Z";
    const access = classifyBrowserAccessError("net::ERR_TIMED_OUT", { checkedAt });
    const observation = createSiteObservation(
      "https://shop.test",
      { kind: "access_error", access },
      { checkedAt },
    );
    expect(isSiteObservationFresh(
      observation,
      Date.parse("2026-07-29T00:30:00.000Z"),
    )).toBe(true);
    expect(isSiteObservationFresh(
      observation,
      Date.parse("2026-07-29T02:00:00.000Z"),
    )).toBe(false);
  });
});
