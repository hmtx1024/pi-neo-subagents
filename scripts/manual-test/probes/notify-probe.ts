import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("notifyprobe", {
		description: "Probe whether ui.notify is visible in this output mode",
		handler: async (_args, ctx) => {
			ctx.ui.notify("NOTIFY-PROBE-VISIBLE", "info");
			pi.sendUserMessage("say: PROBE-MESSAGE-SENT");
		},
	});
}
