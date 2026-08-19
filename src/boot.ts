/**
 * Import this FIRST, before anything that touches `node:sqlite`.
 *
 * Node emits `ExperimentalWarning: SQLite is an experimental feature` on stderr on some
 * versions (measured: v25.5.0 yes, v22.22.0 no - DECISIONS.md D-003). Agents surface hook
 * stderr as the block reason and Gemini CLI's contract is stdout purity, so an unsolicited
 * warning is a correctness bug.
 *
 * This must be a top-level side effect in its own module rather than a function call in
 * cli.ts, because ES module imports are all evaluated BEFORE the importing module's first
 * statement runs - a `silenceNodeWarnings()` call at the top of cli.ts would execute after
 * `node:sqlite` had already been loaded and had already printed.
 */
process.removeAllListeners('warning');
export const BOOTED = true;
