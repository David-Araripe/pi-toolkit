// Peer-message gate: once a session has read messages from other agents (anyone
// but its own supervisor), actions that rely on a user grant (/rm-rights,
// /ssh-rights, /hpc) need a fresh user decision. A peer could otherwise ask a
// session holding a grant to act for it (confused deputy). Exposure lasts for
// the rest of the session, because the request stays in the context.
//
// State lives in the agent-comm extension and is reached through pi.events,
// since extensions do not share module state. Without agent-comm, no gate.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface Exposure {
	exposed: boolean;
	senders: string[];
	// The user already allowed this call, or everything until their next message.
	waived: boolean;
}

export const GATE_CHOICES = ["Allow once", "Allow until my next message", "Deny"] as const;

export async function peerGate(pi: ExtensionAPI, ctx: ExtensionContext, toolCallId: string, action: string): Promise<{ block: true; reason: string } | undefined> {
	let state: Exposure | undefined;
	pi.events?.emit("agent-comm:exposure-query", { toolCallId, reply: (value: Exposure) => { state = value; } });
	if (!state?.exposed || state.waived) return undefined;
	const from = state.senders.slice(0, 5).join(", ") || "another agent";
	const reason = `Blocked: ${action} relies on a user grant, and this session has read messages from other agents (${from}). Peer messages cannot use the user's grants.`;
	if (!ctx.hasUI) return { block: true, reason: `${reason} No user is attached to confirm it.` };
	const choice = await ctx.ui.select(`Peer messages are in this session's context (from ${from}). Allow this action that relies on your grant?\n\n${action}`, [...GATE_CHOICES]);
	if (choice === GATE_CHOICES[0] || choice === GATE_CHOICES[1]) {
		pi.events.emit("agent-comm:exposure-allow", { toolCallId, untilInput: choice === GATE_CHOICES[1] });
		return undefined;
	}
	return { block: true, reason: `${reason} The user denied it.` };
}
