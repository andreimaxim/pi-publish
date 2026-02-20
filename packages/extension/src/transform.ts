import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import type { PublishedSession, Step, ThinkingLevel, ToolStep, Turn } from "./types.js";

// --- Constants ---

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

// --- Helpers ---

export function shortenPath(fullPath: string, cwd: string): string {
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

export function summarizeToolArgs(
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

export function extractTextContent(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

export function titleFromFirstUserLine(
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

export function truncateOutput(output: string): string {
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

/**
 * A branch entry as returned by `sessionManager.getBranch()`.
 * We only access the fields we need; the actual objects carry more.
 */
export interface BranchEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  /** Present when type === "message" */
  message?: Record<string, unknown>;
  /** Present when type === "thinking_level_change" */
  thinkingLevel?: string;
}

export function buildPublishedSession(
  header: { id: string; cwd: string; timestamp: string },
  entries: BranchEntry[],
  title: string,
): PublishedSession {
  const cwd = header.cwd;

  // Collect all messages and index tool results by toolCallId for O(1) lookup
  const messages: Record<string, unknown>[] = [];
  const toolResults = new Map<string, Record<string, unknown>>();

  // Track thinking level as we walk entries chronologically.
  // Start with undefined — set when we encounter thinking_level_change entries.
  let currentThinkingLevel: ThinkingLevel | undefined;

  // Map: user message index in `messages` → thinking level active at that point
  const thinkingLevelAtUser = new Map<number, ThinkingLevel | undefined>();

  for (const entry of entries) {
    if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
      currentThinkingLevel = entry.thinkingLevel as ThinkingLevel;
    } else if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      if (msg.role === "user") {
        thinkingLevelAtUser.set(messages.length, currentThinkingLevel);
      }
      if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
        toolResults.set(msg.toolCallId, msg);
      }
      messages.push(msg);
    }
  }

  // Split into raw turns at each user message
  const rawTurns: { messages: Record<string, unknown>[]; userIndex: number }[] = [];
  let current: Record<string, unknown>[] = [];
  let currentUserIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (current.length > 0) {
        rawTurns.push({ messages: current, userIndex: currentUserIndex });
      }
      current = [msg];
      currentUserIndex = i;
    } else {
      current.push(msg);
    }
  }
  if (current.length > 0) {
    rawTurns.push({ messages: current, userIndex: currentUserIndex });
  }

  // Transform each raw turn
  const turns: Turn[] = [];
  let totalCost = 0;

  for (const rawTurn of rawTurns) {
    const userMsg = rawTurn.messages[0];
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

    // Thinking level active for this turn
    const thinkingLevel = thinkingLevelAtUser.get(rawTurn.userIndex);

    // Walk assistant messages, flatten content blocks into steps
    const steps: Step[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let model = "";

    for (const msg of rawTurn.messages) {
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
    for (const msg of rawTurn.messages) {
      const ts = msg.timestamp as number;
      if (ts > maxTs) maxTs = ts;
    }

    totalCost += cost;

    const turn: Turn = {
      prompt,
      steps,
      model,
      inputTokens,
      outputTokens,
      cost: roundCost(cost),
      elapsed: Math.round((maxTs - userTs) / 1000),
    };

    if (thinkingLevel !== undefined) {
      turn.thinkingLevel = thinkingLevel;
    }

    turns.push(turn);
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
