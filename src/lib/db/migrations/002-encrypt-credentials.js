/**
 * Encrypt provider credentials that were written before M0.
 *
 * Runs inside the upstream migration runner, so it inherits a transaction and
 * the pre-schema backup taken by `runMigrationOnce` when `backupSchemaVersion`
 * lags `SCHEMA_VERSION`.
 *
 * Forward-only and idempotent: `encryptConnectionSecrets` skips values that are
 * already enveloped, and rows with nothing secret are left untouched (so no
 * pointless writes and no key requirement on a fresh install).
 */

import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { encryptConnectionSecrets, hasPlaintextSecret } from "../helpers/credentialCrypto.js";

export default {
  version: 2,
  name: "encrypt-credentials",
  up(db) {
    let rows;
    try {
      rows = db.all(`SELECT id, data FROM providerConnections`);
    } catch {
      // Table absent (fresh DB where 001 created it moments ago always has it,
      // but be defensive rather than aborting the chain).
      return;
    }
    if (!rows || rows.length === 0) return;

    let encrypted = 0;
    for (const row of rows) {
      const extra = parseJson(row.data, {});
      if (!hasPlaintextSecret(extra)) continue;
      db.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [
        stringifyJson(encryptConnectionSecrets(extra)),
        row.id,
      ]);
      encrypted++;
    }

    if (encrypted > 0) {
      console.log(`[DB][migrate] encrypted credentials for ${encrypted} provider connection(s)`);
    }
  },
};
