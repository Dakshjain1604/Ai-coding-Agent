#!/usr/bin/env node --no-warnings

// Load .env before anything else — oclif's dynamic command discovery loads
// command files directly from dist/cli/commands/, bypassing src/cli/index.ts
// (whose own "dotenv/config" import is therefore never reached on this path).
import "dotenv/config";
import { execute } from "@oclif/core";
import { installGlobalErrorHandlers } from "../dist/cli/errorHandling.js";

// Same reason as the dotenv import above: this is the actual entry point,
// so this is where process-level handlers need to be installed to ever run.
installGlobalErrorHandlers();

await execute({ dir: import.meta.url });
