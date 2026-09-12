// Fixture: dynamic import and require() are the obvious ways to sneak past a
// naive static-import scan, so both are checked.
export async function load() {
  const mod = await import("open-sse/services/provider.js");
  return mod;
}
