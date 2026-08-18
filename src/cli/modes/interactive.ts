/**
 * Interactive Mode - Interactive command loop for the CLI
 * Provides a REPL-like experience for the coding agent
 */

import inquirer from "inquirer";
import chalk from "chalk";
import { getLogger } from "../../utils/logger.js";
import { getSkillRegistry } from "../../skills/SkillRegistry.js";
import { getHookManager } from "../../hooks/HookManager.js";
import { registerBuiltinHooks } from "../../hooks/registerBuiltinHooks.js";
import { getAgentSpawner } from "../../core/orchestrator/AgentSpawner.js";
import { getConfigManager } from "../../utils/config.js";
import { getMemoryManager } from "../../memory/MemoryManager.js";
import { getTaskManager } from "../../utils/task-manager.js";
import {
  getSystemAnalyzer,
  type SystemCapabilities,
} from "../../utils/system-analyzer.js";
import type { Task, AgentType } from "../../utils/types.js";
import { v4 as uuid } from "uuid";

type CLIMode = "auto" | "plan" | "debug" | "test" | "review" | "code";

export class InteractiveMode {
  private logger = getLogger();
  private running = false;
  private history: Array<{ input: string; output: string; timestamp: Date }> =
    [];
  private sessionId: string;
  private currentMode: CLIMode = "auto";

  constructor() {
    this.sessionId = uuid();
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.setLevel("error");

    const systemCaps = getSystemAnalyzer().analyze();

    console.clear();
    this.printWelcome(systemCaps);

    await this.initializeSystems();

    while (this.running) {
      try {
        await this.processInput();
      } catch (error) {
        if ((error as Error).message === "EXIT") {
          break;
        }
        this.logger.error("Error in interactive mode", error as Error);
        console.log(chalk.red(`\nError: ${(error as Error).message}\n`));
      }
    }

    this.printGoodbye();
  }

  private printWelcome(systemCaps: SystemCapabilities): void {
    const statusColor: Record<string, any> = {
      optimal: chalk.green,
      moderate: chalk.yellow,
      limited: chalk.red,
      critical: chalk.red.bold,
    };

    const colorFn = statusColor[systemCaps.status] || chalk.green;
    const modelInfo =
      systemCaps.recommendedModel?.ollama || "qwen2.5-coder:latest";

    console.log(
      chalk.bold.cyan(`
╭────────────────────────────────────────────────────────────╮
│                                                            │
│  `) +
        chalk.bold.white(`⚡  CodingAgent v2.0`) +
        chalk.bold.cyan(`                                      │
│                                                            │
│  `) +
        chalk.gray(`Universal AI Engineer with intuitive mode switching`) +
        chalk.bold.cyan(`       │
│                                                            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  `) +
        chalk.bold(`Core Commands:`) +
        chalk.bold.cyan(`                                           │
│  `) +
        chalk.gray(`• /auto     `) +
        chalk.white(`AI auto-detects best mode (default)`) +
        chalk.bold.cyan(`        │
│  `) +
        chalk.gray(`• /run      `) +
        chalk.white(`General coding tasks`) +
        chalk.bold.cyan(`                       │
│  `) +
        chalk.gray(`• /plan     `) +
        chalk.white(`Architecture & roadmap design`) +
        chalk.bold.cyan(`              │
│  `) +
        chalk.gray(`• /debug    `) +
        chalk.white(`Debug and fix issues`) +
        chalk.bold.cyan(`                       │
│  `) +
        chalk.gray(`• /test     `) +
        chalk.white(`Generate or run tests`) +
        chalk.bold.cyan(`                      │
│                                                            │
│  `) +
        chalk.bold(`System: `) +
        colorFn(systemCaps.status.toUpperCase().padEnd(9)) +
        chalk.gray(
          ` | CPU: ${systemCaps.cpuCount} | RAM: ${systemCaps.memoryUsagePercent}%`,
        ) +
        chalk.bold.cyan(`             │
│  `) +
        chalk.bold(`Model:  `) +
        chalk.magenta(modelInfo.padEnd(20)) +
        chalk.bold.cyan(`                           │
│                                                            │
╰────────────────────────────────────────────────────────────╯
    `),
    );
  }

