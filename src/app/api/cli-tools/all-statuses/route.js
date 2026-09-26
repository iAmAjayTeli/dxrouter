"use server";

import { NextResponse } from "next/server";
import { canAccessLocalOnlyRoute, isLocalOnlyPath } from "@/dashboardGuard";
import { GET as claudeGet } from "../claude-settings/route";
import { GET as codexGet } from "../codex-settings/route";
import { GET as opencodeGet } from "../opencode-settings/route";
import { GET as droidGet } from "../droid-settings/route";
import { GET as openclawGet } from "../openclaw-settings/route";
import { GET as hermesGet } from "../hermes-settings/route";
import { GET as coworkGet } from "../cowork-settings/route";
import { GET as copilotGet } from "../copilot-settings/route";
import { GET as clineGet } from "../cline-settings/route";
import { GET as kiloGet } from "../kilo-settings/route";
import { GET as deepseekTuiGet } from "../deepseek-tui-settings/route";
import { GET as jcodeGet } from "../jcode-settings/route";
import { GET as grokBuildGet } from "../grok-build-settings/route";
import { GET as devinGet } from "../devin-settings/route";

const STATUS_GETTERS = {
  claude: claudeGet,
  codex: codexGet,
  opencode: opencodeGet,
  droid: droidGet,
  openclaw: openclawGet,
  hermes: hermesGet,
  cowork: coworkGet,
  copilot: copilotGet,
  cline: clineGet,
  kilo: kiloGet,
  "deepseek-tui": deepseekTuiGet,
  jcode: jcodeGet,
  "grok-build": grokBuildGet,
  devin: devinGet,
};

// Batch endpoint: gather all CLI tool statuses in one round-trip.
//
// This handler calls each tool's GET directly, so the per-route gate in dashboardGuard
// never runs for them. cowork-settings is LOCAL_ONLY there, and for cause: the config it
// returns carries the x-9r-cli-token it injects into its MCP bridge entries, and that
// token is host-local authority from any peer. So a tool whose own route is LOCAL_ONLY is
// only aggregated for a caller that route would admit; others get null, which the page
// already renders as "status unavailable".
export async function GET(request) {
  const localAllowed = await canAccessLocalOnlyRoute(request);
  const entries = await Promise.all(
    Object.entries(STATUS_GETTERS).map(async ([toolId, getter]) => {
      if (!localAllowed && isLocalOnlyPath(`/api/cli-tools/${toolId}-settings`)) return [toolId, null];
      try {
        const res = await getter();
        const data = await res.json();
        return [toolId, data];
      } catch {
        return [toolId, null];
      }
    })
  );
  return NextResponse.json(Object.fromEntries(entries));
}
