/**
 * A no-op stand-in for the `server-only` marker package.
 *
 * The real package throws on import outside a React Server Component bundle, which is exactly
 * its job — it stops server code being pulled into the browser. The tests exercise those same
 * modules directly under tsx, where that guard has nothing to protect and only gets in the way.
 *
 * Mapped in for tests alone, via tsconfig.test.json. The application build keeps the real
 * package and the real guard.
 */
export {};
