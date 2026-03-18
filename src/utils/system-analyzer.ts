/**
 * System Analyzer - Analyze system capabilities for optimal agent configuration
 */

import { cpus, totalmem, freemem, loadavg } from "os";
import { readFileSync } from "fs";
import { join } from "path";

export interface SystemCapabilities {
  cpuCount: number;
  cpuModel: string;
  totalMemoryGB: number;
  freeMemoryGB: number;
  usedMemoryGB: number;
  memoryUsagePercent: number;
  loadAverage: number[];
  isLowMemory: boolean;
  isHighLoad: boolean;
  canHandleParallel: number;
  recommendedMaxAgents: number;
  recommendedMaxTokens: number;
  status: "optimal" | "moderate" | "limited" | "critical";
  recommendedModel: {
    ollama: string;
    reasoning: string;
  };
}

export class SystemAnalyzer {
  private cachedCapabilities: SystemCapabilities | null = null;
  private lastCheck: number = 0;
  private cacheTTL: number = 10000; // 10 seconds cache

  analyze(): SystemCapabilities {
    const now = Date.now();
    if (this.cachedCapabilities && now - this.lastCheck < this.cacheTTL) {
      return this.cachedCapabilities;
    }

    this.cachedCapabilities = this.analyzeSystem();
    this.lastCheck = now;
    return this.cachedCapabilities;
  }

  private analyzeSystem(): SystemCapabilities {
    const cpuList = cpus();
    const totalMemory = totalmem();
    const freeMemory = freemem();
    const usedMemory = totalMemory - freeMemory;
    const memoryUsagePercent = (usedMemory / totalMemory) * 100;

    const cpuCount = cpuList.length;
    const cpuModel = cpuList[0]?.model || "Unknown";
    const sysLoadAvg = loadavg();

    const isLowMemory = memoryUsagePercent > 50;
    const isHighLoad = sysLoadAvg[0] > cpuCount * 0.5;

    let status: SystemCapabilities["status"] = "optimal";
    if (memoryUsagePercent > 70 || sysLoadAvg[0] > cpuCount * 0.9) {
      status = "critical";
    } else if (memoryUsagePercent > 50 || sysLoadAvg[0] > cpuCount * 0.7) {
      status = "limited";
    } else if (memoryUsagePercent > 35 || sysLoadAvg[0] > cpuCount * 0.5) {
      status = "moderate";
    }

    const canHandleParallel = this.calculateParallelCapacity(
      cpuCount,
      memoryUsagePercent,
      sysLoadAvg[0],
    );
    const recommendedMaxAgents = this.calculateMaxAgents(status, cpuCount);
    const recommendedMaxTokens = this.calculateMaxTokens(status);
    const recommendedModel = this.calculateRecommendedModel(freeMemory);

    return {
      cpuCount,
      cpuModel,
      totalMemoryGB: Math.round((totalMemory / 1024 ** 3) * 100) / 100,
      freeMemoryGB: Math.round((freeMemory / 1024 ** 3) * 100) / 100,
      usedMemoryGB: Math.round((usedMemory / 1024 ** 3) * 100) / 100,
      memoryUsagePercent: Math.round(memoryUsagePercent * 100) / 100,
      loadAverage: sysLoadAvg.map((l: number) => Math.round(l * 100) / 100),
      isLowMemory,
      isHighLoad,
      canHandleParallel,
      recommendedMaxAgents,
      recommendedMaxTokens,
      status,
      recommendedModel,
    };
  }

  private calculateParallelCapacity(
    cpuCount: number,
    memoryUsagePercent: number,
    load: number,
  ): number {
    let capacity = Math.floor(cpuCount * 0.5);

    if (memoryUsagePercent > 50) {
      capacity = 1;
    } else if (memoryUsagePercent > 35) {
      capacity = Math.max(1, Math.floor(cpuCount * 0.25));
    }

    if (load > cpuCount * 0.5) {
      capacity = Math.min(capacity, 1);
    }

    return Math.max(1, capacity);
  }

  private calculateMaxAgents(
    status: SystemCapabilities["status"],
    cpuCount: number,
  ): number {
    switch (status) {
      case "critical":
        return 1;
      case "limited":
        return 1;
      case "moderate":
        return Math.max(1, Math.floor(cpuCount * 0.25));
      default:
        return Math.max(2, Math.floor(cpuCount * 0.5));
    }
  }

  private calculateMaxTokens(status: SystemCapabilities["status"]): number {
    switch (status) {
      case "critical":
        return 8000;
      case "limited":
        return 16000;
      case "moderate":
        return 32000;
      default:
        return 64000;
    }
  }

  private calculateRecommendedModel(freeMemory: number): {
    ollama: string;
    reasoning: string;
  } {
    const freeMemoryGB = freeMemory / 1024 ** 3;

    if (freeMemoryGB >= 16) {
      return {
        ollama: "qwen2.5-coder:14b",
        reasoning: "16GB+ free RAM: 14B model for best quality",
      };
    } else if (freeMemoryGB >= 8) {
      return {
        ollama: "qwen2.5-coder:7b",
        reasoning: "8-16GB free RAM: 7B model balances speed/quality",
      };
    } else if (freeMemoryGB >= 6) {
      return {
        ollama: "qwen2.5-coder:3b",
        reasoning: "6-8GB free RAM: 3B model for acceptable performance",
      };
    } else {
      return {
        ollama: "qwen2.5-coder:1.5b",
        reasoning: "<6GB free RAM: 1.5B model for basic functionality",
      };
    }
  }

  getRecommendedConfig(): {
    maxParallelAgents: number;
    maxTokens: number;
    timeout: number;
  } {
    const caps = this.analyze();

    return {
      maxParallelAgents: caps.recommendedMaxAgents,
      maxTokens: caps.recommendedMaxTokens,
      timeout:
        caps.status === "critical"
          ? 120000
          : caps.status === "limited"
            ? 180000
            : 300000,
    };
  }
}

let systemAnalyzerInstance: SystemAnalyzer | null = null;

export function getSystemAnalyzer(): SystemAnalyzer {
  if (!systemAnalyzerInstance) {
    systemAnalyzerInstance = new SystemAnalyzer();
  }
  return systemAnalyzerInstance;
}

export function getSystemCapabilities(): SystemCapabilities {
  return getSystemAnalyzer().analyze();
}
