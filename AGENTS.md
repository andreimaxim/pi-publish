# Publish Extension for Pi

This is a monorepo containing a **Pi coding agent extension** and a **Cloudflare Workers server** for publishing and viewing shared Pi sessions.

## Project Structure

```
packages/
  extension/          Pi agent extension — registers the /publish command
    src/index.ts      Entry point
    package.json
    tsconfig.json
  server/             Cloudflare Workers server — renders published sessions
    src/index.ts      Worker entry point
    package.json
    tsconfig.json
    wrangler.jsonc    Cloudflare Workers config
sample/               Sample Pi session JSONL file (for reference/testing)
out/                  Generated JSON files from /publish (gitignored)
design/               HTML mockup of the rendered session page
package.json          Workspace root (npm workspaces)
AGENTS.md
```

| Workspace | Package name | Purpose |
| --------- | ------------ | ------- |
| `packages/extension` | `@andreimaxim/pi-publish-extension` | Pi extension: extracts session data, publishes to server |
| `packages/server` | `@andreimaxim/pi-publish-server` | Cloudflare Worker: stores + renders published sessions |

## TypeScript

This project uses **tsgo** (`@typescript/native-preview`) for type checking. Run from the repo root:

```bash
npx tsgo -p packages/extension/tsconfig.json
npx tsgo -p packages/server/tsconfig.json
```

## Pi Documentation

All Pi documentation lives inside the installed npm package:

| Topic              | Path                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Main README**    | `/var/home/andrei/.local/share/mise/installs/node/24.13.0/lib/node_modules/@mariozechner/pi-coding-agent/README.md`            |
| **Extensions**     | `/var/home/andrei/.local/share/mise/installs/node/24.13.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`   |
| **TUI Components** | `/var/home/andrei/.local/share/mise/installs/node/24.13.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`          |
| **Themes**         | `/var/home/andrei/.local/share/mise/installs/node/24.13.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/themes.md`       |
| **Skills**         | `/var/home/andrei/.local/share/mise/installs/node/24.13.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/skills.md`       |
| **Sessions**       | `/var/home/andrei/.local/share/mise/installs/node/24.13.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`      |
| **All docs**       | `/var/home/andrei/.local/share/mise/installs/node/24.13.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/`                |
| **Examples**       | `/var/home/andrei/.local/share/mise/installs/node/24.13.0/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/` |

**Always read `extensions.md` before modifying extension code.** It covers the full extension API: events, tools, commands, UI methods, state management, and rendering. Cross-reference `tui.md` when working on components.

## How Pi Extensions Work

An extension is a TypeScript file (or directory with `index.ts`) that exports a default function receiving `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    /* ... */
  });
  pi.registerCommand("name", {
    description: "...",
    handler: async (args, ctx) => {
      /* ... */
    },
  });
  pi.registerTool({ name: "tool_name" /* ... */ });
}
```

Extensions are auto-discovered from:

- `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts` — global
- `.pi/extensions/*.ts` or `.pi/extensions/*/index.ts` — project-local

