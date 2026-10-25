import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pong", {
		description: "Checks whether sendUserMessage from a command produces output in this mode",
		handler: async (_args, ctx) => {
			appendFileSync("probe-events.log", `pong ran mode=${ctx.mode} hasUI=${ctx.hasUI}\n`);
			pi.sendUserMessage("Reply with ONLY the word PONG");
		},
	});
}
