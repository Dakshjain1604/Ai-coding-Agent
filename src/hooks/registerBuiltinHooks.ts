/**
 * Registers the built-in hooks (pre-tool-use, post-tool-use, on-error) onto
 * the singleton HookManager. Idempotent — safe to call from every CLI entry
 * point without double-registering.
 *
 * Not done inside HookManager's own constructor: unit tests construct bare
 * `new HookManager()` instances and assert exact hook counts per event, so
 * auto-registering built-ins there would break that isolation.
 */

import { getHookManager } from "./HookManager.js";
import { preToolUseHook } from "./built-in/pre-tool-use.js";
import { postToolUseHook } from "./built-in/post-tool-use.js";
import { onErrorHook } from "./built-in/on-error.js";

let registered = false;

export function registerBuiltinHooks(): void {
  if (registered) return;

  const hookManager = getHookManager();
  hookManager.register(preToolUseHook);
  hookManager.register(postToolUseHook);
  hookManager.register(onErrorHook);

  registered = true;
}
