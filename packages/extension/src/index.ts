import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { buildTrace } from "./transform.js";

const SERVER_URL = process.env.PI_PUBLISH_URL;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("publish", {
    description: "Publish the current session as a trace",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Publish requires an interactive session.", "error");
        return;
      }

      if (!SERVER_URL) {
        ctx.ui.notify(
          "PI_PUBLISH_URL is not set. Point it at your publish server.",
          "error",
        );
        return;
      }

      const header = ctx.sessionManager.getHeader();
      const branch = ctx.sessionManager.getBranch();

      if (branch.length === 0) {
        ctx.ui.notify("Nothing to publish — no conversation yet.", "warning");
        return;
      }

      const trace = buildTrace(
        header!,
        branch,
        "Untitled", // TODO: generate title
      );

      const url = `${SERVER_URL}/api/traces/${trace.id}`;

      ctx.ui.notify("Publishing…", "info");

      try {
        const response = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(trace),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
        }

        const viewerUrl = `${SERVER_URL}/t/${trace.id}`;
        ctx.ui.notify(`Published → ${viewerUrl}`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown network error";
        ctx.ui.notify(`Failed to publish: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("unpublish", {
    description: "Remove the current trace from the server",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Unpublish requires an interactive session.", "error");
        return;
      }

      if (!SERVER_URL) {
        ctx.ui.notify(
          "PI_PUBLISH_URL is not set. Point it at your publish server.",
          "error",
        );
        return;
      }

      const header = ctx.sessionManager.getHeader();
      if (!header) {
        ctx.ui.notify("No active session.", "warning");
        return;
      }

      const url = `${SERVER_URL}/api/traces/${header.id}`;

      ctx.ui.notify("Unpublishing…", "info");

      try {
        const response = await fetch(url, { method: "DELETE" });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
        }

        ctx.ui.notify("Trace unpublished.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown network error";
        ctx.ui.notify(`Failed to unpublish: ${msg}`, "error");
      }
    },
  });
}
