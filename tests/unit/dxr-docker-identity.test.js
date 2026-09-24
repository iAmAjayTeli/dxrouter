/**
 * A Docker deployment must run DXRouter, not upstream 9Router.
 *
 * `docker-compose.yml` used to say `image: decolua/9router:latest` on port 20128, so
 * `docker compose up` produced a running 9Router and no DXRouter at all — and unlike the
 * updater defect, nothing about it looked broken: the container started, the dashboard
 * answered, and it was the wrong product. The publish workflow had the same shape in
 * reverse, pushing every built image to upstream's Docker Hub namespace alongside GHCR.
 *
 * These are static assertions over the deployment files rather than container runs. Docker
 * is not available in this test environment, and the invariant is a property of the
 * configuration anyway: whether a compose file names someone else's image does not depend
 * on a daemon being present.
 *
 * Scope is the ACTIVE DEPLOYMENT PATH — compose, Dockerfile, the publish workflow,
 * captain-definition and DOCKER.md. `README.md` and `README.zh-CN.md` still carry
 * upstream branding throughout and are a separate pass; that is recorded as a limitation
 * here rather than silently excluded.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Files a `docker compose up` or a CI publish actually consults. */
const DEPLOYMENT_PATH = [
  "docker-compose.yml",
  "Dockerfile",
  ".dockerignore",
  "captain-definition",
  ".github/workflows/docker-publish.yml",
  "DOCKER.md",
];

const UPSTREAM_IMAGE = "decolua/9router";
const UPSTREAM_PORT = "20128";
const DXR_PORT = "20127";

/** Comment lines, which may name what was removed without reinstating it. */
function withoutComments(text, commentToken = "#") {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith(commentToken))
    .join("\n");
}

