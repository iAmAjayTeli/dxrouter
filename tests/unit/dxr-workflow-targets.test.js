/**
 * Workflows in this repository must not publish into another project's namespace.
 *
 * gitbook-pages.yml came from upstream unchanged: it builds the docs and pushes them
 * to 9router/9router.github.io with a deploy key only upstream holds. docker-publish.yml
 * had the same shape (a second push to upstream's Docker Hub repo) and was cut back to
 * GHCR-for-this-repository; dxr-docker-identity.test.js pins that one. This pins the docs
 * deploy: it may only run in upstream's own repository.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wf = yaml.load(fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/gitbook-pages.yml"), "utf8"));

describe("the GitBook deploy stays upstream's", () => {
  const job = wf.jobs["build-deploy"];
  const deploy = job.steps.find((s) => s.uses?.startsWith("peaceiris/actions-gh-pages"));

  it("still targets upstream's pages repository (so the gate below is what matters)", () => {
    expect(deploy.with.external_repository).toBe("9router/9router.github.io");
  });

  it("runs only in upstream's repository, never in this fork", () => {
    expect(job.if).toBe("github.repository == 'decolua/9router'");
  });
});
