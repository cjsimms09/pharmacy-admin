/**
 * A visit to an old page is counted by its route, not its row: an id or a long number in the path is one page, not a
 * thousand, and a query string is not part of the page. Pure, so the route handler and the test share it.
 */
const ID = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;
const NUMBER = /\/\d{3,}(?=\/|$)/g;

export function routeOf(path: string): string {
  return path.split("?")[0].replace(ID, "/[id]").replace(NUMBER, "/[n]").replace(/\/+$/, "") || "/";
}

/** Paths that are never counted: the new screens (not up for retirement), the API, anything odd. */
export function countable(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("/v2") && !path.startsWith("/api") && path.length <= 200;
}
