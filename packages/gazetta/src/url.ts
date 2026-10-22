/**
 * Small shared URL/string helpers.
 */

/**
 * Strip trailing '/' characters in linear time.
 *
 * Replaces the `/\/+$/` regex, which backtracks quadratically on a long
 * run of slashes that is NOT at the end (CodeQL js/polynomial-redos,
 * #1067). A plain loop walks back from the end once.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end -= 1
  return end === value.length ? value : value.slice(0, end)
}
