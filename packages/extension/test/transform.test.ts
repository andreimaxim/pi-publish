import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { SessionEntry } from "@mariozechner/pi-coding-agent";

import { buildTrace } from "../src/transform.ts";
import type { ThinkingLevel } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

let idSeq = 0;
function nextId(): string {
  return (idSeq++).toString(16).padStart(8, "0");
}

const testHeader = {
  id: "test-session-id",
  cwd: "/projects/myapp",
  timestamp: "2026-02-17T18:00:00.000Z",
};

function thinkingLevelEntry(
  level: ThinkingLevel,
  parentId: string | null,
): SessionEntry {
  const id = nextId();
  return {
    type: "thinking_level_change",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    thinkingLevel: level,
  } as unknown as SessionEntry;
}

function userEntry(
  text: string,
  parentId: string | null,
  ts: number = Date.now(),
): SessionEntry {
  const id = nextId();
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: ts,
    },
  } as unknown as SessionEntry;
}

function assistantEntry(
  blocks: Record<string, unknown>[],
  parentId: string | null,
  opts: {
    model?: string;
    usage?: { input?: number; output?: number; cost?: { total?: number } };
    ts?: number;
  } = {},
): SessionEntry {
  const id = nextId();
  const ts = opts.ts ?? Date.now();
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: blocks,
      model: opts.model ?? "claude-sonnet-4-5",
      usage: opts.usage ?? { input: 100, output: 50, cost: { total: 0.001 } },
      timestamp: ts,
    },
  } as unknown as SessionEntry;
}

function toolResultEntry(
  toolCallId: string,
  toolName: string,
  parentId: string | null,
  opts: {
    isError?: boolean;
    output?: string;
    ts?: number;
  } = {},
): SessionEntry {
  const id = nextId();
  const ts = opts.ts ?? Date.now();
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: opts.output ? [{ type: "text", text: opts.output }] : [],
      isError: opts.isError ?? false,
      timestamp: ts,
    },
  } as unknown as SessionEntry;
}

// ---------------------------------------------------------------------------
// Turn splitting
// ---------------------------------------------------------------------------

describe("turn splitting", () => {
  beforeEach(() => {
    idSeq = 0;
  });

  it("splits at user messages", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("first", null, 1000),
        assistantEntry([{ type: "text", text: "r1" }], "00000000", { ts: 2000 }),
        userEntry("second", "00000001", 3000),
        assistantEntry([{ type: "text", text: "r2" }], "00000002", { ts: 4000 }),
      ],
      "Test",
    );

    assert.equal(trace.turns.length, 2);
    assert.equal(trace.turns[0].prompt, "first");
    assert.equal(trace.turns[1].prompt, "second");
  });

  it("tracks thinking level changes across turns", () => {
    const trace = buildTrace(
      testHeader,
      [
        thinkingLevelEntry("high", null),
        userEntry("first", "00000000", 1000),
        assistantEntry([{ type: "text", text: "r1" }], "00000001", { ts: 2000 }),
        thinkingLevelEntry("low", "00000002"),
        userEntry("second", "00000003", 3000),
        assistantEntry([{ type: "text", text: "r2" }], "00000004", { ts: 4000 }),
      ],
      "Test",
    );

    assert.equal(trace.turns[0].metadata.thinkingLevel, "high");
    assert.equal(trace.turns[1].metadata.thinkingLevel, "low");
  });

  it("carries thinking level forward when unchanged", () => {
    const trace = buildTrace(
      testHeader,
      [
        thinkingLevelEntry("medium", null),
        userEntry("first", "00000000", 1000),
        assistantEntry([{ type: "text", text: "r1" }], "00000001", { ts: 2000 }),
        userEntry("second", "00000002", 3000),
        assistantEntry([{ type: "text", text: "r2" }], "00000003", { ts: 4000 }),
      ],
      "Test",
    );

    assert.equal(trace.turns[0].metadata.thinkingLevel, "medium");
    assert.equal(trace.turns[1].metadata.thinkingLevel, "medium");
  });

  it("uses last thinking level when multiple changes precede a turn", () => {
    const trace = buildTrace(
      testHeader,
      [
        thinkingLevelEntry("high", null),
        thinkingLevelEntry("off", "00000000"),
        thinkingLevelEntry("xhigh", "00000001"),
        userEntry("hello", "00000002", 1000),
        assistantEntry([{ type: "text", text: "hi" }], "00000003", { ts: 2000 }),
      ],
      "Test",
    );

    assert.equal(trace.turns[0].metadata.thinkingLevel, "xhigh");
  });

  it("omits thinkingLevel when no thinking_level_change entries exist", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("hello", null, 1000),
        assistantEntry([{ type: "text", text: "hi" }], "00000000", { ts: 2000 }),
      ],
      "Test",
    );

    assert.ok(!("thinkingLevel" in trace.turns[0].metadata));
  });
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

