import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("publish", {
    description: "Share content",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Share requires an interactive session.");
        return;
      }

      ctx.ui.notify("Share extension loaded.");
    },
  });
}
