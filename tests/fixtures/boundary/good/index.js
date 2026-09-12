// Fixture: a compliant engine module. Relative imports stay inside the tree and
// node: builtins are allowed, so the boundary checker must report zero violations.
import crypto from "node:crypto";
import { helper } from "./nested/helper.js";

export function hash(value) {
  return crypto.createHash("sha256").update(helper(value)).digest("hex");
}
