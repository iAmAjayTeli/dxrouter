/** Fatal security-bootstrap failure: the process must refuse to serve. */
export class SecurityBootstrapError extends Error {
  constructor(message, { code = "SECURITY_BOOTSTRAP_FAILED", remedy = null } = {}) {
    super(message);
    this.name = "SecurityBootstrapError";
    this.code = code;
    this.remedy = remedy;
  }
}
