/**
 * Auto-Formatter Utility
 * Automatically formats code files using Prettier/ESLint post-write.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { extname } from "path";

const execFileAsync = promisify(execFile);

export async function formatFile(filePath: string, cwd?: string): Promise<boolean> {
  const ext = extname(filePath);
  const formattableExts = [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".yaml", ".yml"];

  if (!formattableExts.includes(ext) || !existsSync(filePath)) {
    return false;
  }

  const workDir = cwd ?? process.cwd();

  try {
    // execFile with an argv array — filePath (a real file's own path, but
    // still worth not trusting) is never interpolated into a shell string.
    await execFileAsync("npx", ["prettier", "--write", filePath], {
      cwd: workDir,
      timeout: 10000,
    });
    return true;
  } catch {
    // Prettier not available or failed silently, non-critical
    return false;
  }
}
