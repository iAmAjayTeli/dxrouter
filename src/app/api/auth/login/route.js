import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { isLocalRequest } from "@/dashboardGuard";
import { consumeInitialCredentialFile } from "@/lib/security/bootstrapCredential";

const RESET_HINT = "Forgot password? Generate a new one via the CLI → Settings → Reset Password (prints a fresh random credential).";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`, retryAfter: lock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    const { password } = await request.json();
    const settings = await getSettings();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    // M0: no default password. The first-run bootstrap writes a bcrypt hash of a
    // randomly generated credential, so `settings.password` is the only accepted
    // credential. An explicit INITIAL_PASSWORD is honoured as an operator-chosen
    // seed for the window before that hash exists.
    const storedHash = settings.password;

    if (settings.authMode === "sso" || settings.authMode === "saml" || settings.authMode === "oidc") {
      const ssoType = settings.ssoType || (settings.authMode === "saml" ? "saml" : "oidc");
      if (ssoType === "saml" && isSamlConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use SAML SSO sign in." }, { status: 403 });
      }
      if (ssoType === "oidc" && isOidcConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
      }
    }

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else if (process.env.INITIAL_PASSWORD) {
      isValid = password === process.env.INITIAL_PASSWORD;
    } else {
      // No stored hash and no INITIAL_PASSWORD: the security bootstrap has not
      // completed, so there is no credential to match. Never fall back to a
      // well-known value.
      return NextResponse.json(
        {
          error:
            "No dashboard credential is set up yet. Restart the server — the first run prints a generated credential (also written to initial-credential.txt in the data directory).",
        },
        { status: 503, headers: NO_STORE_HEADERS }
      );
    }

    if (isValid) {
      recordSuccess(ip);

      // Retained belt-and-braces guard. With no default password this branch is
      // now unreachable (a missing hash without INITIAL_PASSWORD returns 503
      // above), but it stays as a second line of defence: no session token may
      // ever be issued to a remote peer on the strength of a non-stored password.
      const mustChangePassword =
        !storedHash && !process.env.INITIAL_PASSWORD && !isLocalRequest(request);

      if (mustChangePassword) {
        // Do NOT issue a session token on the strength of a credential that is
        // not stored as a hash: handing out a valid JWT would let a remote caller
        // PATCH /api/settings and disable authentication entirely
        // (CVE-2026-56679 class). Require a stored credential first.
        //
        // NOTE: this intentionally leaves no remote self-service password-change
        // path — the change-password flow (PATCH /api/settings) requires a JWT,
        // which we deliberately withhold. A remote fresh-install user must either
        // change the password from the local machine or set INITIAL_PASSWORD
        // before first launch. This is a deliberate security trade-off, not an
        // oversight: issuing any credential before the default password is
        // rotated re-opens the exact attack chain this branch closes.
        return NextResponse.json(
          { success: false, error: "A dashboard credential must be set before remote access. Sign in from the local machine (or set INITIAL_PASSWORD).", mustChangePassword },
          { status: 403, headers: NO_STORE_HEADERS }
        );
      }

      // The one-time credential file has served its purpose.
      consumeInitialCredentialFile();

      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);

      return NextResponse.json({ success: true, mustChangePassword: false }, { headers: NO_STORE_HEADERS });
    }

    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    if (postLock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s. ${RESET_HINT}`, retryAfter: postLock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(postLock.retryAfter) } }
      );
    }
    return NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
      { status: 401 }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
