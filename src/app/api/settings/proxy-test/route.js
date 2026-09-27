import { NextResponse } from "next/server";
import { testProxyUrl } from "@/lib/network/proxyTest";

export async function POST(request) {
  try {
    const body = await request.json();
    // testUrl is deliberately not taken from the caller: no caller sends it, and accepting
    // it let a session choose what the server reaches through the operator's proxy.
    const result = await testProxyUrl({
      proxyUrl: body?.proxyUrl,
      timeoutMs: body?.timeoutMs,
    });

    if (result?.ok) {
      return NextResponse.json(result);
    }

    const status = typeof result?.status === "number" ? result.status : 500;
    return NextResponse.json({ ok: false, error: result?.error || "Proxy test failed" }, { status });
  } catch (err) {
    const message = err?.name === "AbortError" ? "Proxy test timed out" : (err?.message || String(err));
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
