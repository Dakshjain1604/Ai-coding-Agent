/**
 * Shell tool: run commands in a session whose working directory and
 * exported environment persist across calls.
 *
 * Each command runs in its own shell process (so a hung command can be
 * killed without losing the session), and the session state — cwd and
 * exported variables — is saved on exit and restored on the next call.
 * Output goes to a file, not a pipe:
 *   - stdout and stderr are merged in order, and ALWAYS reach the model
 *     together with the exit code (a failing command's stdout is often
 *     where its error message is);
 *   - background jobs (`server &`) keep writing to that file instead of
 *     holding a pipe open or dying of SIGPIPE when the call returns;
 *   - huge outputs are never loaded into memory — only head and tail are read.
 * stdin is closed, so a command waiting for input fails fast instead of
 * hanging until the timeout.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Observation, Tool, ToolContext } from "./tool.js";

const DEFAULT_TIMEOUT_SEC = 180;
const MAX_TIMEOUT_SEC = 3600;
const HEAD_BYTES = 8_000;
const TAIL_BYTES = 20_000;
const KILL_GRACE_MS = 2_000;

/**
 * Filters `export -p` output down to variables that can be restored.
 * Environments can contain names that are not valid shell identifiers
 * (npm sets `npm_package_bin_<name-with-dashes>`); re-declaring those makes
 * the shell print an error into every later command's output. Values may
 * span lines, so the keep/skip decision is made at each record's first
 * line and applied to its continuation lines. Per-process variables
 * (PWD, OLDPWD, SHLVL, _) are never restored.
 */
const EXPORT_FILTER_AWK =
  "/^(declare -x|export) /{ keep = ($0 ~ /^(declare -x|export) [A-Za-z_][A-Za-z0-9_]*(=|$)/) && ($0 !~ /^(declare -x|export) (PWD|OLDPWD|SHLVL|_)(=|$)/) } keep";

export interface BashToolOptions {
  initialCwd: string;
  scratchDir: string;
  /** Env var names removed from the command environment (e.g. the harness's own API key). */
  hiddenEnv?: string[];
}

