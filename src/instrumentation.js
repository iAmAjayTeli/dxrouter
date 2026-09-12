export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Security bootstrap runs before anything else that could serve a request or
    // touch a credential: it resolves the data root, establishes the credential
    // encryption key, generates the first-run dashboard credential, and refuses
    // to continue if the process would be exposed to the network unsafely.
    const { runSecurityBootstrap } = await import("@/lib/security/bootstrap");
    await runSecurityBootstrap();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }
}
