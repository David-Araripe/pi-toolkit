// Agent communication store: trusted member records, the permission check and
// per-agent filesystem mailboxes. Plain Node APIs and erasable TypeScript only,
// so it also runs inside `node worker.ts`-style processes and tests.
//
// Layout under root():
//   members/<id>.json        who an agent is and what it may do (written only by a trusted registrar)
//   presence/<id>.json       { pid } of the process currently acting as <id>
//   mail/<id>/new/*.json     unread messages (one file each, write-then-rename)
//   mail/<id>/cur/*.json     messages already returned by inbox
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type CommMode = "none" | "supervisor" | "peers";
export const COMM_MODES: CommMode[] = ["none", "supervisor", "peers"];
const RANK: Record<CommMode, number> = { none: 0, supervisor: 1, peers: 2 };

export interface Member {
	id: string;
	name: string;
	// Peers must share a scope: "project:<hash>" (root default: same git repository,
	// worktrees included), "named:<name>" (/comm join) or "private:<id>".
	scope: string;
	// Human-readable scope (project path or name).
	scopeLabel?: string;
	// The user chose this scope (/comm join or leave); it then survives resume.
	explicit?: boolean;
	mode: CommMode;
	// Direct supervisor. The parent-child link is allowed whatever the scope.
	parent?: string;
	// Peer groups; peers must share one. Child groups are namespaced by the parent id.
	groups: string[];
	createdAt: string;
}

export interface Message {
	id: string;
	from: string;
	fromName: string;
	to: string;
	body: string;
	at: string;
	replyTo?: string;
}

export const MESSAGE_LIMIT = 4000;
export const BACKLOG_LIMIT = 100;
export const ROOT_GROUP = "roots";
const READ_KEEP = 200;
const READ_MAX_AGE_MS = 14 * 24 * 3600_000;
const UNREAD_MAX_AGE_MS = 30 * 24 * 3600_000;
const MEMBER_MAX_AGE_MS = 60 * 24 * 3600_000;
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const SCOPE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const GROUP_NAME = /^[A-Za-z0-9._-]{1,32}$/;

export function root(): string {
	return process.env.PI_AGENT_COMM_ROOT || join(homedir(), ".pi", "agent", "agent-comm");
}

