import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildPublishedSession,
  titleFromFirstUserLine,
  shortenPath,
  summarizeToolArgs,
  extractTextContent,
  truncateOutput,
} from "../src/transform.ts";
import type { BranchEntry } from "../src/transform.ts";
import type { ThinkingLevel } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers for building test entries
// ---------------------------------------------------------------------------

let idSeq = 0;
function nextId(): string {
  return (idSeq++).toString(16).padStart(8, "0");
}

function resetIds(): void {
  idSeq = 0;
}

function makeHeader(
  overrides: Partial<{ id: string; cwd: string; timestamp: string }> = {},
) {
  return {
    id: overrides.id ?? "test-session-id",
    cwd: overrides.cwd ?? "/projects/myapp",
    timestamp: overrides.timestamp ?? "2026-02-17T18:00:00.000Z",
  };
}

function thinkingLevelEntry(
  level: ThinkingLevel,
  parentId: string | null,
): BranchEntry {
  const id = nextId();
  return {
    type: "thinking_level_change",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    thinkingLevel: level,
  };
}

function userEntry(
  text: string,
  parentId: string | null,
  ts: number = Date.now(),
): BranchEntry {
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
  };
}

function assistantEntry(
  blocks: Record<string, unknown>[],
  parentId: string | null,
  opts: {
    model?: string;
    usage?: { input?: number; output?: number; cost?: { total?: number } };
    ts?: number;
  } = {},
): BranchEntry {
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
      stopReason: "stop",
      timestamp: ts,
    },
  };
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
): BranchEntry {
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
  };
}