export class BashTool implements Tool {
  readonly spec = {
    name: "bash",
    description:
      "Run a shell command. The working directory and exported environment variables persist between calls; " +
      "each call runs in a fresh process, so shell functions and aliases do not. stdin is closed (non-interactive): " +
      "pass flags like -y, and never start editors, pagers or interactive prompts. stdout and stderr are returned merged, " +
      "with the exit code. Commands that exceed the timeout are killed. For servers or anything long-running, start it in " +
      "the background with output redirected (e.g. `nohup cmd > /tmp/cmd.log 2>&1 &`) and poll the log.",
    parameters: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, description: "The shell command(s) to run." },
        timeout_sec: {
          type: "integer" as const,
          description: `Seconds before the command is killed (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`,
        },
      },
      required: ["command"],
    },
  };

  private readonly shell: string;
  private readonly sessionDir: string;
  private readonly stateFile: string;
  private readonly hiddenEnv: Set<string>;
  private readonly initialCwd: string;
  private commandCount = 0;

  constructor(options: BashToolOptions) {
    this.shell = spawnSync("bash", ["-c", "exit 0"]).status === 0 ? "bash" : "sh";
    this.sessionDir = join(options.scratchDir, "shell");
    mkdirSync(this.sessionDir, { recursive: true });
    this.stateFile = join(this.sessionDir, "state.sh");
    this.hiddenEnv = new Set(options.hiddenEnv ?? []);
    this.initialCwd = options.initialCwd;
  }

  /** The session's current directory, as of the last completed command. */
  currentDirectory(): string {
    if (!existsSync(this.stateFile)) return this.initialCwd;
    const match = /^cd '((?:[^']|'\\'')*)'$/m.exec(readFileSync(this.stateFile, "utf8"));
    return match ? match[1].replace(/'\\''/g, "'") : this.initialCwd;
  }

  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<Observation> {
    const command = args.command as string;
    const remainingSec = Math.max(1, Math.floor((ctx.deadline - Date.now()) / 1000));
    const requestedSec = Math.min((args.timeout_sec as number | undefined) ?? DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
    const timeoutSec = Math.max(1, Math.min(requestedSec, remainingSec));

    const n = ++this.commandCount;
    const commandFile = join(this.sessionDir, `command-${n}.sh`);
    const outputFile = join(this.sessionDir, `output-${n}.log`);
    const wrapperFile = join(this.sessionDir, `wrapper-${n}.sh`);
    writeFileSync(commandFile, command + "\n");
    writeFileSync(outputFile, "");
    const stateSavedMarker = join(this.sessionDir, `state-saved-${n}`);
    writeFileSync(wrapperFile, this.wrapperScript(commandFile, outputFile, stateSavedMarker));

    const started = Date.now();
    const outcome = await this.spawnWithTimeout(wrapperFile, timeoutSec * 1000);
    const durationSec = ((Date.now() - started) / 1000).toFixed(1);
    const { text, totalBytes } = readHeadTail(outputFile, HEAD_BYTES, TAIL_BYTES);

    const header = outcome.timedOut
      ? `[command timed out after ${timeoutSec}s and was killed · output so far below]`
      : `[exit code ${outcome.exitCode ?? `signal ${outcome.signal}`} · ${durationSec}s]`;
    const body = text.length > 0 ? text : "(no output)";
    const truncatedNote =
      totalBytes > HEAD_BYTES + TAIL_BYTES
        ? `\n[output was ${totalBytes} bytes; showing first ${HEAD_BYTES} and last ${TAIL_BYTES}. Full output: ${outputFile}]`
        : "";

    // The state save runs on shell exit; it is skipped when the command
    // replaced the shell (`exec`) or was killed. Say so, instead of silently
    // dropping this command's cd/export changes.
    const stateSaved = existsSync(stateSavedMarker);
    const stateNote = stateSaved
      ? ""
      : `\n[note: the shell ${outcome.timedOut ? "was killed" : "was replaced (exec) or killed"} before saving its state, so cd/export changes from this command were not kept; the session is still in ${this.currentDirectory()}]`;

    return {
      ok: !outcome.timedOut && outcome.exitCode === 0,
      output: `${header}\n${body}${truncatedNote}${stateNote}`,
      meta: {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        timeoutSec,
        outputBytes: totalBytes,
        outputFile,
        stateSaved,
      },
    };
  }

  /**
   * Restores session state, runs the user command with all output going to
   * a file, and saves cwd + exported env on ANY exit (including `exit` in
   * the command). Works in both bash and POSIX sh.
   */
  private wrapperScript(commandFile: string, outputFile: string, stateSavedMarker: string): string {
    const q = shellQuote;
    return [
      `exec > ${q(outputFile)} 2>&1 < /dev/null`,
      `export PYTHONUNBUFFERED=1`,
      `__save_state() {`,
      `  __ec=$?`,
      `  { printf "cd '%s'\\n" "$(pwd | sed "s/'/'\\\\\\\\''/g")"; export -p | awk ${q(EXPORT_FILTER_AWK)}; } > ${q(this.stateFile + ".tmp")} 2>/dev/null && mv ${q(this.stateFile + ".tmp")} ${q(this.stateFile)} && : > ${q(stateSavedMarker)}`,
      `  exit $__ec`,
      `}`,
      `trap __save_state EXIT`,
      `if [ -f ${q(this.stateFile)} ]; then . ${q(this.stateFile)}; else cd ${q(this.initialCwd)}; fi`,
      `. ${q(commandFile)}`,
      ``,
    ].join("\n");
  }

  private spawnWithTimeout(
    wrapperFile: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEBIAN_FRONTEND: "noninteractive",
      PAGER: "cat",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const name of this.hiddenEnv) delete env[name];

    return new Promise((resolve) => {
      const child = spawn(this.shell, [wrapperFile], {
        cwd: this.initialCwd,
        env,
        stdio: "ignore",
        detached: true, // own process group, so a timeout kills the whole command tree
      });
      let timedOut = false;
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          // already gone
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ exitCode: 127, signal: null, timedOut: false });
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal, timedOut });
      });
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Reads at most head+tail bytes of a file, however large it is. */
export function readHeadTail(path: string, headBytes: number, tailBytes: number): { text: string; totalBytes: number } {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const totalBytes = fstatSync(fd).size;
    if (totalBytes <= headBytes + tailBytes) {
      const buffer = Buffer.alloc(totalBytes);
      readSync(fd, buffer, 0, totalBytes, 0);
      return { text: buffer.toString("utf8"), totalBytes };
    }
    const head = Buffer.alloc(headBytes);
    readSync(fd, head, 0, headBytes, 0);
    const tail = Buffer.alloc(tailBytes);
    readSync(fd, tail, 0, tailBytes, totalBytes - tailBytes);
    const omitted = totalBytes - headBytes - tailBytes;
    return {
      text: `${head.toString("utf8")}\n[... ${omitted} bytes omitted ...]\n${tail.toString("utf8")}`,
      totalBytes,
    };
  } catch {
    return { text: "", totalBytes: 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
