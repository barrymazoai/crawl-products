"use client";

import { AlertTriangle, ArrowLeft, CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type CrawlRun = {
  id: string;
  url: string;
  status: string;
  capture_status: string;
  clean_status: string;
  ingest_status: string;
  cleanup_status: string;
  captured_count?: number | null;
  manifest_count?: number | null;
  ingested_count?: number | null;
  created_at: string;
  finished_at?: string | null;
};

type Review = {
  id: string;
  batch_id?: string | null;
  url: string;
  reason_code: string;
  reason_message: string;
  created_at: string;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const data = await response.json().catch(() => ({})) as T & { error?: string | { message?: string } };
  if (!response.ok) {
    const detail = typeof data.error === "string" ? data.error : data.error?.message;
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return data;
}

const actionLabels: Record<string, string> = {
  retry_capture: "重新抓取",
  resume_ingest: "确认结果并继续入库",
  retry_clean: "重新清洗",
  abandon_run: "放弃整个任务",
};

export function StatusDashboard() {
  const [runs, setRuns] = useState<CrawlRun[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [runData, reviewData] = await Promise.all([
        api<{ runs: CrawlRun[] }>("/api/control/runs"),
        api<{ reviews: Review[] }>("/api/control/reviews?status=open"),
      ]);
      setRuns(runData.runs ?? []);
      setReviews(reviewData.reviews ?? []);
      setUpdatedAt(new Date());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "状态服务暂时不可用");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const metrics = useMemo(() => {
    const count = (status: string) => runs.filter((run) => run.status === status).length;
    return [
      ["排队", count("queued")],
      ["运行中", count("active") + count("retry_wait")],
      ["待复核", reviews.length],
      ["待清理", count("cleanup_pending")],
      ["已完成", count("completed")],
    ] as const;
  }, [runs, reviews]);

  async function resolveReview(review: Review, action: string) {
    if (!window.confirm(`确定要${actionLabels[action]}吗？`)) return;
    setResolving(review.id);
    try {
      await api(`/api/control/reviews/${review.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, resolution: actionLabels[action] }),
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setResolving(null);
    }
  }

  return (
    <main className="mx-auto w-[min(1240px,calc(100%-1.75rem))] py-10 md:py-14">
      <header className="mb-7 flex flex-col justify-between gap-5 md:flex-row md:items-end">
        <div>
          <Link href="/" className="mb-5 inline-flex items-center gap-2 text-sm font-bold text-[var(--accent-dark)] hover:underline">
            <ArrowLeft size={16} aria-hidden="true" /> 返回 Prompt 生成器
          </Link>
          <div className="text-xs font-black uppercase tracking-[0.15em] text-[var(--accent)]">Product Crawl Pipeline</div>
          <h1 className="serif mt-2 text-[clamp(2.4rem,6vw,4rem)] font-medium leading-none tracking-[-0.045em]">任务状态与复核</h1>
          <p className="mt-3 text-sm text-[var(--muted)] md:text-base">Railway 排队，Windows 抓取，Mac 清洗并入库。页面每 15 秒自动刷新。</p>
        </div>
        <button onClick={() => void refresh()} disabled={loading} className="button-lift inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-extrabold text-white hover:bg-[var(--accent-dark)]">
          {loading ? <LoaderCircle size={17} className="animate-spin" /> : <RefreshCw size={17} />}
          {loading ? "刷新中…" : "立即刷新"}
        </button>
      </header>

      {error && (
        <div role="alert" className="mb-5 flex items-start gap-3 rounded-2xl border border-[#ebc4be] bg-[#fff1ef] px-4 py-3 text-sm text-[var(--danger)]">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div><b>暂时无法读取任务状态</b><p className="mt-1 text-xs leading-5">{error}</p></div>
        </div>
      )}

      <section className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {metrics.map(([label, value]) => (
          <article key={label} className="surface rounded-2xl px-4 py-4 md:px-5">
            <span className="text-xs text-[var(--muted)]">{label}</span>
            <b className="serif mt-1 block text-3xl font-medium">{value}</b>
          </article>
        ))}
      </section>

      <Panel title="待复核" meta={`${reviews.length} 项`}>
        {reviews.length === 0 ? <Empty icon={<CheckCircle2 size={24} />} text="现在没有待复核项" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-left text-[13px]">
              <thead><tr className="bg-[#f7f9f6] text-[11px] uppercase tracking-wider text-[var(--muted)]"><Th>网站</Th><Th>原因</Th><Th>说明</Th><Th>时间</Th><Th>操作</Th></tr></thead>
              <tbody>{reviews.map((review) => (
                <tr key={review.id} className="border-t border-[#e7ebe8] align-top">
                  <Td><div className="max-w-[320px] truncate" title={review.url}>{review.url}</div></Td>
                  <Td><StatusPill status={review.reason_code} /></Td>
                  <Td>{review.reason_message}</Td>
                  <Td>{formatDate(review.created_at)}</Td>
                  <Td><div className="flex flex-wrap gap-2">
                    {review.batch_id ? <>
                      <ActionButton disabled={resolving === review.id} onClick={() => void resolveReview(review, "resume_ingest")} tone="green">确认并入库</ActionButton>
                      <ActionButton disabled={resolving === review.id} onClick={() => void resolveReview(review, "retry_clean")} tone="amber">重清洗</ActionButton>
                    </> : <ActionButton disabled={resolving === review.id} onClick={() => void resolveReview(review, "retry_capture")} tone="amber">重新抓取</ActionButton>}
                    <ActionButton disabled={resolving === review.id} onClick={() => void resolveReview(review, "abandon_run")} tone="red">放弃</ActionButton>
                  </div></Td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="最近任务" meta={updatedAt ? `更新于 ${updatedAt.toLocaleTimeString("zh-CN")}` : "尚未连接"}>
        {runs.length === 0 ? <Empty text="还没有任务" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-[13px]">
              <thead><tr className="bg-[#f7f9f6] text-[11px] uppercase tracking-wider text-[var(--muted)]"><Th>网站</Th><Th>总状态</Th><Th>阶段</Th><Th>数量</Th><Th>开始 / 完成</Th></tr></thead>
              <tbody>{runs.map((run) => (
                <tr key={run.id} className="border-t border-[#e7ebe8] align-top">
                  <Td><div className="max-w-[330px] truncate" title={run.url}>{run.url}</div></Td>
                  <Td><StatusPill status={run.status} /></Td>
                  <Td><div className="flex flex-wrap gap-1"><StatusPill status={`抓 ${run.capture_status}`} subtle /><StatusPill status={`洗 ${run.clean_status}`} subtle /><StatusPill status={`库 ${run.ingest_status}`} subtle /><StatusPill status={`删 ${run.cleanup_status}`} subtle /></div></Td>
                  <Td>{run.captured_count ?? 0} / {run.manifest_count ?? "?"} · 入库 {run.ingested_count ?? 0}</Td>
                  <Td>{formatDate(run.created_at)}{run.finished_at && <><br />{formatDate(run.finished_at)}</>}</Td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>
    </main>
  );
}

function Panel({ title, meta, children }: { title: string; meta: string; children: React.ReactNode }) {
  return <section className="surface mt-4 overflow-hidden rounded-2xl"><div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4"><h2 className="font-extrabold">{title}</h2><span className="text-xs text-[var(--muted)]">{meta}</span></div>{children}</section>;
}

function Empty({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-[var(--muted)]">{icon}{text}</div>;
}

function Th({ children }: { children: React.ReactNode }) { return <th className="px-4 py-3 font-bold">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-4 py-3">{children}</td>; }

function StatusPill({ status, subtle = false }: { status: string; subtle?: boolean }) {
  const base = status.replace(/^[抓洗库删]\s/, "");
  const tone = subtle ? "bg-[#edf0ee] text-[#53605a]" :
    ["completed", "passed", "approved"].includes(base) ? "bg-[#dceee6] text-[var(--accent)]" :
    ["needs_review", "open", "retry_wait"].includes(base) ? "bg-[#fff0cb] text-[#8a5410]" :
    ["failed", "abandoned"].includes(base) ? "bg-[#f8dfdc] text-[var(--danger)]" :
    ["active", "running"].includes(base) ? "bg-[#ddebf2] text-[#326b8a]" : "bg-[#e7ece9] text-[#45534c]";
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-extrabold ${tone}`}>{status}</span>;
}

function ActionButton({ children, onClick, disabled, tone }: { children: React.ReactNode; onClick: () => void; disabled: boolean; tone: "green" | "amber" | "red" }) {
  const colors = tone === "green" ? "bg-[var(--accent)] text-white" : tone === "amber" ? "bg-[#fff0cd] text-[#6d4a13]" : "bg-[#f9dfdc] text-[#8c312a]";
  return <button type="button" onClick={onClick} disabled={disabled} className={`button-lift min-h-9 rounded-lg px-3 text-xs font-extrabold ${colors}`}>{children}</button>;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
