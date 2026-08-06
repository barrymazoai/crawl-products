/**
 * Hard operation deadlines and tainted-tab recovery.
 *
 * Browser calls may expose their own timeout options, but a single CDP or
 * extension RPC can still outlive the route-level budget. These helpers put an
 * outer deadline around the promise and mark the current tab as unsafe when
 * the browser operation does not return in time.
 */

function positiveTimeout(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.max(1, Math.round(numeric))
    : fallback;
}

export function createBrowserOperationTimeoutError(label, timeoutMs, opts = {}) {
  const error = new Error(`browser_operation_timeout:${label}:${timeoutMs}`);
  error.name = "BrowserOperationTimeoutError";
  error.code = "browser_operation_timeout";
  error.operation = label;
  error.timeoutMs = timeoutMs;
  error.retryable = true;
  error.discardTab = opts.discardTab !== false;
  error.browserExecutionError = true;
  return error;
}

export function createReplayBudgetError(label, budgetMs) {
  const error = new Error(`visual_route_replay_budget_exceeded:${label}`);
  error.name = "VisualRouteReplayBudgetError";
  error.code = "visual_route_replay_budget_exceeded";
  error.operation = label;
  error.budgetMs = budgetMs;
  error.retryable = true;
  error.discardTab = true;
  error.browserExecutionError = true;
  return error;
}

export function shouldDiscardBrowserTab(error) {
  if (!error) return false;
  if (error.discardTab === true || error.browserExecutionError === true) return true;
  const text = String(error?.message || error);
  // Raw CDP/IAB failure strings count too: the In-App Browser surfaces frame
  // and target failures as plain command timeouts rather than typed errors.
  return /browser_operation_timeout|visual_route_replay_budget_exceeded|visual_route_operation_timeout|timed out running cdp command|target (?:closed|crashed)|session closed/i
    .test(text);
}

export async function runWithHardTimeout(operation, opts = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("runWithHardTimeout requires an operation function");
  }
  const label = String(opts.label || "browser_operation").slice(0, 160);
  const timeoutMs = positiveTimeout(opts.timeoutMs, 20_000);
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(createBrowserOperationTimeoutError(label, timeoutMs, opts));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createReplayOperationRunner(opts = {}) {
  const startedAt = Number(opts.startedAt || Date.now());
  const replayBudgetMs = positiveTimeout(opts.replayBudgetMs, 90_000);
  const deadlineAt = startedAt + replayBudgetMs;
  const defaultOperationTimeoutMs = positiveTimeout(opts.operationTimeoutMs, 15_000);

  return async (label, operation, operationTimeoutMs = defaultOperationTimeoutMs) => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw createReplayBudgetError(label, replayBudgetMs);
    const requestedTimeoutMs = positiveTimeout(
      operationTimeoutMs,
      defaultOperationTimeoutMs,
    );
    const timeoutMs = Math.max(1, Math.min(requestedTimeoutMs, remainingMs));
    try {
      return await runWithHardTimeout(operation, {
        label,
        timeoutMs,
        discardTab: true,
      });
    } catch (error) {
      if (error?.code === "browser_operation_timeout" && remainingMs <= requestedTimeoutMs) {
        throw createReplayBudgetError(label, replayBudgetMs);
      }
      throw error;
    }
  };
}

async function settleWithin(operation, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error) }),
      ),
      new Promise((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ ok: false, error: "cleanup_timeout" }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Close a timed-out tab best-effort and return a fresh tab from the same
 * browser binding. Callers must replace their old tab variable with result.tab.
 */
export async function replaceTaintedTab(browser, tab, error, opts = {}) {
  if (!shouldDiscardBrowserTab(error)) {
    return { tab, replaced: false, reason: "tab_not_tainted" };
  }
  if (!browser?.tabs?.new) {
    throw new Error("browser_tabs_new_required_for_tainted_tab_recovery");
  }
  const closeTimeoutMs = positiveTimeout(opts.closeTimeoutMs, 1_500);
  const newTabTimeoutMs = positiveTimeout(opts.newTabTimeoutMs, 8_000);
  const close = tab?.close
    ? await settleWithin(() => tab.close(), closeTimeoutMs)
    : { ok: false, error: "tab_close_unavailable" };
  const replacement = await runWithHardTimeout(
    () => browser.tabs.new(),
    {
      label: "replace_tainted_tab",
      timeoutMs: newTabTimeoutMs,
      discardTab: false,
    },
  );
  return {
    tab: replacement,
    replaced: true,
    close,
    reason: error?.code || "browser_execution_error",
  };
}

/**
 * Bound a screenshot call without turning a screenshot failure into site
 * evidence. The returned bytes can be passed directly to nodeRepl.emitImage.
 */
export async function captureVisualScreenshot(tab, opts = {}) {
  const timeoutMs = positiveTimeout(opts.timeoutMs, 10_000);
  try {
    const bytes = await runWithHardTimeout(
      () => tab.screenshot({
        ...(opts.fullPage === true ? { fullPage: true } : {}),
        ...(opts.clip ? { clip: opts.clip } : {}),
      }),
      {
        label: opts.label || "visual_screenshot",
        timeoutMs,
        discardTab: true,
      },
    );
    return { ok: true, bytes };
  } catch (error) {
    return {
      ok: false,
      error,
      access: {
        kind: "browser_execution_error",
        reason: "browser_screenshot_failed",
        retryable: true,
        persistable: false,
      },
      discardTab: shouldDiscardBrowserTab(error),
    };
  }
}
