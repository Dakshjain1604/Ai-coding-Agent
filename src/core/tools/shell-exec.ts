/**
 * Shell Execution Tools
 * Tools for executing shell commands
 */

import type { ToolDefinition } from "./ToolRegistry.js";
import type { ToolResult } from "../../utils/types.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export function createShellTools(): ToolDefinition[] {
  return [
    {
      name: "shell_exec",
      description: "Execute a shell command",
      parameters: {
        command: {
          type: "string",
          description: "Command to execute",
          required: true,
        },
        cwd: {
          type: "string",
          description: "Working directory",
          required: false,
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds",
          required: false,
          default: 30000,
        },
        env: {
          type: "object",
          description: "Environment variables",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const command = params.command as string;
          const cwd = params.cwd as string | undefined;
          const timeout = (params.timeout as number) ?? 30000;
          const env = params.env as Record<string, string> | undefined;

          const options: {
            cwd?: string;
            env?: Record<string, string>;
            timeout: number;
            maxBuffer: number;
          } = {
            timeout,
            maxBuffer: 1024 * 1024 * 10, // 10MB buffer
          };

          if (cwd) options.cwd = cwd;
          if (env) {
            const filteredEnv: Record<string, string> = {};
            for (const [key, value] of Object.entries(env)) {
              if (value !== undefined) {
                filteredEnv[key] = value;
              }
            }
            options.env = {
              ...(process.env as Record<string, string>),
              ...filteredEnv,
            };
          }

          const { stdout, stderr } = await execAsync(command, options);

          const output = stderr ? `${stdout}\nStderr:\n${stderr}` : stdout;
          return {
            success: true,
            output: output || "Command completed successfully (no output)",
            metadata: { stdout, stderr },
          };
        } catch (error: unknown) {
          const execError = error as {
            code?: number;
            stdout?: string;
            stderr?: string;
            message?: string;
          };
          return {
            success: false,
            output: `Command failed with exit code ${execError.code ?? "unknown"}\n${execError.stdout ?? ""}\nStderr:\n${execError.stderr ?? ""}\nError: ${execError.message ?? "Unknown error"}`,
            metadata: {
              code: execError.code,
              stdout: execError.stdout,
              stderr: execError.stderr,
            },
          };
        }
      },
    },

    {
      name: "shell_which",
      description: "Find the location of an executable",
      parameters: {
        name: {
          type: "string",
          description: "Name of the executable to find",
          required: true,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const name = params.name as string;
          const command =
            process.platform === "win32" ? `where ${name}` : `which ${name}`;
          const { stdout } = await execAsync(command);
          return { success: true, output: stdout.trim() };
        } catch {
          return {
            success: false,
            output: `Executable not found: ${params.name}`,
          };
        }
      },
    },

    {
      name: "shell_env",
      description: "Get environment variables",
      parameters: {
        name: {
          type: "string",
          description:
            "Name of environment variable (optional, returns all if not specified)",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const name = params.name as string | undefined;

          if (name) {
            const value = process.env[name];
            if (value === undefined) {
              return {
                success: false,
                output: `Environment variable not found: ${name}`,
              };
            }
            return { success: true, output: value };
          }

          // Return all environment variables
          const envVars = Object.entries(process.env)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n");
          return { success: true, output: envVars };
        } catch (error) {
          return {
            success: false,
            output: `Error getting environment: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "process_list",
      description: "List running processes",
      parameters: {
        filter: {
          type: "string",
          description: "Filter processes by name",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const filter = params.filter as string | undefined;
          const command =
            process.platform === "win32"
              ? "tasklist"
              : filter
                ? `ps aux | grep ${filter}`
                : "ps aux";

          const { stdout } = await execAsync(command);
          return { success: true, output: stdout };
        } catch (error) {
          return {
            success: false,
            output: `Error listing processes: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "process_kill",
      description: "Kill a process by PID",
      parameters: {
        pid: {
          type: "number",
          description: "Process ID to kill",
          required: true,
        },
        signal: {
          type: "string",
          description: "Signal to send (SIGTERM, SIGKILL, etc.)",
          required: false,
          default: "SIGTERM",
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const pid = params.pid as number;
          const signal = (params.signal as string) ?? "SIGTERM";

          process.kill(pid, signal as NodeJS.Signals);
          return { success: true, output: `Sent ${signal} to process ${pid}` };
        } catch (error) {
          return {
            success: false,
            output: `Error killing process: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },

    {
      name: "logs_read",
      description: "Read log file contents",
      parameters: {
        path: {
          type: "string",
          description: "Path to log file",
          required: true,
        },
        lines: {
          type: "number",
          description: "Number of lines to read from end",
          required: false,
          default: 100,
        },
        filter: {
          type: "string",
          description: "Filter lines by pattern",
          required: false,
        },
      },
      handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const path = params.path as string;
          const lines = (params.lines as number) ?? 100;
          const filter = params.filter as string | undefined;

          const command =
            process.platform === "win32"
              ? `powershell -Command "Get-Content ${path} -Tail ${lines}"`
              : filter
                ? `tail -n ${lines} ${path} | grep -E "${filter}"`
                : `tail -n ${lines} ${path}`;

          const { stdout } = await execAsync(command);
          return { success: true, output: stdout };
        } catch (error) {
          return {
            success: false,
            output: `Error reading logs: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    },
  ];
}
