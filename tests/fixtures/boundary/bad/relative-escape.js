// Fixture: a relative path that climbs out of the boundary. Resolves outside the
// scanned root, so the checker must reject it even though it is not a bare
// specifier.
import { DATA_DIR } from "../../../../src/lib/dataDir.js";

export const root = DATA_DIR;
