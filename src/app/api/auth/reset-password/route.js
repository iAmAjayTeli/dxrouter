import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { updateSettings } from "@/lib/localDb";
import { generateCredential } from "@/lib/security/bootstrapCredential";
import { validateNewPassword } from "@/lib/security/passwordPolicy";

/**
 * Read an optional JSON body.
 *
 * Absent, empty and malformed bodies all mean the same thing here — "the caller
 * did not name a password" — so they collapse to null rather than erroring. The
 * legacy CLI sends no body at all.
 */
async function readOptionalJson(request) {
  if (!request || typeof request.json !== "function") return null;
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

// Reset the dashboard password.
//
// M0 change: upstream cleared the stored hash here, which re-armed the public
// default password ("123456"). There is no default password any more, so a reset
// must either set one the operator supplied or mint a fresh random credential —
// it never clears.
//
// Two modes, both local-only + CLI-token gated (see LOCAL_ONLY_PATHS in
// dashboardGuard), which is what makes handling plaintext here acceptable:
//
//   * `{"newPassword": "..."}` — the operator names the password. It is hashed
//     and then dropped: the response reports success and contains no credential,
//     so the password cannot end up in a terminal scrollback, a shell history or
//     a proxy log. The caller already knows it.
//   * no body — the original behaviour, kept for every existing caller: generate
//     a random credential and return it exactly once.
export async function POST(request) {
  try {
    const body = await readOptionalJson(request);

    if (body && Object.prototype.hasOwnProperty.call(body, "newPassword")) {
      const invalid = validateNewPassword(body.newPassword);
      if (invalid) {
        return NextResponse.json({ error: invalid }, { status: 400 });
      }

      await updateSettings({ password: await bcrypt.hash(body.newPassword, 10) });

      return NextResponse.json(
        { success: true, credential: null, shownOnce: false, userProvided: true },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const credential = generateCredential();
    await updateSettings({ password: await bcrypt.hash(credential, 10) });

    return NextResponse.json(
      { success: true, credential, shownOnce: true, userProvided: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
