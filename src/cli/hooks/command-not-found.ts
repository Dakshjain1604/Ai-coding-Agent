/**
 * oclif `command_not_found` lifecycle hook.
 *
 * This project's package.json uses the standard multi-command directory
 * scan (`oclif.commands: "./dist/cli/commands"`), which makes
 * `isSingleCommandCLI` false. `src/cli/index.ts` used to define a
 * `CodingAgentCLI` class with an `-i`/`--interactive` flag and a
 * fallback-to-interactive-mode `run()` — written as if this were a
 * single-command CLI — but that class was never actually wired into
 * oclif's real command resolution anywhere (not from bin/run.js, not
 * from package.json's "main", not from the oclif config). It was
 * unreachable dead code. Confirmed live: bare `coding-agent` printed
 * oclif's generic help instead of starting interactive mode, and
 * `coding-agent -i` hard-failed with "command -i not found" — the two
 * ways CLAUDE.md documents starting interactive mode were both broken.
 *
 * This hook is oclif's real, supported extension point for "no matching
 * command was found" (registered via oclif.hooks in package.json). It
 * only intercepts the specific bare-invocation and -i/--interactive
 * cases; anything else re-throws so genuine typos still get a normal
 * "command not found" error instead of being silently swallowed (a
 * command_not_found hook that resolves without throwing counts as
 * "handled" to oclif's runCommand(), regardless of what it returns —
 * so every non-matching path here MUST throw, not just return).
 */
import type { Hook } from "@oclif/core";
import { startInteractiveMode } from "../modes/interactive.js";

const commandNotFound: Hook<"command_not_found"> = async function (opts) {
  const id = opts.id;

  if (!id || id === "-i" || id === "--interactive") {
    await startInteractiveMode();
    return;
  }

  throw new Error(`command ${id} not found`);
};

export default commandNotFound;
