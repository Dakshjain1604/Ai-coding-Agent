/**
 * Tests for SystemAnalyzer (utils/system-analyzer.ts) — previously zero
 * coverage despite recommendedMaxTokens directly capping the maxTokens
 * budget for every single agent's LLM calls (BaseAgent.getDefaultConfig())
 * and recommendedMaxAgents directly capping AgentSpawner's concurrency
 * limit. No functional bug found in the threshold logic itself (it's
 * internally consistent), but this locks in that behavior with real
 * coverage, and removes two entirely dead imports (readFileSync, join —
 * flagged by eslint, never used anywhere in the file).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { cpusMock, totalmemMock, freememMock, loadavgMock } = vi.hoisted(() => ({
  cpusMock: vi.fn(),
  totalmemMock: vi.fn(),
  freememMock: vi.fn(),
  loadavgMock: vi.fn(),
}));

vi.mock("os", () => ({
  cpus: (...args: unknown[]) => cpusMock(...args),
  totalmem: (...args: unknown[]) => totalmemMock(...args),
  freemem: (...args: unknown[]) => freememMock(...args),
  loadavg: (...args: unknown[]) => loadavgMock(...args),
}));

import { SystemAnalyzer } from "../../src/utils/system-analyzer.js";

const GB = 1024 ** 3;

function setSystem(opts: { cpuCount: number; totalGB: number; freeGB: number; load0: number }) {
  cpusMock.mockReturnValue(
    Array.from({ length: opts.cpuCount }, () => ({ model: "Fake CPU" })),
  );
  totalmemMock.mockReturnValue(opts.totalGB * GB);
  freememMock.mockReturnValue(opts.freeGB * GB);
  loadavgMock.mockReturnValue([opts.load0, opts.load0, opts.load0]);
}

beforeEach(() => {
  cpusMock.mockReset();
  totalmemMock.mockReset();
  freememMock.mockReset();
  loadavgMock.mockReset();
});

describe("SystemAnalyzer — status classification", () => {
  it("reports 'optimal' for low memory usage and low load", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 30, load0: 0.5 });
    expect(new SystemAnalyzer().analyze().status).toBe("optimal");
  });

  it("reports 'moderate' once memory usage crosses 35%", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 20, load0: 0.5 });
    expect(new SystemAnalyzer().analyze().status).toBe("moderate");
  });

  it("reports 'limited' once memory usage crosses 50%", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 15, load0: 0.5 });
    expect(new SystemAnalyzer().analyze().status).toBe("limited");
  });

  it("reports 'critical' once memory usage crosses 70%", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 8, load0: 0.5 });
    expect(new SystemAnalyzer().analyze().status).toBe("critical");
  });

  it("reports 'critical' from load alone even with low memory usage", () => {
    setSystem({ cpuCount: 4, totalGB: 32, freeGB: 30, load0: 4 });
    expect(new SystemAnalyzer().analyze().status).toBe("critical");
  });

  it("reports 'limited' from load alone (load > cpuCount * 0.7)", () => {
    setSystem({ cpuCount: 4, totalGB: 32, freeGB: 30, load0: 3 });
    expect(new SystemAnalyzer().analyze().status).toBe("limited");
  });

  it("reports 'moderate' from load alone (load > cpuCount * 0.5)", () => {
    setSystem({ cpuCount: 4, totalGB: 32, freeGB: 30, load0: 2.1 });
    expect(new SystemAnalyzer().analyze().status).toBe("moderate");
  });
});

describe("SystemAnalyzer — isLowMemory / isHighLoad flags", () => {
  it("isLowMemory is true once usage exceeds 50%", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 15, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().isLowMemory).toBe(true);
  });

  it("isLowMemory is false under 50% usage", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 30, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().isLowMemory).toBe(false);
  });

  it("isHighLoad is true once load exceeds cpuCount * 0.5", () => {
    setSystem({ cpuCount: 4, totalGB: 32, freeGB: 30, load0: 2.1 });
    expect(new SystemAnalyzer().analyze().isHighLoad).toBe(true);
  });

  it("isHighLoad is false under cpuCount * 0.5", () => {
    setSystem({ cpuCount: 4, totalGB: 32, freeGB: 30, load0: 1 });
    expect(new SystemAnalyzer().analyze().isHighLoad).toBe(false);
  });
});

describe("SystemAnalyzer — recommendedMaxAgents (drives AgentSpawner concurrency cap)", () => {
  it("caps to 1 agent when status is critical", () => {
    setSystem({ cpuCount: 16, totalGB: 32, freeGB: 8, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedMaxAgents).toBe(1);
  });

  it("caps to 1 agent when status is limited", () => {
    setSystem({ cpuCount: 16, totalGB: 32, freeGB: 15, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedMaxAgents).toBe(1);
  });

  it("scales with cpuCount when status is optimal", () => {
    setSystem({ cpuCount: 16, totalGB: 32, freeGB: 30, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedMaxAgents).toBe(8);
  });

  it("never recommends fewer than 2 agents when status is optimal, even on a low core count", () => {
    setSystem({ cpuCount: 2, totalGB: 32, freeGB: 30, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedMaxAgents).toBe(2);
  });
});

describe("SystemAnalyzer — recommendedMaxTokens (drives BaseAgent.getDefaultConfig's maxTokens)", () => {
  it("gives the full 64000 budget when status is optimal", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 30, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedMaxTokens).toBe(64000);
  });

  it("shrinks the budget to 8000 when status is critical", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 8, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedMaxTokens).toBe(8000);
  });

  it("shrinks the budget to 16000 when status is limited", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 15, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedMaxTokens).toBe(16000);
  });

  it("shrinks the budget to 32000 when status is moderate", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 20, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedMaxTokens).toBe(32000);
  });
});

describe("SystemAnalyzer — recommendedModel tiers by free memory", () => {
  it("recommends the 14b model at 16GB+ free", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 20, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedModel.ollama).toBe("qwen2.5-coder:14b");
  });

  it("recommends the 7b model between 8-16GB free", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 10, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedModel.ollama).toBe("qwen2.5-coder:7b");
  });

  it("recommends the 3b model between 6-8GB free", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 7, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedModel.ollama).toBe("qwen2.5-coder:3b");
  });

  it("recommends the 1.5b model under 6GB free", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 3, load0: 0.1 });
    expect(new SystemAnalyzer().analyze().recommendedModel.ollama).toBe("qwen2.5-coder:1.5b");
  });
});

describe("SystemAnalyzer — memory math and rounding", () => {
  it("computes usedMemoryGB and memoryUsagePercent consistently with total/free", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 8, load0: 0.1 });
    const caps = new SystemAnalyzer().analyze();
    expect(caps.totalMemoryGB).toBe(32);
    expect(caps.freeMemoryGB).toBe(8);
    expect(caps.usedMemoryGB).toBe(24);
    expect(caps.memoryUsagePercent).toBe(75);
  });

  it("falls back to 'Unknown' for cpuModel when cpus() returns an empty array", () => {
    cpusMock.mockReturnValue([]);
    totalmemMock.mockReturnValue(32 * GB);
    freememMock.mockReturnValue(30 * GB);
    loadavgMock.mockReturnValue([0.1, 0.1, 0.1]);
    expect(new SystemAnalyzer().analyze().cpuModel).toBe("Unknown");
  });
});

describe("SystemAnalyzer — caching", () => {
  it("caches results within the TTL window (does not re-read os stats on immediate re-call)", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 30, load0: 0.1 });
    const analyzer = new SystemAnalyzer();
    analyzer.analyze();
    const callsAfterFirst = cpusMock.mock.calls.length;
    analyzer.analyze();
    expect(cpusMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("returns a fresh reading after the cache TTL expires", () => {
    vi.useFakeTimers();
    try {
      setSystem({ cpuCount: 8, totalGB: 32, freeGB: 30, load0: 0.1 });
      const analyzer = new SystemAnalyzer();
      const first = analyzer.analyze();
      expect(first.status).toBe("optimal");

      setSystem({ cpuCount: 8, totalGB: 32, freeGB: 8, load0: 0.1 });
      vi.advanceTimersByTime(10001);
      const second = analyzer.analyze();
      expect(second.status).toBe("critical");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SystemAnalyzer — getRecommendedConfig()", () => {
  it("uses a shorter timeout when status is critical", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 8, load0: 0.1 });
    expect(new SystemAnalyzer().getRecommendedConfig().timeout).toBe(120000);
  });

  it("uses the default longer timeout when status is optimal", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 30, load0: 0.1 });
    expect(new SystemAnalyzer().getRecommendedConfig().timeout).toBe(300000);
  });

  it("mirrors recommendedMaxAgents/recommendedMaxTokens from analyze()", () => {
    setSystem({ cpuCount: 8, totalGB: 32, freeGB: 30, load0: 0.1 });
    const analyzer = new SystemAnalyzer();
    const caps = analyzer.analyze();
    const config = analyzer.getRecommendedConfig();
    expect(config.maxParallelAgents).toBe(caps.recommendedMaxAgents);
    expect(config.maxTokens).toBe(caps.recommendedMaxTokens);
  });
});
