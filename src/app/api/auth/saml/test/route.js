import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { formatX509Certificate } from "@/lib/auth/saml.js";
import { isAuthenticated } from "@/dashboardGuard";

// /api/auth/saml/* is public in the guard (start and acs must be), so this route
// authenticates itself — with the guard's rules. The local copy honoured
// requireLogin=false from ANY peer and skipped the cross-site check.
async function canAccessTestRoute(request) {
  return isAuthenticated(request);
}

export async function POST(request) {
  try {
    if (!(await canAccessTestRoute(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();

    const samlEntryPoint = String(body.samlEntryPoint || settings.samlEntryPoint || "").trim();
    const samlIssuer = String(body.samlIssuer || settings.samlIssuer || "urn:9router:sp").trim();
    const samlCert = String(
      Object.prototype.hasOwnProperty.call(body, "samlCert")
        ? body.samlCert
        : settings.samlCert || ""
    ).trim();

    if (!samlEntryPoint) {
      return NextResponse.json({ error: "Single Sign-On Service URL (samlEntryPoint) is required" }, { status: 400 });
    }

    try {
      new URL(samlEntryPoint);
    } catch {
      return NextResponse.json({ error: "Single Sign-On Service URL must be a valid URL" }, { status: 400 });
    }

    if (!samlIssuer) {
      return NextResponse.json({ error: "SP Entity ID / Issuer (samlIssuer) is required" }, { status: 400 });
    }

    if (!samlCert) {
      return NextResponse.json({ error: "IdP X.509 Certificate (samlCert) is required" }, { status: 400 });
    }

    const formattedCert = formatX509Certificate(samlCert);
    if (!formattedCert) {
      return NextResponse.json({ error: "Invalid IdP X.509 Certificate format" }, { status: 400 });
    }

    const origin = new URL(request.url).origin;
    const acsUrl = `${origin}/api/auth/saml/acs`;
    const metadataUrl = `${origin}/api/auth/saml/metadata`;

    return NextResponse.json({
      ok: true,
      samlEntryPoint,
      samlIssuer,
      certValid: true,
      acsUrl,
      metadataUrl,
      message: "SAML 2.0 configuration verified successfully.",
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "SAML test failed" }, { status: 500 });
  }
}
