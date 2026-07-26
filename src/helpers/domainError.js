class DomainError extends Error {
  constructor(status, code, message, context = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, context);
  }
}

module.exports = DomainError;