describe("completion", () => {
  beforeEach(() => {
    idSeq = 0;
  });

  it("converts thinking blocks to narration steps", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "done" },
          ],
          "00000000",
          { ts: 2000 },
        ),
      ],
      "Test",
    );

    const { steps, response } = trace.turns[0].completion;
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0], { type: "narration", text: "let me think" });
    assert.equal(response, "done");
  });

  it("drops empty thinking blocks", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [
            { type: "thinking", thinking: "   " },
            { type: "text", text: "done" },
          ],
          "00000000",
          { ts: 2000 },
        ),
      ],
      "Test",
    );

    assert.equal(trace.turns[0].completion.steps.length, 0);
    assert.equal(trace.turns[0].completion.response, "done");
  });

  it("treats mid-stream text as narration when tool calls present", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [
            { type: "text", text: "Let me read that file" },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "/projects/myapp/f.ts" } },
          ],
          "00000000",
          { ts: 2000 },
        ),
        toolResultEntry("c1", "read", "00000001", { output: "contents", ts: 3000 }),
      ],
      "Test",
    );

    const { steps } = trace.turns[0].completion;
    assert.equal(steps.length, 2);
    assert.deepEqual(steps[0], { type: "narration", text: "Let me read that file" });
    assert.equal(steps[1].type, "action");
  });

  it("collects text-only assistant messages into response", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
          "00000000",
          { ts: 2000 },
        ),
        toolResultEntry("c1", "bash", "00000001", { output: "file1", ts: 3000 }),
        assistantEntry(
          [{ type: "text", text: "Here are the results." }],
          "00000002",
          { ts: 4000 },
        ),
      ],
      "Test",
    );

    assert.equal(trace.turns[0].completion.steps.length, 1);
    assert.equal(trace.turns[0].completion.response, "Here are the results.");
  });

  it("passes raw args on action steps", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/projects/myapp/src/main.ts" } }],
          "00000000",
          { ts: 2000 },
        ),
        toolResultEntry("call-1", "read", "00000001", { output: "contents", ts: 3000 }),
      ],
      "Test",
    );

    const action = trace.turns[0].completion.steps[0];
    assert.equal(action.type, "action");
    if (action.type === "action") {
      assert.equal(action.name, "read");
      assert.deepEqual(action.args, { path: "/projects/myapp/src/main.ts" });
      assert.equal(action.ok, true);
    }
  });

  it("includes output for all tool results", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [
            { type: "toolCall", id: "c-bash", name: "bash", arguments: { command: "ls" } },
            { type: "toolCall", id: "c-read", name: "read", arguments: { path: "/projects/myapp/f.ts" } },
          ],
          "00000000",
          { ts: 2000 },
        ),
        toolResultEntry("c-bash", "bash", "00000001", { output: "file1\nfile2", ts: 3000 }),
        toolResultEntry("c-read", "read", "00000002", { output: "file contents", ts: 3000 }),
      ],
      "Test",
    );

    const bash = trace.turns[0].completion.steps[0];
    const read = trace.turns[0].completion.steps[1];

    if (bash.type === "action") assert.equal(bash.output, "file1\nfile2");
    if (read.type === "action") assert.equal(read.output, "file contents");
  });

  it("marks errored actions", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "bad-cmd" } }],
          "00000000",
          { ts: 2000 },
        ),
        toolResultEntry("call-1", "bash", "00000001", {
          isError: true,
          output: "command not found",
          ts: 3000,
        }),
      ],
      "Test",
    );

    const action = trace.turns[0].completion.steps[0];
    if (action.type === "action") {
      assert.equal(action.ok, false);
      assert.equal(action.output, "command not found");
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("metadata", () => {
  beforeEach(() => {
    idSeq = 0;
  });

  it("aggregates tokens and cost across assistant messages", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo 1" } }],
          "00000000",
          { model: "claude-sonnet-4-5", usage: { input: 100, output: 50, cost: { total: 0.001 } }, ts: 2000 },
        ),
        toolResultEntry("c1", "bash", "00000001", { ts: 2500 }),
        assistantEntry(
          [{ type: "text", text: "done" }],
          "00000002",
          { model: "claude-sonnet-4-5", usage: { input: 200, output: 80, cost: { total: 0.002 } }, ts: 3000 },
        ),
      ],
      "Test",
    );

    const { metadata } = trace.turns[0];
    assert.equal(metadata.inputTokens, 300);
    assert.equal(metadata.outputTokens, 130);
    assert.equal(metadata.cost, 0.003);
    assert.equal(metadata.model, "claude-sonnet-4-5");
  });

  it("computes elapsed from prompt to last message", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
          "00000000",
          { ts: 5000 },
        ),
        toolResultEntry("c1", "bash", "00000001", { ts: 8000 }),
        assistantEntry(
          [{ type: "text", text: "done" }],
          "00000002",
          { ts: 10000 },
        ),
      ],
      "Test",
    );

    assert.equal(trace.turns[0].metadata.elapsed, 9);
  });

  it("uses last model seen", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("go", null, 1000),
        assistantEntry(
          [{ type: "text", text: "a" }],
          "00000000",
          { model: "model-a", ts: 2000 },
        ),
        userEntry("more", "00000001", 3000),
        assistantEntry(
          [{ type: "text", text: "b" }],
          "00000002",
          { model: "model-b", ts: 4000 },
        ),
      ],
      "Test",
    );

    assert.equal(trace.turns[0].metadata.model, "model-a");
    assert.equal(trace.turns[1].metadata.model, "model-b");
  });
});

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

describe("trace", () => {
  beforeEach(() => {
    idSeq = 0;
  });

  it("computes totalCost as sum of turn costs", () => {
    const trace = buildTrace(
      testHeader,
      [
        userEntry("first", null, 1000),
        assistantEntry(
          [{ type: "text", text: "r1" }],
          "00000000",
          { usage: { input: 10, output: 5, cost: { total: 0.01 } }, ts: 2000 },
        ),
        userEntry("second", "00000001", 3000),
        assistantEntry(
          [{ type: "text", text: "r2" }],
          "00000002",
          { usage: { input: 20, output: 10, cost: { total: 0.02 } }, ts: 4000 },
        ),
      ],
      "Test",
    );

    assert.equal(trace.totalCost, 0.03);
  });

  it("uses provided title and header fields", () => {
    const trace = buildTrace(
      { id: "abc-123", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" },
      [
        userEntry("hi", null, 1000),
        assistantEntry([{ type: "text", text: "yo" }], "00000000", { ts: 2000 }),
      ],
      "My Title",
    );

    assert.equal(trace.id, "abc-123");
    assert.equal(trace.title, "My Title");
    assert.equal(trace.date, "2026-01-01T00:00:00.000Z");
  });
});
