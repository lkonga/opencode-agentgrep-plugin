// agentgrep-compact — pure result-level output compaction for grep mode.
// AgentGrep v0.1.6 grep does not accept `--max-regions` (only trace does), so
// we apply a safe post-execution cap on the number of region (match) lines in
// the stdout. The public `max_regions` parameter controls the cap; omitted
// means 200. Non-grep output is never touched. No unsafe buffering or spawn
// changes are introduced — the stdout is already fully captured by the bounded
// exec layer, and this module just trims the result to the requested region
// budget.
//
// ⚠️ NOT a plugin entrypoint. Only index.ts may be loaded by OpenCode.

/** Default grep max_regions when the caller omits the parameter. */
export const GREP_DEFAULT_MAX_REGIONS = 200

/**
 * Regex matching an agentgrep grep match line: `path:line:` prefix. The same
 * pattern is used by the harness context builder (`PATH_LINE_RE` in
 * `agentgrep-context-build.ts`).
 */
const MATCH_LINE_RE = /^([^:\n]+):(\d+):/

/**
 * Compact grep output to at most `maxRegions` match lines. Non-match lines
 * (headers, summary, blank lines) before the cap are kept. When the cap binds,
 * a truncation note is appended and the output is truncated at the last
 * included match line.
 *
 * @returns `regions` — total match lines counted in the original (untrimmed)
 * output; `capped` — true when the output was actually truncated.
 */
export function compactGrepRegions(
  text: string,
  maxRegions: number,
): { text: string; regions: number; capped: boolean } {
  if (maxRegions <= 0) return { text, regions: 0, capped: false }
  if (text === "") return { text, regions: 0, capped: false }

  const lines = text.split("\n")
  // First pass: count ALL match lines in the original output (truthful total).
  let regions = 0
  for (const line of lines) {
    if (MATCH_LINE_RE.test(line)) regions++
  }
  if (regions <= maxRegions) return { text, regions, capped: false }

  // Second pass: find the char offset AFTER the last line we keep (the
  // maxRegions-th match line); non-match lines before it are preserved.
  let kept = 0
  let lastIncludedEnd = 0 // char offset after the last included line's \n
  for (const line of lines) {
    if (MATCH_LINE_RE.test(line)) {
      kept++
      if (kept > maxRegions) break
    }
    lastIncludedEnd += line.length + 1 // the \n separator
  }

  // Trim trailing \n
  const truncated = lastIncludedEnd > 0 ? text.slice(0, Math.max(0, lastIncludedEnd - 1)) : text
  return {
    text: `${truncated}\n[... agentgrep: results truncated to ${maxRegions} regions (max_regions=${maxRegions})]`,
    regions,
    capped: true,
  }
}