import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HOME_DIR = homedir();
const SSH_DIR = resolve(HOME_DIR, ".ssh");
// Default macOS and Windows file systems are case-insensitive, so ~/.SSH is ~/.ssh.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
// Tools that run a shell command. `powershell` is Pi's optional native-Windows tool.
const SHELL_TOOLS = new Set(["bash", "powershell", "hpc_exec"]);

const REMOVAL_BLOCKED = "Do not remove, delete, unlink, shred, trash, or clean up files or directories with tools. If removal is needed, ask the user to run /rm-rights and confirm, or to remove it manually.";
const REMOVAL_ALLOWED = "The user enabled /rm-rights for this session. You may remove files or directories only when explicitly requested by the user. This is not permission for unrelated cleanup. SSH protections remain active. Never enable removal rights yourself; only the user may do so. Remind the user to run /rm-rights off when finished.";

const SSH_ALLOWED = "The user enabled /ssh-rights for this session. On this machine you may read and edit ~/.ssh, run SSH key tools, and invoke ssh, scp, sftp, or mosh directly, only for the SSH task the user requested. Never print private key material into the conversation. Removing files under ~/.ssh still requires /rm-rights. Remote .ssh directories on /hpc hosts stay blocked. Never enable SSH rights yourself; only the user may do so. Remind the user to run /ssh-rights off when finished.";
const SSH_BLOCKED = `Do not read, list, search, inspect, edit, write, or otherwise expose anything inside the user's ~/.ssh directory, including file names and SSH config. If SSH information is needed, ask the user directly, or ask them to run /ssh-rights.
- Do not invoke ssh, scp, sftp, or mosh directly with bash or hpc_exec. The user must authorize HPC access with /hpc allow <host> or /hpc <host>. Use hpc_exec and hpc_transfer for authorized hosts; the extension may use credentials internally without exposing them. Authorization is separate from workspace routing and survives /hpc local, but not revocation or session reset.`;

const SAFETY_INSTRUCTIONS = `# Local safety guard

These rules are enforced by a Pi extension and must be followed proactively:

- {{REMOVAL_POLICY}}
- {{SSH_POLICY}}`;

// Command position: start, a separator, a shell keyword, or a PowerShell block.
const COMMAND_START = String.raw`(?:^|[;&|()}\n]|(?<!\$)\{|\b(?:if|then|do|else|while|until)\b)\s*`;
// Wrappers that still run the next word as a command (Unix, PowerShell, cmd.exe).
const COMMAND_PREFIXES = String.raw`(?:(?:sudo|doas|command|builtin|exec|wsl(?:\.exe)?|start-process|cmd(?:\.exe)?\s+\/[ck])\s+|env\s+(?:\S+=\S+\s+)*|&\s*)*`;
// An optional quoted or path-qualified executable, e.g. C:\Windows\System32\OpenSSH\ssh.exe
// or 'C:/Program Files/Git/usr/bin/scp.exe'.
const EXECUTABLE_PATH = String.raw`(?:["'][^"'\n]*[\\/]|["']?(?:[^\s;&|()"']*[\\/])?)`;
const commandPattern = (names: string) => new RegExp(String.raw`${COMMAND_START}${COMMAND_PREFIXES}${EXECUTABLE_PATH}(?:${names})(?:\.exe)?\b`, "i");

const DIRECT_REMOTE_CLIENT_PATTERN = commandPattern("ssh|scp|sftp|mosh");

const REMOVAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	// del, erase, rd and ri are cmd.exe built-ins or PowerShell aliases.
	{ pattern: commandPattern("rm|unlink|rmdir|shred|trash|gtrash|del|erase|rd|ri"), label: "file removal command" },
	{ pattern: /\bremove-item\b/i, label: "PowerShell Remove-Item" },
	{ pattern: /\[(?:system\.)?io\.(?:file|directory)\]::delete\b/i, label: ".NET file deletion" },
	{ pattern: /\brobocopy\b[\s\S]*\s\/(?:mir|purge)\b/i, label: "robocopy /MIR or /PURGE" },
	{ pattern: /\bxargs\b[\s\S]*\b(?:rm|unlink|rmdir|shred|trash|gtrash)\b/i, label: "xargs removal command" },
	{ pattern: /\bfind\b[\s\S]*(?:\s-delete\b|\s-exec\s+(?:rm|unlink|rmdir|shred)\b)/i, label: "find deletion" },
	{ pattern: /(^|[;&|()\n])\s*git\s+clean\b/i, label: "git clean" },
	{ pattern: /(^|[;&|()\n])\s*git\s+reset\s+--hard\b/i, label: "git reset --hard" },
	{ pattern: /\brsync\b[\s\S]*\s--delete(?:[=\s]|$)/i, label: "rsync --delete" },
	{
		pattern: /\b(?:python3?|node|ruby|perl)\b[\s\S]*\b(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree|fs\.(?:rm|unlink|rmdir)|FileUtils\.rm|File\.delete|unlink\s*\()/i,
		label: "scripted file removal",
	},
];

