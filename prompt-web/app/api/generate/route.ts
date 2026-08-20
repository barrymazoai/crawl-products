import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type GenerateInput = {
  sites?: unknown;
  browser?: unknown;
  exportMode?: unknown;
  batchSize?: unknown;
  maxItems?: unknown;
  note?: unknown;
};

type Options = {
  sites: string[];
  browser: "iab" | "extension";
  exportMode: "api" | "partial";
  batchSize: number;
  maxItems: number | null;
  note: string;
};

function normalizeOptions(body: GenerateInput): Options {
  const sites = String(body.sites ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (sites.length === 0) throw new Error("请至少输入一个网站");
  if (sites.length > 500) throw new Error("一次最多生成 500 个网站的 Prompt");

  const browser = body.browser === "extension" ? "extension" : "iab";
  const exportMode = body.exportMode === "partial" ? "partial" : "api";
  const batchSize = Number(body.batchSize ?? 4);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new Error("并发线程数必须是 1–50 的整数");
  }

  const maxItems = body.maxItems === "" || body.maxItems == null ? null : Number(body.maxItems);
  if (maxItems != null && (!Number.isInteger(maxItems) || maxItems < 1)) {
    throw new Error("商品上限必须是正整数");
  }

  const note = String(body.note ?? "").trim();
  if (note.length > 2000) throw new Error("附加说明最多 2000 个字符");
  return { sites, browser, exportMode, batchSize, maxItems, note };
}

async function resolvePromptScript() {
  const candidates = [
    process.env.PROMPT_SCRIPT,
    path.join(process.cwd(), "generate-prompt.mjs"),
    path.join(process.cwd(), "..", "scripts", "generate-prompt.mjs"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known deployment/development location.
    }
  }
  throw new Error("找不到 Prompt 生成脚本");
}

async function generatePrompt(options: Options) {
  const args = [
    await resolvePromptScript(),
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
    const caught = error as Error & { stderr?: string };
    const detail = String(caught.stderr || caught.message || "生成失败").trim();
    throw new Error(detail.replace(/^generate-prompt:\s*/m, ""));
  }
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("请求内容过大");
    const options = normalizeOptions(JSON.parse(raw) as GenerateInput);
    const prompt = await generatePrompt(options);
    return Response.json(
      { prompt, siteCount: options.sites.length },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof SyntaxError
      ? "请求格式无效"
      : error instanceof Error ? error.message : "生成失败";
    return Response.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