describe("the active Docker deployment path is DXRouter's", () => {
  it("names upstream's image nowhere outside a comment", () => {
    const offenders = [];
    for (const rel of DEPLOYMENT_PATH) {
      // DOCKER.md is prose: the only mentions permitted there are the instruction not to
      // pull upstream's image and the note that Docker Hub is not a target.
      if (rel === "DOCKER.md") continue;
      const token = rel === "Dockerfile" || rel.endsWith(".dockerignore") ? "#" : "#";
      const code = withoutComments(read(rel), token);
      if (code.includes(UPSTREAM_IMAGE)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("uses DXRouter's port and not upstream's, outside comments", () => {
    const offenders = [];
    for (const rel of ["docker-compose.yml", "Dockerfile", "captain-definition"]) {
      const code = withoutComments(read(rel));
      if (code.includes(UPSTREAM_PORT)) offenders.push(`${rel} still mentions ${UPSTREAM_PORT}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps DOCKER.md's upstream mentions to the warnings that need them", () => {
    const doc = read("DOCKER.md");

    // Present as instructions NOT to use upstream, which is the opposite of the old file's
    // `docker run decolua/9router:latest` quick start.
    expect(doc).toMatch(/Do not pull `decolua\/9router`/);
    expect(doc).toMatch(/Docker Hub is deliberately not a target/);
    // And no runnable command pulls or runs it.
    expect(doc).not.toMatch(/docker (run|pull)[^\n]*decolua\/9router/);
    expect(doc).not.toMatch(/image:\s*decolua\/9router/);
  });
});

describe("compose is internally consistent", () => {
  const compose = yaml.load(read("docker-compose.yml"));

  it("parses as YAML and declares the expected services", () => {
    expect(compose).toBeTruthy();
    expect(Object.keys(compose.services).sort()).toEqual(["dxrouter", "headroom"]);
  });

  it("builds this checkout rather than pulling a product image", () => {
    const svc = compose.services.dxrouter;

    // No DXRouter image has been published — the workflow fires only on a `v*` tag push
    // and this repository has no remote tags — so a pull would fail. Building is also what
    // captain-definition already does.
    expect(svc.build).toBe(".");
    expect(String(svc.image)).not.toContain("9router");
    expect(String(svc.image)).toBe("dxrouter:local");
  });

  it("identifies the container as DXRouter", () => {
    expect(compose.services.dxrouter.container_name).toBe("dxrouter");
  });

  it("maps the port it tells the app to listen on", () => {
    const svc = compose.services.dxrouter;

    // The published mapping, the PORT the process binds and the Dockerfile's EXPOSE must
    // agree, or the container answers on a port nothing forwards to.
    expect(svc.ports).toEqual([`${DXR_PORT}:${DXR_PORT}`]);
    expect(String(svc.environment.PORT)).toBe(DXR_PORT);
    expect(read("Dockerfile")).toMatch(new RegExp(`^EXPOSE ${DXR_PORT}$`, "m"));
    expect(read("Dockerfile")).toMatch(new RegExp(`^ENV PORT=${DXR_PORT}$`, "m"));
  });

  it("sets the canonical data-root variable, not the deprecated one", () => {
    const env = compose.services.dxrouter.environment;

    // `src/lib/dataDir.js` honours DATA_DIR but warns; DXR_DATA_DIR is the documented
    // precedence winner.
    expect(env.DXR_DATA_DIR).toBe("/app/data");
    expect(env.DATA_DIR).toBeUndefined();
    expect(read("Dockerfile")).toMatch(/^ENV DXR_DATA_DIR=\/app\/data$/m);
    expect(withoutComments(read("Dockerfile"))).not.toMatch(/^ENV DATA_DIR=/m);
  });

  it("keeps the non-loopback bind opt-in and the credential key required", () => {
    const env = compose.services.dxrouter.environment;

    // Unchanged by the identity work, asserted so an identity edit cannot quietly drop
    // them: without the first the server refuses to bind 0.0.0.0, and without the second
    // it refuses to start at all rather than storing credentials unencrypted.
    expect(String(env.DXR_ALLOW_NETWORK)).toBe("1");
    expect(env.DXR_MASTER_KEY).toBe("${DXR_MASTER_KEY}");
    expect(String(env.HOSTNAME)).toBe("0.0.0.0");
  });

  it("preserves the existing data volume name", () => {
    const svc = compose.services.dxrouter;

    // Deliberately still `9router-data`: renaming a named volume orphans the database and
    // credentials of every deployment that already has one, which is the same reason
    // dataDir.js keeps the directory name. Storage identity is not product identity.
    expect(svc.volumes).toEqual(["9router-data:/app/data"]);
    expect(compose.volumes["9router-data"].name).toBe("9router-data");
  });

  it("leaves the unrelated Headroom sidecar alone", () => {
    // Third-party image, not DXRouter identity. Pinned so an identity sweep does not
    // rewrite it.
    expect(compose.services.headroom.image).toBe("ghcr.io/chopratejas/headroom:latest");
    expect(compose.services.dxrouter.environment.HEADROOM_URL).toBe("http://headroom:8787");
    expect(compose.services.dxrouter.depends_on).toEqual(["headroom"]);
  });
});

describe("the publish workflow matches the documented image", () => {
  const wf = yaml.load(read(".github/workflows/docker-publish.yml"));

  it("derives the image from the repository, so it cannot drift", () => {
    expect(wf.env.GHCR_IMAGE).toBe("ghcr.io/${{ github.repository }}");
  });

  it("publishes to GHCR only, with no upstream Docker Hub target", () => {
    expect(wf.env.DOCKERHUB_IMAGE).toBeUndefined();

    const steps = wf.jobs["build-and-push"].steps;
    const meta = steps.find((s) => s.id === "meta");
    const images = String(meta.with.images).trim().split("\n").map((s) => s.trim()).filter(Boolean);

    expect(images).toEqual(["${{ env.GHCR_IMAGE }}"]);
    // And the login step that authenticated to it is gone with it.
    const registries = steps.filter((s) => s.uses?.startsWith("docker/login-action")).map((s) => s.with?.registry);
    expect(registries).toEqual(["ghcr.io"]);
  });

  it("keeps the repository's existing tag strategy rather than a new one", () => {
    const meta = wf.jobs["build-and-push"].steps.find((s) => s.id === "meta");
    const tags = String(meta.with.tags).trim().split("\n").map((s) => s.trim()).filter(Boolean);

    // Not switched to a bare `:latest`: semver from the tag, plus a moving `latest`
    // confined to the default branch. `{{version}}` means `v0.5.60` publishes `0.5.60`.
    expect(tags).toEqual([
      "type=semver,pattern={{version}}",
      "type=raw,value=latest,enable={{is_default_branch}}",
    ]);
  });

  it("still only fires on a version tag, which is why nothing is published yet", () => {
    // `on:` parses as the boolean true in YAML 1.1, so read it by either key.
    const on = wf.on ?? wf[true];
    expect(on.push.tags).toEqual(["v*"]);
    expect(on).toHaveProperty("workflow_dispatch");
  });

  it("documents exactly the image the workflow builds", () => {
    const doc = read("DOCKER.md");

    // github.repository is iAmAjayTeli/dxrouter; GHCR lowercases it.
    expect(doc).toContain("ghcr.io/iamajayteli/dxrouter");
    expect(doc).not.toContain("ghcr.io/decolua");
    // The old doc promised `:v{version}`, which the metadata action never produces.
    expect(doc).not.toMatch(/ghcr\.io\/[^\s:]+:v\{version\}/);
    expect(doc).toMatch(/no\*{0,2} `v` prefix/i);
  });
});

describe("the build context stays valid", () => {
  it("captain-definition points at the Dockerfile that exists", () => {
    const captain = JSON.parse(read("captain-definition"));
    expect(captain.dockerfilePath).toBe("./Dockerfile");
    expect(fs.existsSync(path.join(REPO_ROOT, "Dockerfile"))).toBe(true);
  });

  it("keeps ignoring what must not enter the image", () => {
    const ignored = read(".dockerignore").split("\n").map((l) => l.trim());
    for (const entry of ["node_modules", ".next", "data", "logs", ".env"]) {
      expect(ignored, entry).toContain(entry);
    }
  });

  it("still copies the runtime files Next tracing omits", () => {
    const dockerfile = read("Dockerfile");

    // Unrelated to identity, asserted because an edit to the ENV block sits directly above
    // them and a careless rewrite would take them out.
    for (const dep of ["node-forge", "next", "sql.js"]) {
      expect(dockerfile, dep).toContain(`/app/node_modules/${dep} ./node_modules/${dep}`);
    }
    expect(dockerfile).toContain("custom-server.js");
    expect(dockerfile).toContain("/app/src/mitm ./src/mitm");
  });

  it("keeps the data-home symlink pointing at the inherited directory name", () => {
    // `/root/.9router` is the platform default the app falls back to, so the symlink must
    // keep that name even though the product is DXRouter.
    expect(read("Dockerfile")).toContain("/root/.9router");
  });
});
