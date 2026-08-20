"use client";

import { Check, Clipboard, ExternalLink, LoaderCircle, Settings2, Sparkles } from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type GenerateResult = { prompt: string; siteCount: number };

export function PromptStudio() {
  const formRef = useRef<HTMLFormElement>(null);
  const [sites, setSites] = useState("");
  const [browser, setBrowser] = useState("iab");
  const [exportMode, setExportMode] = useState("api");
  const [batchSize, setBatchSize] = useState("4");
  const [maxItems, setMaxItems] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const siteCount = useMemo(
    () => sites.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).length,
    [sites],
  );

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        formRef.current?.requestSubmit();
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setCopied(false);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sites, browser, exportMode, batchSize, maxItems, note }),
      });
      const data = await response.json() as GenerateResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "生成失败");
      setResult(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成失败");
    } finally {
      setLoading(false);
    }
  }

  async function copyPrompt() {
    if (!result?.prompt) return;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(result.prompt);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = result.prompt;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main className="mx-auto w-[min(1120px,calc(100%-2rem))] py-10 md:py-16">
      <header className="mb-8">
        <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-start">
          <div>
            <div className="mb-4 flex items-center gap-2 text-xs font-black uppercase tracking-[0.15em] text-[var(--accent-dark)]">
              <span className="h-0.5 w-7 bg-[var(--accent)]" /> Product Crawl Pipeline
            </div>
            <h1 className="serif max-w-3xl text-[clamp(2.7rem,7vw,4.8rem)] font-medium leading-[0.94] tracking-[-0.05em]">
              把网站清单变成<br />可执行的抓取任务
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--muted)] md:text-lg">
              每行输入一个网站。系统会生成一份能直接交给 Codex 的 Prompt，并自动带上 Skill、并发和验证约束。
            </p>
          </div>
          <Link
            href="/status"
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--line)] bg-[rgba(255,253,248,.82)] px-4 text-sm font-extrabold text-[var(--accent-dark)] transition hover:-translate-y-0.5 hover:bg-white"
          >
            查看任务状态 <ExternalLink size={15} aria-hidden="true" />
          </Link>
        </div>
      </header>

      <form ref={formRef} onSubmit={submit}>
        <div className="grid items-start gap-5 lg:grid-cols-[1.08fr_.72fr]">
          <section className="surface rounded-3xl p-5 md:p-7">
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <label htmlFor="sites" className="text-sm font-extrabold">网站清单</label>
              <span className="text-xs text-[var(--muted)]">{siteCount} 个网站</span>
            </div>
            <textarea
              id="sites"
              value={sites}
              onChange={(event) => setSites(event.target.value)}
              className="field-control min-h-[340px] resize-y p-4 font-mono text-sm leading-7"
              placeholder={"https://example.com\nhttps://another-store.com\nbrand-site.com"}
              spellCheck={false}
              autoFocus
            />
            <p className="mt-3 text-xs leading-5 text-[var(--muted)]">支持完整 URL 或域名；重复项会由生成脚本自动去除。</p>
          </section>

          <section className="surface rounded-3xl p-5 md:p-7">
            <div className="mb-5 flex items-center gap-2">
              <Settings2 size={18} className="text-[var(--accent)]" aria-hidden="true" />
              <h2 className="text-base font-extrabold">运行设置</h2>
            </div>

            <div className="space-y-5">
              <Field label="浏览器方式" htmlFor="browser">
                <select id="browser" value={browser} onChange={(event) => setBrowser(event.target.value)} className="field-control h-11 px-3 text-sm">
                  <option value="iab">Codex 内置浏览器</option>
                  <option value="extension">本地 Chrome</option>
                </select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="每批线程" htmlFor="batchSize">
                  <input id="batchSize" type="number" min="1" max="50" value={batchSize} onChange={(event) => setBatchSize(event.target.value)} className="field-control h-11 px-3 text-sm" />
                </Field>
                <Field label="商品上限" htmlFor="maxItems">
                  <input id="maxItems" type="number" min="1" value={maxItems} onChange={(event) => setMaxItems(event.target.value)} className="field-control h-11 px-3 text-sm" placeholder="全量" />
                </Field>
              </div>

              <Field label="导出方式" htmlFor="exportMode">
                <select id="exportMode" value={exportMode} onChange={(event) => setExportMode(event.target.value)} className="field-control h-11 px-3 text-sm">
                  <option value="api">正式 API-ready 导出</option>
                  <option value="partial">只保存部分清单</option>
                </select>
              </Field>

              <Field label="附加说明" htmlFor="note">
                <textarea id="note" value={note} onChange={(event) => setNote(event.target.value)} className="field-control min-h-24 resize-y p-3 text-sm leading-6" maxLength={2000} placeholder="例如：优先抓取英文站点，保留原始图片链接……" />
              </Field>
            </div>

            <div className="mt-5 rounded-r-xl border-l-[3px] border-[var(--focus)] bg-[#fff8e9] px-4 py-3 text-xs leading-5 text-[#5c5140]">
              多网站会自动生成协调者 Prompt，并要求按批次并行处理；具体命令由执行端自行选择。
            </div>

            <button type="submit" disabled={loading} className="button-lift mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-5 text-sm font-black text-white hover:bg-[var(--accent-dark)]">
              {loading ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Sparkles size={18} aria-hidden="true" />}
              {loading ? "正在生成…" : "生成运行 Prompt"}
            </button>
            {error && <p role="alert" className="mt-3 text-sm font-semibold text-[var(--danger)]">{error}</p>}
          </section>
        </div>
      </form>

      {result && (
        <section className="surface mt-5 overflow-hidden rounded-3xl" aria-live="polite">
          <div className="flex flex-col gap-3 border-b border-[var(--line)] bg-[#f8faf7] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-extrabold">Prompt 已生成</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">包含 {result.siteCount} 个网站，可直接复制到 Codex 运行。</p>
            </div>
            <button type="button" onClick={copyPrompt} className="button-lift inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-[#e4efe9] px-4 text-sm font-extrabold text-[var(--accent-dark)]">
              {copied ? <Check size={16} aria-hidden="true" /> : <Clipboard size={16} aria-hidden="true" />}
              {copied ? "已复制" : "复制 Prompt"}
            </button>
          </div>
          <pre className="max-h-[680px] min-h-56 overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-[13px] leading-6 text-[#26332d] md:p-7">{result.prompt}</pre>
        </section>
      )}
    </main>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-2 block text-[13px] font-bold text-[#34413b]">{label}</label>
      {children}
    </div>
  );
}
