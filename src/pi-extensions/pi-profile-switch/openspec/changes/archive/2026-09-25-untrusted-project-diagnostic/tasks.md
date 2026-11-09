# Tasks

## 1. Diagnostic implementation

- [x] 1.1 Emit the untrusted-project diagnostic after the launcher's trust determination: when the determination is untrusted and the project contains trust-requiring content (pi-profile project files or Pi project resources), print one diagnostic to stderr stating the project is untrusted, the invisible content, and how to authorize (`/trust` persistent, `-- --approve` one-shot); do not print when trusted or when no trust-requiring content exists. Verification: unit tests cover the four scenarios of the specs delta (fires, message content, no output when trusted, no output for an empty project with `--no-approve`); `npm run check` and `npm test` pass
