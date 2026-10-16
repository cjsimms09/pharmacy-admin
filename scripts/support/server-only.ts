/*
 * Stands in for the `server-only` marker when a module is run by a script rather than by Next.
 *
 * The marker exists to stop server code being pulled into a browser bundle, and it does that by
 * throwing the moment anything but a server component imports it. A script run from the command
 * line is not a browser, but it is not a server component either, so the marker throws there too.
 * The path mapping in tsconfig.script.json points at this file instead, which keeps the guard
 * exactly where it belongs — the Next build — while letting the scripts run.
 */
export {};