function checkId(id: string): string {
	if (!ID.test(id)) throw new Error(`Invalid agent id: ${id}`);
	return id;
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

function dir(...parts: string[]): string {
	const path = join(root(), ...parts);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}

function jsonFiles(path: string): string[] {
	try {
		return readdirSync(path).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return [];
	}
}

export function readMember(id: string | undefined): Member | undefined {
	if (!id || !ID.test(id)) return undefined;
	return readJson<Member>(join(root(), "members", `${id}.json`));
}

function writeMember(member: Member): Member {
	writeAtomic(join(dir("members"), `${checkId(member.id)}.json`), member);
	return member;
}

export function listMembers(): Member[] {
	return jsonFiles(join(root(), "members")).flatMap((f) => readJson<Member>(join(root(), "members", f)) ?? []);
}

// A session can be renamed after it registered; its presence carries the current name.
export function displayName(member: Member): string {
	return readPresence(member.id)?.name || member.name;
}

export function scopeLabel(member: Member): string {
	if (member.scope.startsWith("private:")) return "private";
	return member.scopeLabel ?? member.scope;
}

// The project a directory belongs to: its git common directory, so every
// worktree of one repository is the same project. Outside git, the directory.
export function projectOf(cwd: string): { key: string; label: string } {
	let path: string;
	try {
		const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		path = realpathSync(resolve(cwd, common));
	} catch {
		try {
			path = realpathSync(cwd);
		} catch {
			path = resolve(cwd);
		}
	}
	const label = basename(path) === ".git" ? dirname(path) : path;
	return { key: createHash("sha256").update(path).digest("hex").slice(0, 16), label };
}

// ------------------------------------------------------------ registration

// A root (independent) session: a named scope (/comm join), the project scope
// (default) or a private one (/comm leave; it then only reaches its own children).
export function registerRoot(id: string, name: string, scope?: { named: string } | { project: string } | "private", explicit = false): Member {
	const existing = readMember(id);
	if (existing?.parent) throw new Error("A delegated agent cannot register as a root session.");
	let key = `private:${id}`;
	let label: string | undefined;
	if (scope && typeof scope === "object" && "named" in scope) {
		if (!SCOPE_NAME.test(scope.named)) throw new Error(`Invalid scope name "${scope.named}". Use letters, digits, ".", "_" or "-".`);
		key = `named:${scope.named}`;
		label = scope.named;
	} else if (scope && typeof scope === "object") {
		const project = projectOf(scope.project);
		key = `project:${project.key}`;
		label = project.label;
	}
	return writeMember({
		id: checkId(id),
		name: name || existing?.name || `session-${id.slice(0, 8)}`,
		scope: key,
		...(label ? { scopeLabel: label } : {}),
		...(explicit ? { explicit } : {}),
		mode: "peers",
		groups: key.startsWith("private:") ? [] : [ROOT_GROUP],
		createdAt: existing?.createdAt ?? new Date().toISOString(),
	});
}

// Keeps an existing root's scope; creates a private one otherwise.
export function ensureRoot(id: string, name: string): Member {
	const existing = readMember(id);
	if (existing) return existing;
	return registerRoot(id, name);
}

// Written by the parent's harness before the child starts. The child's mode can
// never exceed its parent's, and its peer group lives in the parent's namespace,
// so nested agents cannot reach anything their ancestors could not authorize.
export function registerChild(options: { id: string; name: string; parentId: string; mode: CommMode; group?: string }): Member | undefined {
	if (!COMM_MODES.includes(options.mode)) throw new Error(`Unknown communication mode ${options.mode}. Use none, supervisor or peers.`);
	const parent = readMember(options.parentId);
	if (!parent) throw new Error(`Parent ${options.parentId} is not registered for communication.`);
	if (readMember(options.id)) throw new Error(`Agent ${options.id} is already registered.`);
	const ceiling: CommMode = parent.parent ? parent.mode : "peers";
	const mode = RANK[options.mode] <= RANK[ceiling] ? options.mode : ceiling;
	if (mode === "none") return undefined; // No record: nothing can address it and it gets no tool.
	if (options.group !== undefined && !GROUP_NAME.test(options.group)) throw new Error(`Invalid group "${options.group}". Use up to 32 letters, digits, ".", "_" or "-".`);
	return writeMember({
		id: checkId(options.id),
		name: options.name,
		scope: parent.scope,
		mode,
		parent: parent.id,
		groups: mode === "peers" ? [`${parent.id}/${options.group || "default"}`] : [],
		createdAt: new Date().toISOString(),
	});
}

// ------------------------------------------------------------ permissions

// Symmetric and checked for both parties on send and again on read.
export function canTalk(a: Member | undefined, b: Member | undefined): boolean {
	if (!a || !b || a.id === b.id) return false;
	if (a.mode === "none" || b.mode === "none") return false;
	if (a.parent === b.id || b.parent === a.id) return true;
	if (a.mode !== "peers" || b.mode !== "peers") return false;
	// Root sessions must share a scope. Children need no scope check: their groups
	// carry the parent id, so only siblings can share one (and a copied scope would
	// go stale when the parent changes its own).
	if (!a.parent && !b.parent && a.scope !== b.scope) return false;
	return a.groups.some((g) => b.groups.includes(g));
}

export function relation(self: Member, other: Member): string {
	if (self.parent === other.id) return "supervisor";
	if (other.parent === self.id) return "child";
	return "peer";
}

// Only permitted partners are ever visible, so a forbidden target looks exactly like an unknown one.
// Parent and child stay reachable while offline (a stopped child is resumed
// with its mailbox). Other pairs need the recipient's process to be running:
// a closed session cannot do the work, so nothing is queued for it.
export function linked(a: Member, b: Member): boolean {
	return a.parent === b.id || b.parent === a.id;
}

export function reachable(self: Member | undefined, other: Member | undefined): boolean {
	return canTalk(self, other) && (linked(self!, other!) || online(other!.id));
}

export function partners(self: Member): Member[] {
	return listMembers().filter((m) => reachable(self, m));
}

function notRunning(member: Member): Error {
	return new Error(`${displayName(member)} (${member.id}) is not running; nothing was sent. Only live sessions can be messaged.`);
}

export function resolveTarget(self: Member, target: string): Member {
	const wanted = target.trim();
	const find = (pool: Member[]) => {
		const exact = pool.filter((m) => m.id === wanted || [m.name, displayName(m)].some((n) => n.toLowerCase() === wanted.toLowerCase()));
		return exact.length ? exact : pool.filter((m) => wanted.length >= 4 && m.id.startsWith(wanted));
	};
	const matches = find(partners(self));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`"${target}" is ambiguous: ${matches.map((m) => `${displayName(m)} (${m.id})`).join(", ")}. Use the id.`);
	// Permitted but offline: say so rather than "unknown" (they were reachable before).
	const offline = find(listMembers().filter((m) => canTalk(self, m)));
	if (offline.length === 1) throw notRunning(offline[0]);
	throw new Error(`No permitted recipient "${target}". Use action=list.`);
}

// ------------------------------------------------------------ presence

export interface Presence {
	pid: number;
	name?: string;
	cwd?: string;
	branch?: string;
	model?: string;
	status?: "idle" | "busy";
	at: string;
}

// Written only by the process acting as <id>; merged so partial updates keep the rest.
export function markPresence(id: string, info: Partial<Presence> = {}): void {
	const current = readPresence(id);
	const pid = info.pid ?? process.pid;
	const base = current?.pid === pid ? current : {};
	writeAtomic(join(dir("presence"), `${checkId(id)}.json`), { ...base, ...info, pid, at: new Date().toISOString() });
}

export function readPresence(id: string): Presence | undefined {
	if (!ID.test(id)) return undefined;
	return readJson<Presence>(join(root(), "presence", `${id}.json`));
}

