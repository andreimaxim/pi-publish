import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Marked, type Tokens } from "marked";

import type { PublishedSession, Step, ToolStep, Turn } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "template.html",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatElapsed(seconds: number): string {
  if (seconds < 1) return "< 1s";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

// ---------------------------------------------------------------------------
// Step rendering
// ---------------------------------------------------------------------------

function renderThinkingStep(text: string, md: Marked): string {
  return `<aside class="thinking">${md.parseInline(text) as string}</aside>`;
}

function renderTextStep(text: string, md: Marked): string {
  return `<section>${md.parse(text) as string}</section>`;
}

function renderToolStep(step: ToolStep, nextId: () => string): string {
  const status = step.ok ? "ok" : "error";
  const iconChar = step.ok ? "✓" : "✗";

  const args = step.args
    ? `\n  <code>${escapeHtml(step.args)}</code>`
    : "";

  const isCollapsibleBashOutput = step.name === "bash" && Boolean(step.output);
  const outputId = isCollapsibleBashOutput ? nextId() : undefined;
  const toggle = isCollapsibleBashOutput
    ? `\n  <button type="button" class="tool-toggle" data-tool-toggle aria-expanded="false" aria-controls="${outputId}">[+]</button>`
    : "";

  let html = `<div class="tool" data-status="${status}">
  <span aria-hidden="true">${iconChar}</span>
  <span class="tool-name">${escapeHtml(step.name)}</span>${args}${toggle}
</div>`;

  if (step.output) {
    if (isCollapsibleBashOutput && outputId) {
      html += `\n<pre id="${outputId}" class="tool-output" data-status="${status}" hidden>${escapeHtml(step.output)}</pre>`;
    } else {
      html += `\n<pre class="tool-output" data-status="${status}">${escapeHtml(step.output)}</pre>`;
    }
  }

  if (step.diff) {
    const data = JSON.stringify({
      path: step.diff.path,
      oldText: step.diff.oldText,
      newText: step.diff.newText,
    });
    html += `\n<div class="pierre-diff" data-diff="${escapeHtml(data)}"></div>`;
  }

  return html;
}

function renderStep(step: Step, md: Marked, nextId: () => string): string {
  switch (step.type) {
    case "thinking":
      return renderThinkingStep(step.text, md);
    case "text":
      return renderTextStep(step.text, md);
    case "tool":
      return renderToolStep(step, nextId);
  }
}

// ---------------------------------------------------------------------------
// Turn rendering
// ---------------------------------------------------------------------------

function renderTurn(
  turn: Turn,
  md: Marked,
  nextId: () => string,
): string {
  const prompt = `<section class="prompt">
  <p>${escapeHtml(turn.prompt)}</p>
</section>`;

  const steps = turn.steps
    .map((step) => renderStep(step, md, nextId))
    .join("\n");

  const meta = `<footer>
  <span>${escapeHtml(turn.model)}</span>
  <span>${formatElapsed(turn.elapsed)} · ${formatTokens(turn.inputTokens)} in · ${formatTokens(turn.outputTokens)} out</span>
</footer>`;

  return `<article>\n${prompt}\n<section class="response">\n${steps}\n${meta}\n</section>\n</article>`;
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

function buildPageContent(
  session: PublishedSession,
  turnHtmls: string[],
): string {
  const date = new Date(session.session.date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const title = session.session.title.trim() || "Shared session";

  const masthead = `<header>
  <time datetime="${escapeHtml(session.session.date)}">${escapeHtml(date)}</time>
  <h1>${escapeHtml(title)}</h1>
</header>`;

  const turns = `<ol>
${turnHtmls.map((turn) => `  <li>\n${turn}\n  </li>`).join("\n")}
</ol>`;

  const foot = `<footer>
  <span>pi session &middot; ${escapeHtml(session.session.id)}</span>
  <span>$${session.session.totalCost.toFixed(2)} total</span>
</footer>`;

  return `${masthead}\n${turns}\n${foot}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function renderSession(
  session: PublishedSession,
): Promise<string> {
  let idCounter = 0;
  const nextId = () => `block-${idCounter++}`;

  const md = new Marked();
  md.use({
    renderer: {
      code({ text, lang }: Tokens.Code): string {
        const id = nextId();
        return `<div id="${id}" class="pierre-code" data-lang="${escapeHtml(lang || "text")}"><pre><code>${escapeHtml(text)}</code></pre></div>`;
      },
    },
  });

  const turnHtmls = session.turns.map((turn) =>
    renderTurn(turn, md, nextId),
  );

  const content = buildPageContent(session, turnHtmls);
  const template = await readFile(TEMPLATE_PATH, "utf8");
  const pageTitle = session.session.title.trim() || "Shared session";

  return template
    .replace("{{TITLE}}", escapeHtml(pageTitle))
    .replace("{{CONTENT}}", content);
}
