import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

function allowedPath(pathname: string) {
  return [
    /^runs$/,
    /^runs\/[0-9a-f-]+$/i,
    /^reviews$/,
    /^reviews\/[0-9a-f-]+\/resolve$/i,
    /^sources$/,
  ].some((pattern) => pattern.test(pathname));
}

async function proxy(request: NextRequest, context: RouteContext) {
  const baseUrl = String(process.env.STATUS_DASHBOARD_URL ?? "").replace(/\/$/, "");
  if (!baseUrl) {
    return Response.json({ error: "状态服务尚未配置" }, { status: 503 });
  }

  const pathname = (await context.params).path.join("/");
  if (!allowedPath(pathname)) return Response.json({ error: "Not found" }, { status: 404 });

  try {
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && Buffer.byteLength(body) > 1024 * 1024) {
      return Response.json({ error: "请求内容过大" }, { status: 413 });
    }
    const headers = new Headers();
    if (body) headers.set("content-type", "application/json");
    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);

    const upstream = await fetch(`${baseUrl}/api/${pathname}${request.nextUrl.search}`, {
      method: request.method,
      headers,
      body: body || undefined,
      cache: "no-store",
    });
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "状态服务暂时不可用" },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