  private getModeDisplay(): string {
    return this.currentMode === "auto"
      ? "Auto-detect"
      : this.currentMode.toUpperCase();
  }

  private printGoodbye(): void {
    console.log(
      chalk.bold.cyan(`
╔════════════════════════════════════════════════════════════╗
║             Thanks for using CodingAgent!                  ║
║                     See you next time!                     ║
╚════════════════════════════════════════════════════════════╝
    `),
    );
  }

  private async initializeSystems(): Promise<void> {
    const skillRegistry = getSkillRegistry();
    await skillRegistry.initialize();

    const hookManager = getHookManager();
    hookManager.enable();
    registerBuiltinHooks();

    const configManager = getConfigManager();
    configManager.load();
  }

  private async processInput(): Promise<void> {
    const { input } = await inquirer.prompt<{ input: string }>([
      {
        type: "input",
        name: "input",
        message: chalk.green(`> [${this.getModeDisplay()}] `),
      },
    ]);

    if (!input.trim()) {
      return;
    }

    console.log("");

    if (input.startsWith("/")) {
      await this.handleCommand(input);
    } else {
      await this.handleRequest(input);
    }

    this.history.push({
      input,
      output: "",
      timestamp: new Date(),
    });
  }

  private async handleCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(/\s+/);
    const [command, ...args] = parts;

