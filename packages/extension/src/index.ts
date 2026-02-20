import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { renderSession } from "./renderer.js";
import { generateTitle } from "./title.js";
import { buildPublishedSession } from "./transform.js";
import type { BranchEntry } from "./transform.js";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(extDir, "out");

const SHARE_VIEWER_URL =
  process.env.PI_PUBLISH_VIEWER_URL ?? "https://pi.dev/session/";

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  pi.registerCommand("publish", {
    description: "Publish the current session as a secret GitHub gist",
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

      // Check that the GitHub CLI is installed and authenticated
      const authCheck = await pi.exec("gh", ["auth", "status"], {
        timeout: 10_000,
      });

      if (authCheck.code !== 0) {
        const msg =
          authCheck.stderr.includes("not logged")
            ? "GitHub CLI is not logged in. Run `gh auth login` first."
            : "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/";
        ctx.ui.notify(msg, "error");
        return;
      }

      // Build the published-session payload
      const messages = branch
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);

      ctx.ui.notify("Generating title…", "info");
      const title = await generateTitle(
        messages as unknown as { role?: unknown; content?: unknown }[],
        ctx.model,
        ctx.modelRegistry,
      );

      const payload = buildPublishedSession(
        header!,
        branch as unknown as BranchEntry[],
        title,
      );

      const slug = header!.id.slice(0, 8);

      ctx.ui.notify("Rendering HTML…", "info");
      const html = await renderSession(payload);

      // Save a local copy
      await mkdir(outDir, { recursive: true });
      const localPath = join(outDir, `${slug}.html`);
      await writeFile(localPath, html, "utf8");

      // Write to a temp file for the gist upload.
      // The filename becomes the gist filename, so use "session.html"
      // to match the built-in /share convention.
      const tmpFile = join(tmpdir(), "session.html");
      await writeFile(tmpFile, html, "utf8");

      ctx.ui.notify("Creating gist…", "info");

      try {
        const result = await pi.exec(
          "gh",
          ["gist", "create", "--public=false", tmpFile],
          { timeout: 30_000 },
        );

        if (result.code !== 0) {
          const errorMsg = result.stderr.trim() || "Unknown error";
          ctx.ui.notify(`Failed to create gist: ${errorMsg}`, "error");
          return;
        }

        // gh returns the gist URL, e.g. https://gist.github.com/user/GIST_ID
        const gistUrl = result.stdout.trim();
        const gistId = gistUrl.split("/").pop();

        if (!gistId) {
          ctx.ui.notify("Failed to parse gist ID from gh output.", "error");
          return;
        }

        const viewerUrl = `${SHARE_VIEWER_URL}#${gistId}`;

        ctx.ui.notify(`Published → ${viewerUrl}`, "info");
      } finally {
        // Clean up the temp file regardless of success or failure
        await unlink(tmpFile).catch(() => {});
      }
    },
  });
}
