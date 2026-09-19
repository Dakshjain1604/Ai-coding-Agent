/**
 * In-container runner for a Harbor trial.
 *
 * Runs the harness (`coding-agent exec`) with the passive HTTP tracer
 * preloaded, and writes to CA_LOG_DIR:
 *   trajectory.jsonl, result.json — written by the harness itself
 *   agent.log  — the harness's stderr progress lines, prefixed with seconds since start
 *   http.jsonl — one record per outbound HTTP call (independent check on the harness's own numbers)
 *   run.json   — process timing, exit code and signal; rewritten on exit or SIGTERM
 *
 * Exit status: the harness's run outcomes (completed, turn/time budget
 * exhausted, model error) are all normal results for the verifier to judge,
 * so they exit 0. Setup failures and crashes keep their non-zero code so the
 * harness surfaces them as infrastructure errors.
 *
 * Usage: node runner.mjs <instruction-file> <timeout-sec> [extra exec flags...]
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_OUTCOME_EXIT_CODES = new Set([0, 1, 3]);

const here = dirname(fileURLToPath(import.meta.url));
const logDir = process.env.CA_LOG_DIR ?? "/logs/agent";
mkdirSync(logDir, { recursive: true });

const [instructionFile, timeoutSec, ...extraExecArgs] = process.argv.slice(2);
const agentLog = join(logDir, "agent.log");
const runFile = join(logDir, "run.json");
const t0 = Date.now();
const run = { started_at: new Date(t0).toISOString(), cwd: process.cwd(), timeout_sec: Number(timeoutSec) };
const saveRun = (extra) => writeFileSync(runFile, JSON.stringify({ ...run, ...extra }, null, 2));
saveRun({ status: "running" });

function pipeLines(stream, name) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop();
    const stamp = ((Date.now() - t0) / 1000).toFixed(2);
    const out = lines.filter((l) => l.trim()).map((l) => `[${stamp}] ${name}: ${l}`);
    if (out.length) appendFileSync(agentLog, out.join("\n") + "\n");
  });
  stream.on("end", () => {
    if (pending.trim()) appendFileSync(agentLog, `[${((Date.now() - t0) / 1000).toFixed(2)}] ${name}: ${pending}\n`);
  });
}

const child = spawn(
  process.execPath,
  [
    "--no-warnings",
    "--import",
    join(here, "http-trace.mjs"),
    join(here, "bin", "run.js"),
    "exec",
    "--instruction-file",
    instructionFile,
    "--logs-dir",
    logDir,
    "--timeout-sec",
    String(timeoutSec),
    ...extraExecArgs,
  ],
  {
    env: { ...process.env, CA_HTTP_TRACE: join(logDir, "http.jsonl") },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
pipeLines(child.stdout, "stdout");
pipeLines(child.stderr, "stderr");

const finalize = (status, extra) =>
  saveRun({ status, finished_at: new Date().toISOString(), duration_s: (Date.now() - t0) / 1000, ...extra });

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    finalize("killed_by_harness", { signal: sig });
    child.kill(sig);
    process.exit(143);
  });
}

child.on("exit", (code, signal) => {
  finalize("exited", { exit_code: code, signal });
  process.exit(code !== null && RUN_OUTCOME_EXIT_CODES.has(code) ? 0 : (code ?? 1));
});
