import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(extDir, "out");

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

      // Generate a title using the current model
      let title = "Shared session";
      const model = ctx.model;

      if (model) {
        const apiKey = await ctx.modelRegistry.getApiKey(model);

        if (apiKey) {
          ctx.ui.notify("Generating title…", "info");

          const conversationPreview = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .flatMap((m) => {
              if (typeof m.content === "string") return [m.content];
              if (Array.isArray(m.content)) {
                return m.content
                  .filter((c): c is { type: "text"; text: string } => c.type === "text")
                  .map((c) => c.text);
              }
              return [];
            })
            .join("\n")
            .slice(0, 4000);

          try {
            const response = await complete(
              model,
              {
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: [
                          "Generate a short, descriptive title (max 10 words) for this conversation.",
                          "Return ONLY the title text, nothing else.",
                          "",
                          "<conversation>",
                          conversationPreview,
                          "</conversation>",
                        ].join("\n"),
                      },
                    ],
                    timestamp: Date.now(),
                  },
                ],
              },
              { apiKey },
            );

            title = response.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("")
              .trim();
          } catch {
            ctx.ui.notify("Could not generate title, continuing without one.", "warning");
          }
        }
      }

      const payload = {
        session: {
          id: header.id,
          cwd: header.cwd,
          timestamp: header.timestamp,
          title,
        },
        messages,
      };

      const slug = header.id.slice(0, 8);
      const filename = `${slug}.json`;

      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, filename), JSON.stringify(payload, null, 2), "utf8");

      ctx.ui.notify(`Wrote ${filename}`, "info");
    },
  });
}
