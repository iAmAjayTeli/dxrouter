/**
 * `evidenceReports` — where a measurement run's markdown report lands on this host.
 *
 * §19.4 requires every run to leave a human-readable report on disk beside the
 * `experiments` row that records it. The row is the machine's memory; the report is what
 * a person reads before typing a verdict, and a verdict typed without reading something
 * is exactly the rubber stamp the gate exists to prevent.
 *
 * The path is here and not in `continuity/` for the same reason the pricing override
 * directory is: a data root is host knowledge (I1). The engine composes the filename and
 * the markdown, and is handed a `writeReport` callback that turns them into a file.
 *
 * Unlike the pricing override directory, this one **is** created — the engine is about to
 * write into it, and a run that produced a report it could not save would have to be
 * reported as an incomplete run.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../src/lib/dataDir.js";

/** `<data root>/evidence/` — kept in step with `src/lib/dataDir.js`, one root. */
export const EVIDENCE_DIR = path.join(DATA_DIR, "evidence");

/**
 * A `writeReport` implementation for `runMeasure`.
 *
 * Returns the absolute path, which `runMeasure` stores in `experiments.report_path`, so
 * `dxrouter measure --status` can point at the document rather than describe it.
 *
 * @param {object} [args]
 * @param {string} [args.dir] override, for tests that must not touch the real root
 * @returns {(filename: string, markdown: string) => string}
 */
export function createReportWriter({ dir = EVIDENCE_DIR } = {}) {
  return (filename, markdown) => {
    if (!filename || typeof markdown !== "string") {
      throw new Error("[DXR][evidence] a report needs a filename and markdown");
    }
    // `path.basename` on purpose: the filename is composed from a question id, a measure
    // name and a date, but it reaches here as a string, and a string that reaches the
    // filesystem gets confined to the directory it was meant for.
    const file = path.join(dir, path.basename(filename));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, markdown, { encoding: "utf8", mode: 0o600 });
    return file;
  };
}

export default createReportWriter;
