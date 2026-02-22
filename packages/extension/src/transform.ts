import type {
  Message,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type {
  SessionEntry,
  SessionMessageEntry,
  ThinkingLevelChangeEntry,
} from "@mariozechner/pi-coding-agent";

import type {
  Action,
  Completion,
  Metadata,
  Step,
  ThinkingLevel,
  Trace,
  Turn,
} from "./types.js";

// --- Text extraction ---

function textFrom(blocks: { type: string; text?: string }[]): string {
  return blocks
    .flatMap((b) => (b.type === "text" && b.text ? [b.text] : []))
    .join("\n");
}

function promptFrom(msg: UserMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return textFrom(msg.content);
}

// --- Building blocks ---

function buildCompletion(
  messages: Message[],
  toolResults: Map<string, ToolResultMessage>,
): Completion {
  const steps: Step[] = [];
  const responseParts: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;

    const hasToolCall = msg.content.some((b) => b.type === "toolCall");

    for (const block of msg.content) {
      switch (block.type) {
        case "thinking": {
          const text = block.thinking.trim();
          if (text) steps.push({ type: "narration", text });
          break;
        }
        case "text": {
          const text = block.text.trim();
          if (!text) break;

          if (hasToolCall) {
            steps.push({ type: "narration", text });
          } else {
            responseParts.push(text);
          }
          break;
        }
        case "toolCall": {
          const result = toolResults.get(block.id);

          const action: Action = {
            type: "action",
            name: block.name,
            args: block.arguments,
            ok: result ? !result.isError : true,
          };

          if (result) {
            const output = textFrom(result.content);
            if (output) action.output = output;
          }

          steps.push(action);
          break;
        }
      }
    }
  }

  return {
    steps,
    response: responseParts.join("\n\n"),
  };
}

function buildMetadata(
  prompt: UserMessage,
  messages: Message[],
  thinkingLevel: ThinkingLevel | undefined,
): Metadata {
  let model = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let maxTs = prompt.timestamp;

  for (const msg of messages) {
    if (msg.timestamp > maxTs) maxTs = msg.timestamp;

    if (msg.role === "assistant") {
      if (msg.model) model = msg.model;
      inputTokens += msg.usage.input;
      outputTokens += msg.usage.output;
      cost += msg.usage.cost.total;
    }
  }

  const metadata: Metadata = {
    model,
    inputTokens,
    outputTokens,
    cost,
    elapsed: Math.round((maxTs - prompt.timestamp) / 1000),
  };

  if (thinkingLevel !== undefined) {
    metadata.thinkingLevel = thinkingLevel;
  }

  return metadata;
}

// --- Trace building ---

export function buildTrace(
  header: { id: string; cwd: string; timestamp: string },
  entries: SessionEntry[],
  title: string,
): Trace {
  let currentThinkingLevel: ThinkingLevel | undefined;
  const toolResults = new Map<string, ToolResultMessage>();
  type RawTurn = { prompt: UserMessage; messages: Message[]; thinkingLevel: ThinkingLevel | undefined };
  const rawTurns: RawTurn[] = [];
  let current: RawTurn | undefined;

  for (const entry of entries) {
    if (entry.type === "thinking_level_change") {
      currentThinkingLevel = entry.thinkingLevel as ThinkingLevel;
      continue;
    }

    if (entry.type !== "message") continue;

    const msg = entry.message as Message;

    if (msg.role === "toolResult") {
      toolResults.set(msg.toolCallId, msg);
    }

    if (msg.role === "user") {
      current = { prompt: msg, messages: [], thinkingLevel: currentThinkingLevel };
      rawTurns.push(current);
    } else if (current) {
      current.messages.push(msg);
    }
  }

  const turns: Turn[] = rawTurns.map(({ prompt, messages, thinkingLevel }) => ({
    prompt: promptFrom(prompt),
    completion: buildCompletion(messages, toolResults),
    metadata: buildMetadata(prompt, messages, thinkingLevel),
  }));

  const totalCost = turns.reduce((sum, t) => sum + t.metadata.cost, 0);

  return {
    id: header.id,
    title,
    date: header.timestamp,
    totalCost,
    turns,
  };
}