function notify(ctx: ExtensionContext, message: string) {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

function block(ctx: ExtensionContext, reason: string) {
	notify(ctx, reason);
	return { block: true as const, reason };
}

function stripPathDecorations(path: string): string {
	return path.trim().replace(/^@/, "");
}

// Home spellings in Bash, PowerShell, and cmd.exe.
const HOME_SPELLING = String.raw`(?:~|\$HOME|\$\{HOME\}|\$env:(?:HOME|USERPROFILE)|%USERPROFILE%|%HOME%)`;
const HOME_REFERENCE = new RegExp(`^${HOME_SPELLING}(?=[\\\\/]|$)`, "i");
const HOME_REFERENCE_ANYWHERE = new RegExp(`(^|[\\s"'=(:])${HOME_SPELLING}(?=[\\\\/])`, "gi");

function expandHome(path: string): string {
	return path.replace(HOME_REFERENCE, HOME_DIR);
}

function foldPath(path: string): string {
	return CASE_INSENSITIVE_FS ? path.toLowerCase() : path;
}

function resolveInputPath(path: string | undefined, cwd: string, defaultPath = "."): string {
	const raw = stripPathDecorations(path?.trim() ? path : defaultPath);
	const expanded = expandHome(raw);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function isSameOrInside(path: string, directory: string): boolean {
	const rel = relative(foldPath(directory), foldPath(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathIsInsideSsh(path: string | undefined, cwd: string): boolean {
	return isSameOrInside(resolveInputPath(path, cwd), SSH_DIR);
}

function recursiveRootCouldReachSsh(path: string | undefined, cwd: string): boolean {
	const root = resolveInputPath(path, cwd);
	return isSameOrInside(root, SSH_DIR) || isSameOrInside(SSH_DIR, root);
}

function commandMentionsSshDir(command: string): boolean {
	const normalized = command
		.replace(/\$\{HOME\}/g, HOME_DIR)
		.replace(/\$HOME\b/g, HOME_DIR)
		.replace(HOME_REFERENCE_ANYWHERE, `$1${HOME_DIR}`);

	// Compare with one separator style so C:\Users\me\.ssh and C:/Users/me/.ssh match.
	const slashes = (value: string) => foldPath(value).replace(/\\/g, "/");
	if (slashes(normalized).includes(slashes(SSH_DIR))) return true;

	// Conservative fallback for relative references such as `.ssh/config` or `.ssh\config`.
	return /(^|[^A-Za-z0-9_.-])\.ssh(?:[\\/\s"'`$;)&|]|$)/i.test(command);
}

function removalReason(command: string): string | undefined {
	const match = REMOVAL_PATTERNS.find(({ pattern }) => pattern.test(command));
	return match?.label;
}

// Shared by remote execution so changing tools does not bypass shell safeguards.
export function shellSafetyReason(command: string, allowRemoval = false, allowSsh = false): string | undefined {
	const removal = removalReason(command);
	if (removal && !allowRemoval) return `Blocked ${removal}. Ask the user to run /rm-rights and confirm, or to remove it manually.`;
	if (allowSsh) return undefined;
	if (commandMentionsSshDir(command)) return "Blocked access to SSH configuration or key material; ask the user directly instead.";
	if (DIRECT_REMOTE_CLIENT_PATTERN.test(command)) return "Blocked direct SSH client use. Use hpc_exec or hpc_transfer for a user-authorized host.";
	return undefined;
}

export default function safetyGuardExtension(pi: ExtensionAPI) {
	// Runtime-only: never restore authorization from settings or session history.
	let removalAllowed = false;
	let generation = 0;
	let sshAllowed = false;
	let sshGeneration = 0;

	// A synchronous query avoids sharing module globals across Pi's isolated loaders.
	pi.events?.on("safety-guard:removal-rights-query", (request: { reply: (allowed: boolean) => void }) => {
		request.reply(removalAllowed);
	});

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("rm-rights", removalAllowed ? "rm-rights: ON" : undefined);
		ctx.ui.setStatus("ssh-rights", sshAllowed ? "ssh-rights: ON" : undefined);
	}

	function resetSshRights(ctx: ExtensionContext) {
		sshGeneration += 1;
		sshAllowed = false;
		updateStatus(ctx);
	}

	function resetRights(ctx: ExtensionContext) {
		generation += 1;
		removalAllowed = false;
		resetSshRights(ctx);
	}

	pi.on("session_start", (_event, ctx) => resetRights(ctx));
	pi.on("session_shutdown", (_event, ctx) => resetRights(ctx));

	pi.registerCommand("rm-rights", {
		description: "Grant session-only file removal permission; off revokes, status reports",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "off") {
				resetRights(ctx);
				notify(ctx, "File removal rights revoked.");
				return;
			}
			if (action === "status") {
				notify(ctx, `File removal rights: ${removalAllowed ? "ON" : "OFF"}.`);
				return;
			}
			if (action !== "" && action !== "on") {
				notify(ctx, "Usage: /rm-rights [on|off|status]");
				return;
			}
			if (!ctx.hasUI) return; // Fail closed without user confirmation UI.
			if (removalAllowed) {
				notify(ctx, "File removal rights already enabled. Use /rm-rights off to revoke.");
				return;
			}
			const requestedGeneration = generation;
			const confirmed = await ctx.ui.confirm("Enable file removal rights?",
				"The agent may run destructive commands locally or on an authorized HPC host for removals you explicitly request, without per-operation confirmation. This permission is session-wide, not path-scoped. SSH protections remain active. Use /rm-rights off to revoke; reload, restart, and session replacement reset it.");
			if (!confirmed || generation !== requestedGeneration) return;
			removalAllowed = true;
			updateStatus(ctx);
			notify(ctx, "File removal rights enabled for this session. Use /rm-rights off when finished.");
		},
	});

	pi.registerCommand("ssh-rights", {
		description: "Grant session-only access to local ~/.ssh and direct SSH clients; off revokes, status reports",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "off") {
				resetSshRights(ctx);
				notify(ctx, "SSH rights revoked.");
				return;
			}
			if (action === "status") {
				notify(ctx, `SSH rights: ${sshAllowed ? "ON" : "OFF"}.`);
				return;
			}
			if (action !== "" && action !== "on") {
				notify(ctx, "Usage: /ssh-rights [on|off|status]");
				return;
			}
			if (!ctx.hasUI) return; // Fail closed without user confirmation UI.
			if (sshAllowed) {
				notify(ctx, "SSH rights already enabled. Use /ssh-rights off to revoke.");
				return;
			}
			const requestedGeneration = sshGeneration;
			const confirmed = await ctx.ui.confirm("Enable SSH rights?",
				"The agent may read and edit ~/.ssh on this machine (keys, config, authorized_keys), run SSH key tools, and invoke ssh, scp, sftp, or mosh directly, without per-operation confirmation. Removal still requires /rm-rights; remote .ssh directories on /hpc hosts stay blocked. Use /ssh-rights off to revoke; reload, restart, and session replacement reset it.");
			if (!confirmed || sshGeneration !== requestedGeneration) return;
			sshAllowed = true;
			updateStatus(ctx);
			notify(ctx, "SSH rights enabled for this session. Use /ssh-rights off when finished.");
		},
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${SAFETY_INSTRUCTIONS
			.replace("{{REMOVAL_POLICY}}", removalAllowed ? REMOVAL_ALLOWED : REMOVAL_BLOCKED)
			.replace("{{SSH_POLICY}}", sshAllowed ? SSH_ALLOWED : SSH_BLOCKED)}`,
	}));

	pi.on("tool_call", async (event, ctx) => {
		if (SHELL_TOOLS.has(event.toolName)) {
			const command = event.input.command;
			if (typeof command !== "string") return block(ctx, "Missing shell command.");

			// SSH rights cover this machine only; hpc_exec runs on a remote host.
			const reason = shellSafetyReason(command, removalAllowed, sshAllowed && event.toolName !== "hpc_exec");
			if (reason) return block(ctx, reason);

			return;
		}

		// Local file tools; hpc-mode separately blocks remote .ssh paths.
		if (sshAllowed) return;

		if (event.toolName === "read" || event.toolName === "ls") {
			if (pathIsInsideSsh(event.input.path, ctx.cwd)) {
				return block(ctx, "Blocked access to ~/.ssh. Agents may not read or list anything inside the SSH directory; ask the user directly instead.");
			}
			return;
		}

		if (event.toolName === "grep") {
			if (recursiveRootCouldReachSsh(event.input.path, ctx.cwd) || commandMentionsSshDir(event.input.glob ?? "")) {
				return block(ctx, "Blocked search that could inspect ~/.ssh. Agents may not search SSH configuration or key material; ask the user directly instead.");
			}
			return;
		}

		if (event.toolName === "find") {
			if (recursiveRootCouldReachSsh(event.input.path, ctx.cwd) || commandMentionsSshDir(event.input.pattern)) {
				return block(ctx, "Blocked file search that could reveal names inside ~/.ssh. Ask the user directly for SSH-related information instead.");
			}
			return;
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			if (pathIsInsideSsh(event.input.path, ctx.cwd)) {
				return block(ctx, "Blocked modification inside ~/.ssh. Agents may not access SSH configuration or key material; ask the user directly instead.");
			}
		}
	});
}
