/**
 * Logger Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Logger, getLogger } from "../../src/utils/logger.js";

describe("Logger", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger();
  });

  describe("constructor", () => {
    it("should create logger with default config", () => {
      expect(logger.level).toBe("info");
      expect(logger.colorize).toBe(true);
    });

    it("should create logger with custom config", () => {
      const customLogger = new Logger({ level: "debug", colorize: false });
      expect(customLogger.level).toBe("debug");
      expect(customLogger.colorize).toBe(false);
    });
  });

  describe("setLevel", () => {
    it("should set log level", () => {
      logger.setLevel("debug");
      expect(logger.level).toBe("debug");
    });
  });

  describe("logging methods", () => {
    it("should not throw when logging", () => {
      expect(() => logger.debug("debug message")).not.toThrow();
      expect(() => logger.info("info message")).not.toThrow();
      expect(() => logger.warn("warn message")).not.toThrow();
      expect(() => logger.error("error message")).not.toThrow();
    });
  });
});

describe("getLogger", () => {
  it("should return singleton instance", () => {
    const logger1 = getLogger();
    const logger2 = getLogger();
    expect(logger1).toBe(logger2);
  });
});