    switch (command.toLowerCase()) {
      case "help":
      case "h":
        this.showHelp();
        break;

      case "run":
      case "r":
        this.setMode("code");
        break;

      case "plan":
      case "p":
        this.setMode("plan");
        break;

      case "debug":
      case "d":
        this.setMode("debug");
        break;

      case "test":
      case "t":
        this.setMode("test");
        break;

      case "review":
        this.setMode("review");
        break;

      case "auto":
        this.setMode("auto");
        break;

      case "config":
        await this.handleConfigCommand(args);
        break;

      case "remember":
        await this.handleRemember(args);
        break;

      case "forget":
        await this.handleForget(args);
        break;

      case "memory":
        await this.showMemory();
        break;

      case "undo":
        await this.handleUndo(args);
        break;

      case "system":
      case "sys":
        this.showSystemCapabilities();
        break;

      case "tasks":
        this.showTasks();
        break;

      case "skills":
      case "s":
        await this.showSkills();
        break;

      case "history":
      case "hist":
        this.showHistory();
        break;

      case "clear":
      case "cls":
        console.clear();
        break;

      case "exit":
      case "quit":
      case "q":
        this.running = false;
        throw new Error("EXIT");

      default:
        console.log(chalk.yellow(`Unknown command: /${command}`));
        console.log(chalk.gray("Type /help for available commands"));
    }
  }

  private setMode(mode: CLIMode): void {
    this.currentMode = mode;
    const modeNames: Record<CLIMode, string> = {
      auto: "Auto-detect",
      plan: "Planning",
      debug: "Debugging",
      test: "Testing",
      review: "Code Review",
      code: "General Coding",
    };
    console.log(chalk.green(`[*] Switched to ${modeNames[mode]} mode`));
    console.log("");
  }

  private async handleConfigCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    if (!subcommand || subcommand === "list" || subcommand === "ls") {
      this.showConfig();
      return;
    }

    if (subcommand === "get") {
      const key = args[1];
      if (!key) {
        console.log(chalk.yellow("Usage: /config get <key>"));
        console.log(chalk.gray("Example: /config get defaults.preferLocal"));
        return;
      }
      this.configGet(key);
      return;
    }

    if (subcommand === "set") {
      const key = args[1];
      const value = args.slice(2).join(" ");
      if (!key || value === undefined) {
        console.log(chalk.yellow("Usage: /config set <key> <value>"));
        console.log(
          chalk.gray("Example: /config set defaults.preferLocal false"),
        );
        return;
      }
      this.configSet(key, value);
      return;
    }

    if (subcommand === "save") {
      this.configSave();
      return;
    }

    console.log(chalk.yellow(`Unknown config command: ${subcommand}`));
    console.log(chalk.gray("Available: list, get, set, save"));
  }

  private showConfig(): void {
    const configManager = getConfigManager();
    const config = configManager.get();

    console.log(chalk.bold.cyan("Current Configuration:\n"));

    console.log(chalk.bold("Defaults:"));
    console.log(chalk.gray(`  preferLocal: ${config.defaults.preferLocal}`));
    console.log(
      chalk.gray(`  fallbackToPaid: ${config.defaults.fallbackToPaid}`),
    );
    console.log(
      chalk.gray(`  maxParallelAgents: ${config.defaults.maxParallelAgents}`),
    );
    console.log(
      chalk.gray(
        `  complexityThreshold: ${config.defaults.complexityThreshold}`,
      ),
    );
    console.log(
      chalk.gray(`  maxPaidApiCalls: ${config.defaults.maxPaidApiCalls}`),
    );
    console.log("");

    console.log(chalk.bold("Providers:"));
    for (const provider of config.providers) {
      console.log(
        chalk.gray(`  - ${provider.type} (enabled: ${provider.enabled})`),
      );
      if (provider.baseUrl)
        console.log(chalk.gray(`    baseUrl: ${provider.baseUrl}`));
      if (provider.models) {
        console.log(chalk.gray(`    models:`));
        for (const [taskType, model] of Object.entries(provider.models)) {
          console.log(chalk.gray(`      ${taskType}: ${model}`));
        }
      }
    }
    console.log("");

    console.log(chalk.bold("Agents:"));
    for (const [type, agentConfig] of Object.entries(config.agents)) {
      console.log(chalk.gray(`  ${type}:`));
      console.log(chalk.gray(`    model: ${agentConfig.model}`));
      console.log(chalk.gray(`    maxTokens: ${agentConfig.maxTokens}`));
      console.log(
        chalk.gray(`    maxIterations: ${agentConfig.maxIterations}`),
      );
    }
    console.log("");
  }

  private async handleRemember(args: string[]): Promise<void> {
    const fact = args.join(" ");
    if (!fact) {
      console.log(chalk.yellow("Usage: /remember <fact>"));
      return;
    }
    await getMemoryManager().remember(fact);
    console.log(chalk.green(`Remembered: ${fact}`));
  }

  private async handleForget(args: string[]): Promise<void> {
    const fact = args.join(" ");
    if (!fact) {
      console.log(chalk.yellow("Usage: /forget <fact>"));
      return;
    }
    const removed = await getMemoryManager().forget(fact);
    console.log(
      removed
        ? chalk.green(`Forgot: ${fact}`)
        : chalk.yellow(`No matching memory found for: ${fact}`),
    );
  }

  private async handleUndo(args: string[]): Promise<void> {
    const { getRollbackManager } = await import("../../utils/git-rollback.js");
    const rollback = getRollbackManager();

    const path = args.join(" ").trim();
    if (!path) {
      const files = rollback.listBackedUpFiles();
      if (files.length === 0) {
        console.log(chalk.yellow("No recoverable backups yet."));
        return;
      }
      console.log(chalk.bold.cyan(`\n${files.length} file(s) with a recoverable backup:\n`));
      for (const file of files) {
        console.log(`  ${file}`);
      }
      console.log(chalk.gray("\nUsage: /undo <path>"));
      return;
    }

    if (!rollback.hasBackup(path)) {
      console.log(chalk.yellow(`No backup found for ${path} — nothing to restore.`));
      return;
    }

    const restored = rollback.rollback(path);
    console.log(
      restored
        ? chalk.green(`Restored ${path} from backup.`)
        : chalk.red(`Failed to restore ${path}.`),
    );
  }

  private async showMemory(): Promise<void> {
    const memory = getMemoryManager();

    console.log(chalk.bold.cyan("\nUser preferences:\n"));
    const preferences = await memory.query({ scope: "user" });
    if (preferences.length === 0) {
      console.log(chalk.gray("  (none remembered yet — try /remember <fact>)"));
    } else {
      for (const { entry } of preferences) {
        console.log(chalk.white(`  - ${entry.content}`));
      }
    }

    console.log(chalk.bold.cyan("\nProject knowledge:\n"));
    const projectKnowledge = await memory.exportProjectKnowledge();
    console.log(chalk.gray(projectKnowledge));
  }

  private configGet(key: string): void {
    const configManager = getConfigManager();
    const value = configManager.getConfigValue(key);

    if (value === undefined) {
      console.log(chalk.yellow(`Config key not found: ${key}`));
      return;
    }

    console.log(chalk.bold(`${key}:`));
    console.log(chalk.cyan(JSON.stringify(value, null, 2)));
    console.log("");
  }

  private configSet(key: string, rawValue: string): void {
    const configManager = getConfigManager();

    let value: unknown = rawValue;

    if (rawValue === "true") value = true;
    else if (rawValue === "false") value = false;
    else if (!isNaN(Number(rawValue))) value = Number(rawValue);

    try {
      configManager.setConfigValue(key, value);
      console.log(chalk.green(`[*] Set ${key} = ${JSON.stringify(value)}`));
      console.log(chalk.gray("  (Use /config save to persist changes)\n"));
    } catch (error) {
      console.log(
        chalk.red(`Error setting config: ${(error as Error).message}`),
      );
    }
  }

  private configSave(): void {
    const configManager = getConfigManager();
    try {
      configManager.save();
      console.log(
        chalk.green("[*] Configuration saved to coding-agent.json\n"),
      );
    } catch (error) {
      console.log(
        chalk.red(`Error saving config: ${(error as Error).message}`),
      );
    }
  }

  private async handleRequest(input: string): Promise<void> {
    const taskManager = getTaskManager();
    const skillRegistry = getSkillRegistry();

    const taskContext = taskManager.createTask(input, {
      mode: this.currentMode,
    });
    const matchedSkill = skillRegistry.findByTrigger(input);

    if (matchedSkill) {
      console.log(chalk.blue(`Matched skill: ${matchedSkill.name}`));
      console.log(chalk.gray(matchedSkill.description));
      console.log("");
    }

    // Skills are prompt injections, not autonomous executors: matched
    // instructions are appended to the agent's system prompt (see
    // UniversalAgent.execute()) rather than run directly here — this is
    // what previously made skill matching a no-op beyond a console message.
    const task: Task = {
      id: taskContext.id,
      description: input,
      complexity: "medium",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        ...taskContext.metadata,
        ...(matchedSkill
          ? {
              skillName: matchedSkill.name,
              skillInstructions: matchedSkill.instructions
                .map((instruction, i) => `${i + 1}. ${instruction}`)
                .join("\n"),
            }
          : {}),
      },
    };

    const agentType =
      this.currentMode === "auto"
        ? this.autoDetectMode(input)
        : this.getAgentType();

    if (this.currentMode === "auto") {
      const detectedMode = agentType;
      const modeNames: Record<AgentType, string> = {
        plan: "Planning",
        code: "Coding",
        test: "Testing",
        debug: "Debugging",
        review: "Code Review",
        orchestrator: "Orchestrator",
      };
      console.log(
        chalk.cyan(`Auto-detected: ${modeNames[detectedMode]} mode\n`),
      );
    }

    taskManager.updateTaskStatus("running", { agentType });

    try {
      const spawner = getAgentSpawner();
      const spawned = await spawner.spawn(agentType, task);
      const result = await spawner.execute(spawned.id);
      this.displayResult(result);

      taskManager.completeTask(
        result.success,
        result.success ? undefined : result.output,
      );
      console.log("");
    } catch (error) {
      const taskManager = getTaskManager();
      taskManager.completeTask(false, (error as Error).message);
      console.log(chalk.red(`\n[x] Error: ${(error as Error).message}\n`));
    }
  }

  private displayResult(result: any): void {
    if (result.success) {
      console.log(chalk.green.bold("\n[*] Task completed!\n"));
    } else {
      console.log(chalk.red.bold("\n[x] Task failed:\n"));
    }
  }

  private getAgentType(): AgentType {
    const modeToAgent: Record<CLIMode, AgentType> = {
      auto: "code",
      plan: "plan",
      debug: "debug",
      test: "test",
      review: "review",
      code: "code",
    };
    return modeToAgent[this.currentMode];
  }

  private autoDetectMode(input: string): AgentType {
    const lower = input.toLowerCase();

    const debugKeywords = [
      "debug",
      "fix",
      "bug",
      "error",
      "exception",
      "crash",
      "broken",
      "not working",
      "fails",
      "failed",
      "issue",
      "problem",
      "wrong",
      "null",
      "undefined",
      "cannot",
      "won't start",
      "returns 500",
    ];
    if (debugKeywords.some((kw) => lower.includes(kw))) {
      return "debug";
    }

    const testKeywords = [
      "test",
      "spec",
      "coverage",
      "unit test",
      "integration test",
      "write test",
      "add test",
      "create test",
      "generate test",
      "testing",
      "jest",
      "vitest",
      "mocha",
    ];
    if (testKeywords.some((kw) => lower.includes(kw))) {
      return "test";
    }

    const reviewKeywords = [
      "review",
      "audit",
      "analyze",
      "check for",
      "security",
      "performance",
      "quality",
      "refactor",
      "improve",
      "optimize",
      "best practice",
      "lint",
      "sanity",
      "readability",
    ];
    if (reviewKeywords.some((kw) => lower.includes(kw))) {
      return "review";
    }

    const planKeywords = [
      "plan",
      "architecture",
      "design",
      "structure",
      "roadmap",
      "break down",
      "分解",
      "how to",
      "approach",
      "strategy",
    ];
    if (planKeywords.some((kw) => lower.includes(kw))) {
      return "plan";
    }

    return "code";
  }

  private showHelp(): void {
    console.log(chalk.cyan("\n╭─ ") + chalk.bold.white("Available Commands"));
    console.log(chalk.cyan("│"));
    console.log(chalk.cyan("├─ ") + chalk.bold("Modes"));
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/auto         ") +
        chalk.white("Auto-detect (default)"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/run, /r      ") +
        chalk.white("General Coding"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/plan, /p     ") +
        chalk.white("Planning & Architecture"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/debug, /d    ") +
        chalk.white("Debugging"),
    );
    console.log(
      chalk.cyan("│  ") + chalk.gray("/test, /t     ") + chalk.white("Testing"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/review       ") +
        chalk.white("Code Review"),
    );
    console.log(chalk.cyan("│"));
    console.log(chalk.cyan("├─ ") + chalk.bold("Configuration"));
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/config             ") +
        chalk.white("Show current config"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/config set <k> <v> ") +
        chalk.white("Update config"),
    );
    console.log(chalk.cyan("│"));
    console.log(chalk.cyan("├─ ") + chalk.bold("Memory"));
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/remember <fact>    ") +
        chalk.white("Store an explicit preference/fact"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/forget <fact>      ") +
        chalk.white("Remove a remembered fact"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/memory             ") +
        chalk.white("Show preferences & project knowledge"),
    );
    console.log(chalk.cyan("│"));
    console.log(chalk.cyan("├─ ") + chalk.bold("Undo"));
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/undo <path>        ") +
        chalk.white("Restore a file from its pre-write backup"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/undo               ") +
        chalk.white("List files with a recoverable backup"),
    );
    console.log(chalk.cyan("│"));
    console.log(chalk.cyan("├─ ") + chalk.bold("System"));
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/sys          ") +
        chalk.white("Show system diagnostics"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/skills, /s   ") +
        chalk.white("List loaded skills"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/history      ") +
        chalk.white("Show prompt history"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/clear        ") +
        chalk.white("Clear the screen"),
    );
    console.log(
      chalk.cyan("│  ") +
        chalk.gray("/exit, /q     ") +
        chalk.white("Exit interactive mode"),
    );
    console.log(
      chalk.cyan("╰─────────────────────────────────────────────────\n"),
    );
  }

  private async showSkills(): Promise<void> {
    const skillRegistry = getSkillRegistry();
    const skills = skillRegistry.getAll();

    console.log(chalk.bold.cyan("\nAvailable Skills:\n"));

    if (skills.length === 0) {
      console.log(chalk.gray("  No skills loaded"));
      return;
    }

    for (const skill of skills) {
      console.log(chalk.green(`  ${skill.name}`));
      console.log(chalk.gray(`    ${skill.description}`));
      console.log(chalk.gray(`    Triggers: ${skill.triggers.join(", ")}`));
      console.log("");
    }
  }

  private showSystemCapabilities(): void {
    const caps = getSystemAnalyzer().analyze();

    const statusColor: Record<string, any> = {
      optimal: chalk.green,
      moderate: chalk.yellow,
      limited: chalk.red,
      critical: chalk.red.bold,
    };

    console.log(chalk.cyan("\n╭─ ") + chalk.bold.white("System Diagnostics"));
    console.log(chalk.cyan("│"));
    console.log(
      chalk.cyan("├─ ") +
        chalk.bold("Status:   ") +
        statusColor[caps.status](caps.status.toUpperCase()),
    );
    console.log(
      chalk.cyan("├─ ") +
        chalk.bold("CPU:      ") +
        chalk.gray(`${caps.cpuCount} cores (${caps.cpuModel})`),
    );
    console.log(
      chalk.cyan("├─ ") +
        chalk.bold("Memory:   ") +
        chalk.gray(
          `${caps.freeMemoryGB}GB free / ${caps.totalMemoryGB}GB total (${caps.memoryUsagePercent}% used)`,
        ),
    );
    console.log(
      chalk.cyan("├─ ") +
        chalk.bold("Load:     ") +
        chalk.gray(`${caps.loadAverage.join(", ")}`),
    );
    console.log(
      chalk.cyan("├─ ") +
        chalk.bold("Limits:   ") +
        chalk.gray(
          `${caps.recommendedMaxTokens} max tokens / ${caps.recommendedMaxAgents} max agents`,
        ),
    );
    console.log(
      chalk.cyan("╰─────────────────────────────────────────────────\n"),
    );
  }

  private showTasks(): void {
    const taskManager = getTaskManager();
    const tasks = taskManager.listTasks();

    console.log(chalk.bold.cyan("\nRecent Tasks:\n"));

    if (tasks.length === 0) {
      console.log(chalk.gray("  No tasks yet"));
      return;
    }

    for (const task of tasks.slice(0, 10)) {
      const statusIcon =
        task.status === "completed"
          ? "[*]"
          : task.status === "failed"
            ? "[x]"
            : "[~]";
      const statusColor =
        task.status === "completed"
          ? chalk.green
          : task.status === "failed"
            ? chalk.red
            : chalk.yellow;
      console.log(chalk.gray(`  ${statusIcon} ${task.id}`));
      console.log(
        chalk.gray(
          `     ${task.description.slice(0, 50)}${task.description.length > 50 ? "..." : ""}`,
        ),
      );
      console.log(
        chalk.gray(
          `     ${new Date(task.createdAt).toLocaleString()} | ${statusColor(task.status)}`,
        ),
      );
      console.log("");
    }
  }

  private showHistory(): void {
    console.log(chalk.bold.cyan("\nCommand History:\n"));

    if (this.history.length === 0) {
      console.log(chalk.gray("  No commands yet"));
      return;
    }

    for (let i = 0; i < this.history.length; i++) {
      const item = this.history[i];
      console.log(chalk.gray(`  ${i + 1}. ${item.input}`));
      console.log(chalk.gray(`     ${item.timestamp.toLocaleTimeString()}`));
    }

    console.log("");
  }

  stop(): void {
    this.running = false;
  }
}

export async function startInteractiveMode(): Promise<void> {
  const mode = new InteractiveMode();
  await mode.start();
}