function modelChangeEntry(
  provider: string,
  modelId: string,
  parentId: string | null,
): BranchEntry {
  const id = nextId();
  return {
    type: "model_change",
    id,
    parentId,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests: buildPublishedSession – thinking level extraction
// ---------------------------------------------------------------------------

describe("buildPublishedSession", () => {
  describe("thinking level", () => {
    it("assigns thinking level from preceding thinking_level_change entry", () => {
      resetIds();
      const entries: BranchEntry[] = [
        thinkingLevelEntry("high", null),
        userEntry("hello", "00000000", 1000),
        assistantEntry(
          [{ type: "text", text: "hi" }],
          "00000001",
          { ts: 2000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns.length, 1);
      assert.equal(result.turns[0].thinkingLevel, "high");
    });

    it("tracks thinking level changes across multiple turns", () => {
      resetIds();
      const entries: BranchEntry[] = [
        thinkingLevelEntry("high", null),
        userEntry("first", "00000000", 1000),
        assistantEntry(
          [{ type: "text", text: "reply 1" }],
          "00000001",
          { ts: 2000 },
        ),
        thinkingLevelEntry("low", "00000002"),
        userEntry("second", "00000003", 3000),
        assistantEntry(
          [{ type: "text", text: "reply 2" }],
          "00000004",
          { ts: 4000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns.length, 2);
      assert.equal(result.turns[0].thinkingLevel, "high");
      assert.equal(result.turns[1].thinkingLevel, "low");
    });

    it("uses the last thinking level when multiple changes precede a turn", () => {
      resetIds();
      const entries: BranchEntry[] = [
        thinkingLevelEntry("high", null),
        thinkingLevelEntry("off", "00000000"),
        thinkingLevelEntry("xhigh", "00000001"),
        userEntry("hello", "00000002", 1000),
        assistantEntry(
          [{ type: "text", text: "hi" }],
          "00000003",
          { ts: 2000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns[0].thinkingLevel, "xhigh");
    });

    it("carries thinking level forward when no change between turns", () => {
      resetIds();
      const entries: BranchEntry[] = [
        thinkingLevelEntry("medium", null),
        userEntry("first", "00000000", 1000),
        assistantEntry(
          [{ type: "text", text: "r1" }],
          "00000001",
          { ts: 2000 },
        ),
        // no thinking_level_change here
        userEntry("second", "00000002", 3000),
        assistantEntry(
          [{ type: "text", text: "r2" }],
          "00000003",
          { ts: 4000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns[0].thinkingLevel, "medium");
      assert.equal(result.turns[1].thinkingLevel, "medium");
    });

    it("omits thinkingLevel when no thinking_level_change entries exist", () => {
      resetIds();
      const entries: BranchEntry[] = [
        userEntry("hello", null, 1000),
        assistantEntry(
          [{ type: "text", text: "hi" }],
          "00000000",
          { ts: 2000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns.length, 1);
      assert.equal(result.turns[0].thinkingLevel, undefined);
      assert.ok(!("thinkingLevel" in result.turns[0]));
    });

    it("handles thinking level change between assistant messages mid-turn", () => {
      // thinking_level_change between turns, not mid-turn (branch entries
      // are chronological — thinking level only changes between turns)
      resetIds();
      const entries: BranchEntry[] = [
        thinkingLevelEntry("xhigh", null),
        userEntry("start", "00000000", 1000),
        assistantEntry(
          [{ type: "text", text: "long response" }],
          "00000001",
          { ts: 5000 },
        ),
        thinkingLevelEntry("off", "00000002"),
        thinkingLevelEntry("minimal", "00000003"),
        thinkingLevelEntry("low", "00000004"),
        thinkingLevelEntry("medium", "00000005"),
        thinkingLevelEntry("high", "00000006"),
        userEntry("next", "00000007", 10000),
        assistantEntry(
          [{ type: "text", text: "shorter" }],
          "00000008",
          { ts: 11000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns[0].thinkingLevel, "xhigh");
      assert.equal(result.turns[1].thinkingLevel, "high");
    });

    it("handles all thinking levels", () => {
      resetIds();
      const levels: ThinkingLevel[] = [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ];
      const entries: BranchEntry[] = [];
      let parentId: string | null = null;

      for (const level of levels) {
        const tlEntry = thinkingLevelEntry(level, parentId);
        entries.push(tlEntry);
        parentId = tlEntry.id;

        const uEntry = userEntry(`prompt at ${level}`, parentId, 1000 + idSeq * 1000);
        entries.push(uEntry);
        parentId = uEntry.id;

        const aEntry = assistantEntry(
          [{ type: "text", text: `reply at ${level}` }],
          parentId,
          { ts: 2000 + idSeq * 1000 },
        );
        entries.push(aEntry);
        parentId = aEntry.id;
      }

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns.length, 6);
      for (let i = 0; i < levels.length; i++) {
        assert.equal(result.turns[i].thinkingLevel, levels[i]);
      }
    });
  });

  describe("turn splitting and step extraction", () => {
    it("splits turns at user messages", () => {
      resetIds();
      const entries: BranchEntry[] = [
        userEntry("first", null, 1000),
        assistantEntry(
          [{ type: "text", text: "r1" }],
          "00000000",
          { ts: 2000 },
        ),
        userEntry("second", "00000001", 3000),
        assistantEntry(
          [{ type: "text", text: "r2" }],
          "00000002",
          { ts: 4000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns.length, 2);
      assert.equal(result.turns[0].prompt, "first");
      assert.equal(result.turns[1].prompt, "second");
    });

    it("extracts thinking steps (strips whitespace-only)", () => {
      resetIds();
      const entries: BranchEntry[] = [
        userEntry("go", null, 1000),
        assistantEntry(
          [
            { type: "thinking", thinking: "let me think about this" },
            { type: "thinking", thinking: "   " },
            { type: "text", text: "done" },
          ],
          "00000000",
          { ts: 2000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns[0].steps.length, 2);
      assert.deepEqual(result.turns[0].steps[0], {
        type: "thinking",
        text: "let me think about this",
      });
      assert.deepEqual(result.turns[0].steps[1], { type: "text", text: "done" });
    });

    it("extracts tool steps and matches tool results", () => {
      resetIds();
      const entries: BranchEntry[] = [
        userEntry("read it", null, 1000),
        assistantEntry(
          [
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "/projects/myapp/src/main.ts" },
            },
          ],
          "00000000",
          { ts: 2000 },
        ),
        toolResultEntry("call-1", "read", "00000001", { ts: 3000 }),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns[0].steps.length, 1);
      const step = result.turns[0].steps[0];
      assert.equal(step.type, "tool");
      if (step.type === "tool") {
        assert.equal(step.name, "read");
        assert.equal(step.args, "src/main.ts");
        assert.equal(step.ok, true);
      }
    });

    it("includes output for errored tools", () => {
      resetIds();
      const entries: BranchEntry[] = [
        userEntry("run it", null, 1000),
        assistantEntry(
          [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "failing-cmd" },
            },
          ],
          "00000000",
          { ts: 2000 },
        ),
        toolResultEntry("call-1", "bash", "00000001", {
          isError: true,
          output: "command not found",
          ts: 3000,
        }),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      const step = result.turns[0].steps[0];
      assert.equal(step.type, "tool");
      if (step.type === "tool") {
        assert.equal(step.ok, false);
        assert.equal(step.output, "command not found");
      }
    });

    it("includes output for successful bash, omits for read/write/edit", () => {
      resetIds();
      const entries: BranchEntry[] = [
        userEntry("go", null, 1000),
        assistantEntry(
          [
            {
              type: "toolCall",
              id: "call-bash",
              name: "bash",
              arguments: { command: "ls" },
            },
            {
              type: "toolCall",
              id: "call-read",
              name: "read",
              arguments: { path: "/projects/myapp/f.ts" },
            },
          ],
          "00000000",
          { ts: 2000 },
        ),
        toolResultEntry("call-bash", "bash", "00000001", {
          output: "file1\nfile2",
          ts: 3000,
        }),
        toolResultEntry("call-read", "read", "00000002", {
          output: "contents of file",
          ts: 3000,
        }),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      const bashStep = result.turns[0].steps[0];
      const readStep = result.turns[0].steps[1];

      assert.equal(bashStep.type, "tool");
      assert.equal(readStep.type, "tool");
      if (bashStep.type === "tool") {
        assert.equal(bashStep.output, "file1\nfile2");
      }
      if (readStep.type === "tool") {
        assert.equal(readStep.output, undefined);
      }
    });

    it("carries diff data for edit tool steps", () => {
      resetIds();
      const entries: BranchEntry[] = [
        userEntry("edit it", null, 1000),
        assistantEntry(
          [
            {
              type: "toolCall",
              id: "call-1",
              name: "edit",
              arguments: {
                path: "/projects/myapp/src/main.ts",
                oldText: "foo",
                newText: "bar",
              },
            },
          ],
          "00000000",
          { ts: 2000 },
        ),
        toolResultEntry("call-1", "edit", "00000001", { ts: 3000 }),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      const step = result.turns[0].steps[0];
      assert.equal(step.type, "tool");
      if (step.type === "tool") {
        assert.deepEqual(step.diff, {
          path: "src/main.ts",
          oldText: "foo",
          newText: "bar",
        });
      }
    });

    it("aggregates tokens and cost across assistant messages in a turn", () => {
      resetIds();
      const entries: BranchEntry[] = [
        userEntry("go", null, 1000),
        assistantEntry(
          [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "echo 1" },
            },
          ],
          "00000000",
          { model: "claude-sonnet-4-5", usage: { input: 100, output: 50, cost: { total: 0.001 } }, ts: 2000 },
        ),
        toolResultEntry("call-1", "bash", "00000001", { ts: 2500 }),
        assistantEntry(
          [{ type: "text", text: "done" }],
          "00000002",
          { model: "claude-sonnet-4-5", usage: { input: 200, output: 80, cost: { total: 0.002 } }, ts: 3000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns[0].inputTokens, 300);
      assert.equal(result.turns[0].outputTokens, 130);
      assert.equal(result.turns[0].cost, 0.003);
    });

    it("skips non-message, non-thinking_level entries", () => {
      resetIds();
      const entries: BranchEntry[] = [
        modelChangeEntry("anthropic", "claude-sonnet-4-5", null),
        thinkingLevelEntry("high", "00000000"),
        userEntry("hi", "00000001", 1000),
        assistantEntry(
          [{ type: "text", text: "hello" }],
          "00000002",
          { ts: 2000 },
        ),
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.turns.length, 1);
      assert.equal(result.turns[0].thinkingLevel, "high");
    });
  });

  describe("session metadata", () => {
    it("computes totalCost as sum of turn costs", () => {
      resetIds();
      const entries: BranchEntry[] = [
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
      ];

      const result = buildPublishedSession(makeHeader(), entries, "test");
      assert.equal(result.session.totalCost, 0.03);
    });

    it("uses provided title and header fields", () => {
      resetIds();
      const header = makeHeader({
        id: "abc-123",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      const entries: BranchEntry[] = [
        userEntry("hi", null, 1000),
        assistantEntry(
          [{ type: "text", text: "yo" }],
          "00000000",
          { ts: 2000 },
        ),
      ];

      const result = buildPublishedSession(header, entries, "My Title");
      assert.equal(result.session.id, "abc-123");
      assert.equal(result.session.title, "My Title");
      assert.equal(result.session.date, "2026-01-01T00:00:00.000Z");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: titleFromFirstUserLine
// ---------------------------------------------------------------------------

describe("titleFromFirstUserLine", () => {
  it("extracts first line from first user message", () => {
    const title = titleFromFirstUserLine([
      {
        role: "user",
        content: [{ type: "text", text: "Hello world\nMore text" }],
      },
    ]);
    assert.equal(title, "Hello world");
  });

  it("truncates to 30 characters", () => {
    const title = titleFromFirstUserLine([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "This is a very long prompt that exceeds the thirty character limit",
          },
        ],
      },
    ]);
    assert.equal(title.length, 30);
  });

  it("handles string content", () => {
    const title = titleFromFirstUserLine([{ role: "user", content: "simple string" }]);
    assert.equal(title, "simple string");
  });

  it("returns default when no user messages", () => {
    const title = titleFromFirstUserLine([{ role: "assistant", content: "hi" }]);
    assert.equal(title, "Shared session");
  });

  it("skips assistant messages to find user", () => {
    const title = titleFromFirstUserLine([
      { role: "assistant", content: "ignored" },
      { role: "user", content: [{ type: "text", text: "Found it" }] },
    ]);
    assert.equal(title, "Found it");
  });
});

// ---------------------------------------------------------------------------
// Tests: shortenPath
// ---------------------------------------------------------------------------

describe("shortenPath", () => {
  it("strips cwd prefix", () => {
    assert.equal(shortenPath("/projects/myapp/src/main.ts", "/projects/myapp"), "src/main.ts");
  });

  it("returns '.' for exact cwd match", () => {
    assert.equal(shortenPath("/projects/myapp", "/projects/myapp"), ".");
  });

  it("returns full path when no prefix matches", () => {
    assert.equal(shortenPath("/tmp/random/file.ts", "/projects/myapp"), "/tmp/random/file.ts");
  });
});

// ---------------------------------------------------------------------------
// Tests: summarizeToolArgs
// ---------------------------------------------------------------------------

describe("summarizeToolArgs", () => {
  const cwd = "/projects/myapp";

  it("shortens path for read/write/edit", () => {
    assert.equal(summarizeToolArgs("read", { path: "/projects/myapp/src/a.ts" }, cwd), "src/a.ts");
    assert.equal(summarizeToolArgs("write", { path: "/projects/myapp/b.ts" }, cwd), "b.ts");
    assert.equal(summarizeToolArgs("edit", { path: "/projects/myapp/c.ts" }, cwd), "c.ts");
  });

  it("uses command for bash", () => {
    assert.equal(summarizeToolArgs("bash", { command: "ls -la" }, cwd), "ls -la");
  });

  it("JSON.stringifies unknown tools, truncated at 200", () => {
    const args = { key: "x".repeat(300) };
    const result = summarizeToolArgs("custom_tool", args, cwd);
    assert.ok(result.length <= 201); // 200 + "…"
    assert.ok(result.endsWith("…"));
  });
});

// ---------------------------------------------------------------------------
// Tests: extractTextContent
// ---------------------------------------------------------------------------

describe("extractTextContent", () => {
  it("joins text blocks", () => {
    const result = extractTextContent([
      { type: "text", text: "hello" },
      { type: "image" },
      { type: "text", text: "world" },
    ]);
    assert.equal(result, "hello\nworld");
  });

  it("returns empty for no text blocks", () => {
    assert.equal(extractTextContent([{ type: "image" }]), "");
  });
});

// ---------------------------------------------------------------------------
// Tests: truncateOutput
// ---------------------------------------------------------------------------

describe("truncateOutput", () => {
  it("returns short output unchanged", () => {
    assert.equal(truncateOutput("short"), "short");
  });

  it("truncates long output", () => {
    const long = "a".repeat(5000);
    const result = truncateOutput(long);
    assert.ok(result.length < long.length);
    assert.ok(result.endsWith("…[truncated]"));
  });
});
