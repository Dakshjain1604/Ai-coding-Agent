/**
 * Auto-Formatter Utility
 * Automatically formats code files using Prettier/ESLint post-write.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { extname } from "path";

const execAsync = promisify(exec);

export async function formatFile(filePath: string, cwd?: string): Promise<boolean> {
  const ext = extname(filePath);
  const formattableExts = [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".yaml", ".yml"];

  if (!formattableExts.includes(ext) || !existsSync(filePath)) {
    return false;
  }

  const workDir = cwd ?? process.cwd();

  try {
    // Try running prettier on the written file
    await execAsync(`npx prettier --write "${filePath}"`, {
      cwd: workDir,
      timeout: 10000,
    });
    return true;
  } catch {
    // Prettier not available or failed silently, non-critical
    return false;
  }
}
