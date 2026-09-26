import { NextResponse } from "next/server";
import REGISTRY from "open-sse/providers/registry/index.js";
import { FILTERS } from "./filters.js";

export const dynamic = "force-dynamic";

// The only URLs this proxy exists for: each provider's `modelsFetcher` in the registry.
// It used to fetch any `?url=`, which let a dashboard session aim the server at internal
// hosts or cloud metadata. An exact (type, url) allow-list keeps the CORS proxy and
// removes the SSRF, with nothing to parse or resolve.
const DECLARED = new Set(
  REGISTRY.map((p) => p?.modelsFetcher)
    .filter((f) => typeof f?.url === "string" && typeof f?.type === "string")
    .map((f) => `${f.type} ${f.url}`)
);

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  if (!DECLARED.has(`${type} ${url}`)) {
    return NextResponse.json({ error: "url is not a registered models source" }, { status: 400 });
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
