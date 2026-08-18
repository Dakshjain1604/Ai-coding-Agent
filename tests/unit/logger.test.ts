/**
 * Logger Tests
 *
 * Centerpiece regression: success()/fail() used to call console.log
 * directly, bypassing shouldLog() entirely — unlike every other log
 * method (debug/info/warn/error). interactive.ts deliberately sets the
 * logger level to "error" on startup to suppress debug/info/warn noise
 * during its own polished UI; success()/fail() would have silently
 * ignored that suppression had anything called them under a raised log
 * level. Fixed by gating success() on "info" and fail() on "error".
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Logger, getLogger, createLogger } from "../../src/utils/logger.js";

describe("Logger — constructor", () => {
  afterEach(() => {
    delete process.env.LOG_LEVEL;
  });

  it("creates a logger with default config", () => {
    const logger = new Logger();
    expect(logger.level).toBe("info");
    expect(logger.colorize).toBe(true);
    expect(logger.timestamp).toBe(false);
  });

  it("creates a logger with custom config", () => {
    const logger = new Logger({ level: "debug", colorize: false });
    expect(logger.level).toBe("debug");
    expect(logger.colorize).toBe(false);
  });

  it("reads LOG_LEVEL from the environment when no explicit level is given", () => {
    process.env.LOG_LEVEL = "warn";
    const logger = new Logger();
    expect(logger.level).toBe("warn");
  });

  it("ignores an invalid LOG_LEVEL env value and falls back to 'info'", () => {
    process.env.LOG_LEVEL = "not-a-real-level";
    const logger = new Logger();
    expect(logger.level).toBe("info");
  });

  it("an explicit level config overrides LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "debug";
    const logger = new Logger({ level: "error" });
    expect(logger.level).toBe("error");
  });
});

describe("Logger — setLevel/setPrefix", () => {
  it("setLevel updates the level", () => {
    const logger = new Logger();
    logger.setLevel("debug");
    expect(logger.level).toBe("debug");
  });

  it("setPrefix updates the prefix", () => {
    const logger = new Logger();
    logger.setPrefix("MyModule");
    expect(logger.prefix).toBe("MyModule");
  });
});

describe("Logger — level gating (debug/info/warn/error)", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("at level 'info', suppresses debug but shows info/warn/error", () => {
    const logger = new Logger({ level: "info" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("at level 'error', suppresses debug/info/warn and shows only error", () => {
    const logger = new Logger({ level: "error" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("at level 'silent', suppresses everything including error", () => {
    const logger = new Logger({ level: "silent" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("at level 'debug', shows everything", () => {
    const logger = new Logger({ level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(debugSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("Logger — success()/fail() level-gating fix", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("success() prints at the default 'info' level", () => {
    const logger = new Logger({ level: "info" });
    logger.success("done");
    expect(logSpy).toHaveBeenCalled();
  });

  it("success() is suppressed at 'error' level (interactive mode's configured level)", () => {
    const logger = new Logger({ level: "error" });
    logger.success("done");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("success() is suppressed at 'silent' level", () => {
    const logger = new Logger({ level: "silent" });
    logger.success("done");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("fail() still prints at 'error' level (errors should surface even when other output is suppressed)", () => {
    const logger = new Logger({ level: "error" });
    logger.fail("broke");
    expect(logSpy).toHaveBeenCalled();
  });

  it("fail() is suppressed only at 'silent' level", () => {
    const logger = new Logger({ level: "silent" });
    logger.fail("broke");
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("Logger — message formatting", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("includes the prefix in the formatted message when set", () => {
    const logger = new Logger({ prefix: "MyModule", colorize: false });
    logger.info("hello");
    const formatted = infoSpy.mock.calls[0][0] as string;
    expect(formatted).toContain("[MyModule]");
  });

  it("includes an ISO timestamp when timestamp:true", () => {
    const logger = new Logger({ timestamp: true, colorize: false });
    logger.info("hello");
    const formatted = infoSpy.mock.calls[0][0] as string;
    expect(formatted).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
  });

  it("omits color codes when colorize:false", () => {
    const logger = new Logger({ colorize: false });
    logger.info("hello");
    const formatted = infoSpy.mock.calls[0][0] as string;
    // eslint-disable-next-line no-control-regex
    expect(formatted).not.toMatch(/\x1b\[/);
  });

  it("includes the message text itself", () => {
    const logger = new Logger({ colorize: false });
    logger.info("a specific message");
    const formatted = infoSpy.mock.calls[0][0] as string;
    expect(formatted).toContain("a specific message");
  });
});

describe("Logger — spinner methods", () => {
  it("spinner methods do not throw when no spinner is active", () => {
    const logger = new Logger();
    expect(() => logger.spinnerSucceed()).not.toThrow();
    expect(() => logger.spinnerFail()).not.toThrow();
    expect(() => logger.spinnerUpdate("x")).not.toThrow();
    expect(() => logger.spinnerStop()).not.toThrow();
  });
});

describe("Logger — agent/memory/provider convenience helpers", () => {
  it("do not throw when called", () => {
    const logger = new Logger();
    expect(() => logger.agentSpawn("code", "t-1")).not.toThrow();
    expect(() => logger.agentComplete("code", "t-1", 100)).not.toThrow();
    expect(() => logger.agentError("code", "t-1", new Error("x"))).not.toThrow();
    expect(() => logger.memoryStore("k")).not.toThrow();
    expect(() => logger.memoryRetrieve("k")).not.toThrow();
    expect(() => logger.providerCall("groq", "m")).not.toThrow();
  });
});

describe("getLogger/createLogger", () => {
  it("getLogger returns the same singleton instance across calls", () => {
    expect(getLogger()).toBe(getLogger());
  });

  it("createLogger replaces the singleton getLogger() subsequently returns", () => {
    const created = createLogger({ level: "debug" });
    expect(getLogger()).toBe(created);
    expect(getLogger().level).toBe("debug");
  });
});
