import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { fetchOidcDiscovery, getPublicOrigin, probeOidcClientSecret } from "@/lib/auth/oidc";
import { isAuthenticated } from "@/dashboardGuard";

// /api/auth/oidc/* is public in the guard (start and callback must be), so this route
// authenticates itself — with the guard's rules, not a looser copy of them. The copy
// honoured requireLogin=false from ANY peer and skipped the cross-site check, and this
// route sends the stored client secret to the token_endpoint named by whatever issuer
// the caller supplies: with login disabled, a remote caller could collect the secret.
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

    const issuerUrl = String(body.issuerUrl || settings.oidcIssuerUrl || "").trim();
    const clientId = String(body.clientId || settings.oidcClientId || "").trim();
    const scopes = String(body.scopes || settings.oidcScopes || "openid profile email").trim() || "openid profile email";
    const clientSecret = String(
      Object.prototype.hasOwnProperty.call(body, "clientSecret")
        ? body.clientSecret
        : settings.oidcClientSecret || ""
    ).trim();

    if (!issuerUrl) {
      return NextResponse.json({ error: "Issuer URL is required" }, { status: 400 });
    }
    if (!clientId) {
      return NextResponse.json({ error: "Client ID is required" }, { status: 400 });
    }

    const discovery = await fetchOidcDiscovery(issuerUrl);
    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;
    const secretProbe = await probeOidcClientSecret({
      tokenEndpoint: discovery.token_endpoint,
      clientId,
      clientSecret,
      redirectUri,
    });

    if (secretProbe.tested && secretProbe.valid === false) {
      return NextResponse.json({
        ok: false,
        discoveryOk: true,
        clientSecretTested: true,
        clientSecretValid: false,
        issuerUrl,
        clientId,
        scopes,
        redirectUri,
        authorizationEndpoint: discovery.authorization_endpoint || "",
        tokenEndpoint: discovery.token_endpoint || "",
        jwksUri: discovery.jwks_uri || "",
        error: `Discovery loaded, but the client secret is not valid: ${secretProbe.message}`,
      });
    }

    return NextResponse.json({
      ok: true,
      discoveryOk: true,
      clientSecretTested: secretProbe.tested,
      clientSecretValid: secretProbe.valid,
      issuerUrl,
      clientId,
      scopes,
      redirectUri,
      authorizationEndpoint: discovery.authorization_endpoint || "",
      tokenEndpoint: discovery.token_endpoint || "",
      jwksUri: discovery.jwks_uri || "",
      message: secretProbe.message,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "OIDC test failed" }, { status: 500 });
  }
}