export function gitBranch(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export function clearPresence(id: string): void {
	try {
		unlinkSync(join(root(), "presence", `${checkId(id)}.json`));
	} catch {}
}

export function online(id: string): boolean {
	const pid = readPresence(id)?.pid;
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// ------------------------------------------------------------ mailboxes

let sequence = 0;
function fileName(id: string): string {
	sequence += 1;
	return `${Date.now().toString().padStart(15, "0")}-${process.pid}-${String(sequence).padStart(6, "0")}-${id}.json`;
}

export function unreadCount(id: string): number {
	return jsonFiles(join(root(), "mail", id, "new")).length;
}

export function send(fromId: string, toId: string, body: string, replyTo?: string): Message {
	const from = readMember(fromId);
	const to = readMember(toId);
	if (!canTalk(from, to)) throw new Error(`No permitted recipient "${toId}". Use action=list.`);
	if (!reachable(from, to)) throw notRunning(to!);
	const text = body.trim();
	if (!text) throw new Error("Message is empty.");
	if (text.length > MESSAGE_LIMIT) throw new Error(`Message is ${text.length} characters; the limit is ${MESSAGE_LIMIT}. Write details to a file and send its path.`);
	const inbox = dir("mail", to!.id, "new");
	if (jsonFiles(inbox).length >= BACKLOG_LIMIT) throw new Error(`${to!.name} has ${BACKLOG_LIMIT} unread messages; not accepting more.`);
	const message: Message = {
		id: randomBytes(4).toString("hex"),
		from: from!.id,
		fromName: displayName(from!),
		to: to!.id,
		body: text,
		at: new Date().toISOString(),
		...(replyTo ? { replyTo } : {}),
	};
	writeAtomic(join(inbox, fileName(message.id)), message);
	return message;
}

// Returns up to `limit` unread messages oldest first and files them as read.
// Messages whose sender is no longer permitted are filed without being shown.
export function takeInbox(selfId: string, limit: number): { messages: Message[]; remaining: number } {
	const self = readMember(selfId);
	const base = join(root(), "mail", selfId);
	const files = jsonFiles(join(base, "new"));
	const messages: Message[] = [];
	let used = 0;
	for (const file of files) {
		if (messages.length >= limit) break;
		used += 1;
		const message = readJson<Message>(join(base, "new", file));
		try {
			renameSync(join(base, "new", file), join(dir("mail", selfId, "cur"), file));
		} catch {
			continue; // Another reader (a second process with this identity) took it.
		}
		if (message && message.to === selfId && canTalk(self, readMember(message.from))) messages.push(message);
	}
	return { messages, remaining: files.length - used };
}

export function findMessage(selfId: string, messageId: string): Message | undefined {
	if (!/^[a-f0-9]{8}$/.test(messageId)) return undefined;
	for (const sub of ["cur", "new"]) {
		const path = join(root(), "mail", selfId, sub);
		const file = jsonFiles(path).find((f) => f.endsWith(`-${messageId}.json`));
		if (file) return readJson<Message>(join(path, file));
	}
	return undefined;
}

// Bounds leftover state: read messages expire after 14 days (at most 200 kept),
// unread ones after 30 days.
export function sweep(id: string, now = Date.now()): void {
	const prune = (path: string, maxAge: number, keep: number) => {
		const files = jsonFiles(path);
		files.forEach((file, index) => {
			const full = join(path, file);
			try {
				if (index < files.length - keep || now - statSync(full).mtimeMs > maxAge) unlinkSync(full);
			} catch {}
		});
	};
	const base = join(root(), "mail", id);
	if (!existsSync(base)) return;
	prune(join(base, "cur"), READ_MAX_AGE_MS, READ_KEEP);
	prune(join(base, "new"), UNREAD_MAX_AGE_MS, Number.POSITIVE_INFINITY);
}

// Bounds members/, which every list and send reads in full: root sessions not
// started for 60 days lose their record and mailbox (a resumed session simply
// registers again). Kept: live sessions, scopes the user chose, and parents
// that still have children. Presence left by a crashed process goes as well,
// which shortens the time a reused pid can make a dead session look live.
export function sweepMembers(now = Date.now()): void {
	for (const file of jsonFiles(join(root(), "presence"))) {
		const id = file.slice(0, -".json".length);
		if (ID.test(id) && !online(id)) clearPresence(id);
	}
	const members = listMembers();
	const parents = new Set(members.map((m) => m.parent));
	for (const member of members) {
		// The id comes from file content and names directories to delete: validate it.
		if (typeof member.id !== "string" || !ID.test(member.id)) continue;
		if (member.parent || member.explicit || parents.has(member.id) || online(member.id)) continue;
		const file = join(root(), "members", `${member.id}.json`);
		try {
			if (now - statSync(file).mtimeMs <= MEMBER_MAX_AGE_MS) continue;
			rmSync(join(root(), "mail", member.id), { recursive: true, force: true });
			clearPresence(member.id);
			unlinkSync(file);
		} catch {}
	}
}
