import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 8080);
const pagePath = fileURLToPath(new URL("./index.html", import.meta.url));
const promptScript = process.env.PROMPT_SCRIPT
  || fileURLToPath(new URL("./generate-prompt.mjs", import.meta.url));
const statusDashboardUrl = String(process.env.STATUS_DASHBOARD_URL || "").replace(/\/$/, "");
const page = await readFile(pagePath);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求格式无效");
  }
}

async function proxyStatus(request, response, pathname, search) {
  if (!statusDashboardUrl) {
    sendJson(response, 503, { error: "状态服务尚未配置" });
    return;
  }
  const body = request.method === "POST" ? await readJson(request) : undefined;
  const upstream = await fetch(`${statusDashboardUrl}${pathname}${search}`, {
    method: request.method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(data);
}

function normalizeOptions(body) {
  const sites = String(body.sites || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (sites.length === 0) throw new Error("请至少输入一个网站");
  if (sites.length > 500) throw new Error("一次最多生成 500 个网站的 Prompt");

  const browser = body.browser === "extension" ? "extension" : "iab";
  const exportMode = body.exportMode === "partial" ? "partial" : "api";
  const batchSize = Number(body.batchSize || 4);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new Error("并发线程数必须是 1–50 的整数");
  }

  const maxItems = body.maxItems === "" || body.maxItems == null
    ? null
    : Number(body.maxItems);
  if (maxItems != null && (!Number.isInteger(maxItems) || maxItems < 1)) {
    throw new Error("商品上限必须是正整数");
  }

  const note = String(body.note || "").trim();
  if (note.length > 2000) throw new Error("附加说明最多 2000 个字符");
  return { sites, browser, exportMode, batchSize, maxItems, note };
}

async function generatePrompt(options) {
  const args = [
    promptScript,
    ...options.sites,
    "--browser", options.browser,
    "--export", options.exportMode,
    "--batch-size", String(options.batchSize),
  ];
  if (options.sites.length > 1) args.push("--waves");
  if (options.maxItems != null) args.push("--max", String(options.maxItems));
  if (options.note) args.push("--note", options.note);

  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (error) {
    const detail = String(error.stderr || error.message || "生成失败").trim();
    throw new Error(detail.replace(/^generate-prompt:\s*/m, ""));
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": page.length,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(page);
    return;
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/status") {
    await proxyStatus(request, response, "/status", url.search);
    return;
  }

  if (["GET", "POST"].includes(request.method)
      && /^\/api\/(runs|reviews|sources)(\/|$)/.test(url.pathname)) {
    await proxyStatus(request, response, url.pathname, url.search);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/generate") {
    try {
      const options = normalizeOptions(await readJson(request));
      const prompt = await generatePrompt(options);
      sendJson(response, 200, { prompt, siteCount: options.sites.length });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "生成失败" });
    }
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`crawl-prompt-web listening on ${port}`);
});
