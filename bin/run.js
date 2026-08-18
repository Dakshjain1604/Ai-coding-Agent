#!/usr/bin/env node --no-warnings

// Load .env before anything else — oclif's dynamic command discovery loads
// command files directly from dist/cli/commands/, bypassing src/cli/index.ts
// (whose own "dotenv/config" import is therefore never reached on this path).
import "dotenv/config";
import { execute } from "@oclif/core";

await execute({ dir: import.meta.url });
