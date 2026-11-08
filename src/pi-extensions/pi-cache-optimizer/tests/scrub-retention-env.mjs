// Test isolation: the suite must not inherit an ambient PI_CACHE_RETENTION.
//
// When the suite runs from inside a Pi session that has this extension loaded, Pi's
// environment carries PI_CACHE_RETENTION=long (the extension sets it at startup), and
// src/retention.ts snapshots that value at import time as "the user asked for long
// retention". The prompt_cache_retention gate then correctly keeps the field, and the
// gate tests that expect it stripped fail for an environmental reason.
//
// --import runs this before the test files, so the snapshot sees a clean environment.
delete process.env.PI_CACHE_RETENTION;
