/**
 * Global uncaught-exception / unhandled-rejection formatting for the CLI.
 *
 * This used to live only inside `src/cli/index.ts`'s `CodingAgentCLI`
 * class as module-level `process.on(...)` calls — but that whole file
 * was never actually imported by the real CLI entry point (bin/run.js
 * calls @oclif/core's `execute()` directly, which discovers commands via
 * package.json's oclif.commands directory scan; it never imports
 * src/cli/index.ts). So these handlers were never installed in the real
 * running process: any uncaught exception or unhandled rejection fell
 * through to Node's own default handling (a raw stack trace) instead of
 * this polished formatting. Moved here and wired into bin/run.js, the
 * actual entry point, so it really runs.
 */
import chalk from "chalk";

export function formatFatalError(err: Error): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.red("  ┌─ ") + chalk.bold.red("System Error"));
  lines.push(chalk.gray("  │  ") + chalk.white(err.message));
  if (
    err.message.includes("fetch failed") ||
    err.message.includes("ECONNREFUSED")
  ) {
    lines.push(
      chalk.gray("  │  ") +
        chalk.yellow(
          "Recommendation: Ensure your AI provider (e.g., Ollama) is running and accessible.",
        ),
    );
  }
  lines.push(chalk.red("  └──────────────────────────────────\n"));
  return lines.join("\n");
}

export function installGlobalErrorHandlers(): void {
  const printFatalError = (err: Error) => {
    console.log(formatFatalError(err));
    process.exit(1);
  };

  process.on("uncaughtException", printFatalError);
  process.on("unhandledRejection", (reason: unknown) => {
    printFatalError(reason instanceof Error ? reason : new Error(String(reason)));
  });
}
