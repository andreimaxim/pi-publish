import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderSession } from "./renderer.js";
import type { PublishedSession, Step, ToolStep, Turn } from "./types.js";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(extDir, "out");

// --- Helpers ---

const MAX_TOOL_OUTPUT_BYTES = 4096;
const home = homedir();
const homeReal = (() => {
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
})();
const homePrefixes = home === homeReal ? [home] : [home, homeReal];

function shortenPath(fullPath: string, cwd: string): string {
  if (fullPath.startsWith(cwd + "/")) {
    return fullPath.slice(cwd.length + 1);
  }
  if (fullPath === cwd) {
    return ".";
  }

  for (const prefix of homePrefixes) {
    if (fullPath.startsWith(prefix + "/") || fullPath === prefix) {
      const segments = fullPath.slice(prefix.length + 1).split("/").filter(Boolean);
      if (segments.length <= 3) {
        return "~/" + segments.join("/");
      }
      return "~/.../" + segments.slice(-3).join("/");
    }
  }

  return fullPath;
}

function summarizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string {
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
      return args.path ? shortenPath(String(args.path), cwd) : "";
    case "bash":
      return args.command ? String(args.command) : "";
    default: {
      const str = JSON.stringify(args);
      return str.length > 200 ? str.slice(0, 200) + "…" : str;
    }
  }
}

function extractTextContent(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

function titleFromFirstUserLine(
  messages: { role?: unknown; content?: unknown }[],
): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = extractTextContent(msg.content as { type: string; text?: string }[]);
    }

    const firstLine = text.split("\n")[0]?.trim() ?? "";
    if (firstLine) return firstLine.slice(0, 30);
  }

  return "Shared session";
}

function truncateOutput(output: string): string {
  const bytes = Buffer.byteLength(output);
  if (bytes <= MAX_TOOL_OUTPUT_BYTES) return output;

  const truncated = Buffer.from(output)
    .subarray(0, MAX_TOOL_OUTPUT_BYTES)
    .toString("utf8");
  const lastNewline = truncated.lastIndexOf("\n");
  return (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) + "\n…[truncated]";
}

function roundCost(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// --- Transformation ---

function buildPublishedSession(
  header: { id: string; cwd: string; timestamp: string },
  messages: Record<string, unknown>[],
  title: string,
): PublishedSession {
  const cwd = header.cwd;

  // Index tool results by toolCallId for O(1) lookup
  const toolResults = new Map<string, Record<string, unknown>>();
  for (const msg of messages) {
    if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
      toolResults.set(msg.toolCallId, msg);
    }
  }

  // Split into raw turns at each user message
  const rawTurns: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (current.length > 0) rawTurns.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  if (current.length > 0) rawTurns.push(current);

  // Transform each raw turn
  const turns: Turn[] = [];
  let totalCost = 0;

  for (const rawTurn of rawTurns) {
    const userMsg = rawTurn[0];
    if (userMsg.role !== "user") continue;

    // Extract prompt text
    let prompt: string;
    if (typeof userMsg.content === "string") {
      prompt = userMsg.content;
    } else if (Array.isArray(userMsg.content)) {
      prompt = extractTextContent(userMsg.content as { type: string; text?: string }[]);
    } else {
      prompt = "";
    }

    // Walk assistant messages, flatten content blocks into steps
    const steps: Step[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let model = "";

    for (const msg of rawTurn) {
      if (msg.role !== "assistant") continue;

      if (typeof msg.model === "string" && msg.model) model = msg.model;

      const usage = msg.usage as
        | { input?: number; output?: number; cost?: { total?: number } }
        | undefined;
      if (usage) {
        inputTokens += usage.input ?? 0;
        outputTokens += usage.output ?? 0;
        cost += usage.cost?.total ?? 0;
      }

      const content = msg.content as { type: string; [k: string]: unknown }[] | undefined;
      if (!content) continue;

      for (const block of content) {
        if (block.type === "thinking") {
          const text = String(block.thinking ?? "").trim();
          if (text) steps.push({ type: "thinking", text });
        } else if (block.type === "text") {
          const text = String(block.text ?? "").trim();
          if (text) steps.push({ type: "text", text });
        } else if (block.type === "toolCall") {
          const toolCallId = String(block.id ?? "");
          const toolName = String(block.name ?? "");
          const args = (block.arguments ?? {}) as Record<string, unknown>;
          const result = toolResults.get(toolCallId);
          const isError = result ? Boolean(result.isError) : false;

          const step: ToolStep = {
            type: "tool",
            name: toolName,
            args: summarizeToolArgs(toolName, args, cwd),
            ok: !isError,
          };

          // Tool output: always for errors, bash success truncated, skip read/write/edit success
          if (result && (isError || toolName === "bash")) {
            const resultContent = result.content as { type: string; text?: string }[] | undefined;
            if (resultContent) {
              const output = extractTextContent(resultContent);
              if (output) step.output = truncateOutput(output);
            }
          }

          // Diff data for edit tools
          if (toolName === "edit" && args.path && args.oldText && args.newText) {
            step.diff = {
              path: shortenPath(String(args.path), cwd),
              oldText: String(args.oldText),
              newText: String(args.newText),
            };
          }

          steps.push(step);
        }
      }
    }

    // Elapsed: max timestamp in turn - user timestamp
    const userTs = userMsg.timestamp as number;
    let maxTs = userTs;
    for (const msg of rawTurn) {
      const ts = msg.timestamp as number;
      if (ts > maxTs) maxTs = ts;
    }

    totalCost += cost;

    turns.push({
      prompt,
      steps,
      model,
      inputTokens,
      outputTokens,
      cost: roundCost(cost),
      elapsed: Math.round((maxTs - userTs) / 1000),
    });
  }

  return {
    session: {
      id: header.id,
      title,
      date: header.timestamp,
      totalCost: roundCost(totalCost),
    },
    turns,
  };
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  pi.registerCommand("publish", {
    description: "Publish the current session to the web",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Publish requires an interactive session.", "error");
        return;
      }

      const header = ctx.sessionManager.getHeader();
      const branch = ctx.sessionManager.getBranch();

      if (branch.length === 0) {
        ctx.ui.notify("Nothing to publish — no conversation yet.", "warning");
        return;
      }

      const messages = branch
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);

      const title = titleFromFirstUserLine(
        messages as unknown as { role?: unknown; content?: unknown }[],
      );

      const payload = buildPublishedSession(
        header!,
        messages as unknown as Record<string, unknown>[],
        title,
      );

      const slug = header!.id.slice(0, 8);

      ctx.ui.notify("Rendering HTML…", "info");
      const html = await renderSession(payload);

      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, `${slug}.html`), html, "utf8");

      ctx.ui.notify(`Published → out/${slug}.html`, "info");
    },
  });
}