TypeScript works without compilation (loaded via [jiti](https://github.com/unjs/jiti)). Hot-reload with `/reload`.

## Key APIs Used by the Extension

- **`pi.registerCommand()`** — Registers the `/publish` and `/unpublish` slash commands.
- **`ctx.sessionManager.getHeader()`** — Session metadata (id, cwd, timestamp). Returns `SessionHeader | null`.
- **`ctx.sessionManager.getBranch()`** — Current branch entries from leaf to root.
- **`ctx.hasUI`** — Guards against running in non-interactive modes (print, JSON).
- **`ctx.ui.notify()`** — Shows toast notifications.
- **`ctx.model` / `ctx.modelRegistry.getApiKey()`** — Access current model for title generation.
- **`complete()` from `@mariozechner/pi-ai`** — Direct LLM calls (used for title generation).

## Server API Contract

The extension talks to a self-hosted server (Cloudflare Worker) via HTTP. The server URL is configured via `PI_PUBLISH_URL` (no default — must be set).

| Action | Method | Endpoint | Body |
|---|---|---|---|
| Publish | `PUT` | `/api/sessions/:id` | `PublishedSession` JSON |
| Unpublish | `DELETE` | `/api/sessions/:id` | — |
| View (HTML) | `GET` | `/s/:id` | — |

The session UUID is the key for all operations.

## Published Session JSON Schema

The extension transforms a Pi session branch into a structured JSON document optimized for client-side hydration. The server injects this JSON into an HTML template; client-side JS renders it.

```typescript
interface PublishedSession {
  session: {
    id: string;           // session UUID
    title: string;        // LLM-generated
    date: string;         // ISO 8601
    totalCost: number;    // sum of all turn costs
  };
  turns: Turn[];
}

interface Turn {
  prompt: string;         // user's text
  steps: Step[];          // ordered rendering primitives
  model: string;          // model used for this turn
  inputTokens: number;    // aggregated across agent loop
  outputTokens: number;   // aggregated across agent loop
  cost: number;           // aggregated across agent loop
  elapsed: number;        // seconds (from message timestamps)
}

type Step = ThinkingStep | TextStep | ToolStep;

interface ThinkingStep {
  type: "thinking";
  text: string;
}

interface TextStep {
  type: "text";
  text: string;           // markdown
}

interface ToolStep {
  type: "tool";
  name: string;           // "read", "bash", "write", "edit", etc.
  args: string;           // summarized: relative path, command, etc.
  ok: boolean;            // !isError from matched toolResult
  output?: string;        // errors always; bash success truncated (4KB); read/write/edit success omitted
  diff?: {                // edit tool only — for @pierre/diffs rendering
    path: string;         // relative, for language detection
    oldText: string;
    newText: string;
  };
}
```

### Transformation Rules

| Source | Rule |
|---|---|
| **Turn boundary** | Split at each `user` message |
| **Thinking step** | From `thinking` content blocks; `thinkingSignature` stripped; whitespace-only dropped |
| **Text step** | From non-empty `text` content blocks; whitespace-only (`"\n\n"`) dropped |
| **Tool step** | Merge `toolCall` block + matched `toolResult` message by `toolCallId` |
| **Tool args** | `read`/`write`/`edit`: relative path; `bash`: command; others: `JSON.stringify` truncated to 200 chars |
| **Tool output** | Errors: always. `bash` success: included, truncated to 4KB. `read`/`write`/`edit` success: omitted |
| **Tool diff** | `edit` only: carry `path`, `oldText`, `newText` from tool call arguments |
| **Path shortening** | Strip session cwd prefix → relative. External home paths: `~/.../last/3/segments`. Handles `/home` ↔ `/var/home` symlinks |
| **Token/cost aggregation** | Sum `usage.input`, `usage.output`, `usage.cost.total` across all assistant messages in turn |
| **Elapsed** | `max(all message timestamps in turn) - user message timestamp`, in seconds. Captures tool-loop time but not final LLM streaming |
| **Total cost** | Sum of all turn costs |

## Diff Rendering with @pierre/diffs

The server-side HTML will use [Pierre Computer's diffs library](https://diffs.com) (`@pierre/diffs`) for rendering code diffs. The library lives at `~/Code/pierrecomputer/pierre/packages/diffs/`.

The `diff` field on `edit` tool steps carries `oldText`, `newText`, and `path`. Client-side JS feeds these to `parseDiffFromFile()`:

```typescript
import { parseDiffFromFile } from "@pierre/diffs";

const fileDiff = parseDiffFromFile(
  { name: step.diff.path, contents: step.diff.oldText },
  { name: step.diff.path, contents: step.diff.newText },
);
// Render with FileDiff component
```

The `path` field provides the filename for Shiki syntax highlighting language detection.

## Design Reference

`design/index.html` is a self-contained HTML mockup of the rendered session page. Key visual elements:

- **Masthead**: date + LLM-generated title
- **Turns**: user prompt (`.prompt`, green caret) → assistant response (`.response`)
- **Response steps**: thinking (`.thinking`, italic), tool calls (`.tool-row` with ✓/✗), tool output (`.tool-output`), text (`.resp-text`, markdown)
- **Response meta**: model name + token stats per turn
- **Footer**: session ID + total cost
- **Theme**: dark terminal (JetBrains Mono, `--bg: #111111`)

The server will serve a static HTML template with embedded CSS/JS. The published session JSON is injected as hydration data; client-side JS iterates `turns` → `steps` and renders the components.

## Guidelines for Modifying This Project

### Extension (`packages/extension`)
1. **Read the docs first.** Load `extensions.md` and `tui.md` before making changes.
2. **Type-check with tsgo.** Run `npx tsgo -p packages/extension/tsconfig.json` before committing.
3. **Keep output truncated.** Tool output is capped at 4KB. If adding new tool types, decide on output inclusion rules.
4. **Handle cancellation.** All async work should respect `AbortSignal`.
5. **Test interactively.** Run `pi` and type `/publish` or `/unpublish` to verify changes. Use `/reload` to pick up modifications without restarting.
6. **Note on `getHeader()`**: Returns `SessionHeader | null`. The extension uses `!` assertions after the `branch.length === 0` early-return guard.
7. **`PI_PUBLISH_URL` must be set.** Both commands bail early with a notification if it's missing.

### Server (`packages/server`)
1. **Use `wrangler dev`** (or `npm run dev:server` from root) for local development.
2. **Deploy with `wrangler deploy`** (or `npm run deploy:server` from root).
3. **Keep the Worker stateless** — use KV or R2 for persistence when needed.
4. **The server receives JSON, injects into HTML template.** Client-side JS + `@pierre/diffs` handles rendering. The server does not parse or transform the session data.
