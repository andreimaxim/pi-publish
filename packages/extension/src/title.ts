import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";

import { extractTextContent, titleFromFirstUserLine } from "./transform.js";

const SYSTEM_PROMPT =
  "Summarize this session in 6 words or fewer. Reply with only the title, no markdown, no quotes, no punctuation at the end.";
const TIMEOUT_MS = 10_000;

/**
 * Extract user prompts from messages as a single string.
 */
function collectUserPrompts(
  messages: { role?: unknown; content?: unknown }[],
): string {
  const prompts: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "user") continue;

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = extractTextContent(
        msg.content as { type: string; text?: string }[],
      );
    }

    const trimmed = text.trim();
    if (trimmed) prompts.push(trimmed);
  }

  return prompts.join("\n\n");
}

/**
 * Generate a session title using the current model.
 * Falls back to first-line truncation on any failure.
 */
export async function generateTitle(
  messages: { role?: unknown; content?: unknown }[],
  model: Model<Api> | undefined,
  modelRegistry: ModelRegistry,
): Promise<string> {
  const fallback = titleFromFirstUserLine(messages);

  if (!model) return fallback;

  try {
    const apiKey = await modelRegistry.getApiKey(model);
    if (!apiKey) return fallback;

    const userText = collectUserPrompts(messages);
    if (!userText) return fallback;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await completeSimple(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user" as const, content: userText, timestamp: Date.now() }],
        },
        { apiKey, signal: controller.signal },
      );

      const raw = response.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { type: "text"; text: string }).text)
        .join("")
        .trim();

      // Strip markdown artifacts the model might add
      const title = raw
        .replace(/^#+\s*/, "")   // leading # headings
        .replace(/^["'`]+|["'`]+$/g, "") // surrounding quotes
        .replace(/\.+$/, "")     // trailing periods
        .trim();

      return title || fallback;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return fallback;
  }
}
