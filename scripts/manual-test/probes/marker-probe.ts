import { writeFileSync, appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_e, ctx) => {
		appendFileSync("probe-events.log", `session_start mode=${ctx.mode} hasUI=${ctx.hasUI}\n`);
	});
	pi.registerCommand("marker", {
		description: "Writes a marker file when the command is dispatched",
		handler: async (args, ctx) => {
			appendFileSync("probe-events.log", `command ran args="${args}" mode=${ctx.mode} hasUI=${ctx.hasUI}\n`);
			ctx.ui.notify("MARKER-NOTIFY", "info");
		},
	});
}
