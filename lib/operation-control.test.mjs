import { describe, expect, it, vi } from "vitest";

import {
  captureVisualScreenshot,
  createReplayOperationRunner,
  replaceTaintedTab,
  runWithHardTimeout,
  shouldDiscardBrowserTab,
} from "./operation-control.mjs";

describe("browser operation control", () => {
  it("cuts off one hanging browser operation and marks the tab tainted", async () => {
    const startedAt = Date.now();
    const promise = runWithHardTimeout(
      () => new Promise(() => {}),
      { label: "hung_cdp", timeoutMs: 25 },
    );
    await expect(promise).rejects.toMatchObject({
      code: "browser_operation_timeout",
      operation: "hung_cdp",
      discardTab: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("bounds replay operations independently of the total route budget", async () => {
    const run = createReplayOperationRunner({
      replayBudgetMs: 10_000,
      operationTimeoutMs: 30,
    });
    await expect(run("route_step_0", () => new Promise(() => {}))).rejects.toMatchObject({
      code: "browser_operation_timeout",
      operation: "route_step_0",
      discardTab: true,
    });
  });

  it("closes a tainted tab best-effort and creates a replacement", async () => {
    const replacement = { id: "fresh" };
    const close = vi.fn(async () => {});
    const browser = {
      tabs: {
        new: vi.fn(async () => replacement),
      },
    };
    const error = await runWithHardTimeout(
      () => new Promise(() => {}),
      { label: "hung_navigation", timeoutMs: 10 },
    ).catch((value) => value);

    expect(shouldDiscardBrowserTab(error)).toBe(true);
    await expect(replaceTaintedTab(browser, { close }, error)).resolves.toMatchObject({
      tab: replacement,
      replaced: true,
      close: { ok: true },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(browser.tabs.new).toHaveBeenCalledOnce();
  });

  it("reports screenshot timeouts as non-persistable browser execution failures", async () => {
    const result = await captureVisualScreenshot({
      screenshot() {
        return new Promise(() => {});
      },
    }, { timeoutMs: 20 });
    expect(result).toMatchObject({
      ok: false,
      discardTab: true,
      access: {
        kind: "browser_execution_error",
        reason: "browser_screenshot_failed",
        persistable: false,
      },
    });
  });
});

describe("raw IAB CDP failure strings", () => {
  it("recognizes CDP command timeouts and closed targets as tainted tabs", async () => {
    const { shouldDiscardBrowserTab } = await import("./operation-control.mjs");
    expect(shouldDiscardBrowserTab(
      new Error('Timed out running CDP command "Page.getFrameTree" for tab 11'),
    )).toBe(true);
    expect(shouldDiscardBrowserTab(new Error("Target closed"))).toBe(true);
    expect(shouldDiscardBrowserTab(new Error("ordinary http 404"))).toBe(false);
  });
});
