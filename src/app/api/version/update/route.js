import { NextResponse } from "next/server";
import { describeInstallation } from "@/lib/dxrInstallation";

/**
 * Self-update endpoint.
 *
 * It refuses, and that is the implemented behaviour rather than a placeholder. To install
 * anything safely this route would need a DXRouter release channel and a way to prove the
 * target belongs to DXRouter; neither exists yet, so there is no install it could perform
 * correctly. It previously performed one anyway: it killed every process whose command
 * line contained `9router`, `next-server` or `cli.js`, then handed a detached process
 * `npm i -g <upstream package> --prefer-online` followed by a relaunch of the upstream CLI.
 * On this machine that overwrote the operator's global 9Router 0.5.75 install and left
 * DXRouter exactly as it was.
 *
 * The refusal is 409: the request is well-formed and understood, but this installation's
 * state makes it impossible to satisfy. It is expressed as one path on purpose — the check
 * runs before any side effect, and there is no branch beneath it that reaches one, so
 * "refused" and "nothing killed, spawned or installed" cannot drift apart.
 */

export async function POST() {
  const install = describeInstallation();

  return NextResponse.json(
    {
      success: false,
      refused: true,
      mode: install.mode,
      message: install.message,
    },
    { status: 409 }
  );
}
