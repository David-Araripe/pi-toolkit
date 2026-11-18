/**
 * Show local Markdown links as plain absolute paths (clickable by VS Code and
 * terminal path detection), keeping descriptive labels, without changing messages.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Marked } from "@earendil-works/pi-tui";

interface LocalTarget {
	/** Absolute path, with a VS Code-style `:line[:column]` suffix when known. */
	path: string;
	/** Absolute path without any line suffix, for label comparison. */
	file: string;
	/** Non-line fragment (e.g. a heading slug), shown separately so the path stays clickable. */
	fragment?: string;
}

/** GitHub-style `#L42`, `#L42C3`, `#L42-L50` anchors become `:42` / `:42:3`. */
function lineSuffix(fragment: string): string | undefined {
	const match = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(fragment);
	return match ? `:${match[1]}${match[2] ? `:${match[2]}` : ""}` : undefined;
}

function expandHome(path: string): string | undefined {
	if (/^~[^/]/.test(path)) return;
	return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

function localTarget(href: string, cwd: string): LocalTarget | undefined {
	// Preserve network URLs, anchors, and shell/remote path expressions.
	if (!href || /^(?:\/\/|#)/.test(href) || /[$\x00-\x1f\x7f]/.test(href)) return;
	let decoded: string;
	let fragment = "";
	try {
		if (/^file:/i.test(href)) {
			const url = new URL(href);
			if (url.hostname && url.hostname !== "localhost") return;
			fragment = decodeURIComponent(url.hash.slice(1));
			url.hash = "";
			url.search = "";
			decoded = fileURLToPath(url);
		} else {
			// `name.md:42[:3]` looks like a scheme but is an editor-style line target.
			if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[^:]+:\d+(?::\d+)?(?:[?#]|$)/.test(href)) return;
			const hashAt = href.indexOf("#");
			const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
			if (hashAt >= 0) fragment = decodeURIComponent(href.slice(hashAt + 1));
			// Query strings carry no meaning for local files.
			const queryAt = beforeHash.indexOf("?");
			decoded = decodeURIComponent(queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt));
		}
	} catch {
		return;
	}
	if (!decoded || /[\x00-\x1f\x7f]/.test(decoded + fragment)) return;
	const expanded = expandHome(decoded);
	if (!expanded) return;
	const full = resolve(cwd, expanded);
	let line = fragment ? lineSuffix(fragment) : undefined;
	// Editor-style `path:42[:3]` targets; split syntactically before any probing.
	const editorLine = line ? undefined : /^(.*?):(\d+)(?::(\d+))?$/.exec(full);
	const path = editorLine ? editorLine[1] : full;
	// Never probe protected credential paths, even for existence.
	if (path.split(/[\\/]/).includes(".ssh")) return;
	// A remote/missing path must not be presented as a working local path.
	let file: string;
	if (existsSync(full)) file = full;
	else if (editorLine && existsSync(path)) {
		file = path;
		line = `:${editorLine[2]}${editorLine[3] ? `:${editorLine[3]}` : ""}`;
	} else return;
	return { path: file + (line ?? ""), file, fragment: line || !fragment ? undefined : fragment };
}

function codeSpan(text: string): string {
	// Filenames can contain Markdown syntax, including runs of backticks.
	const length = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1;
	const fence = "`".repeat(length);
	const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${padding}${text}${padding}${fence}`;
}

/**
 * A label is redundant when it only names the target (file name, written href,
 * cwd-relative, home, or absolute spelling), optionally with a line marker.
 * Descriptive labels such as "the deployment guide" are kept.
 */
function isRedundantLabel(label: string, href: string, target: LocalTarget, cwd: string): boolean {
	const text = label.replace(/^[`*_\s]+|[`*_\s]+$/g, "")
		.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|\s+\(?(?:lines?|L)\s*\d+(?:\s*[-–]\s*\d+)?\)?)$/i, "")
		.replace(/\/+$/, "");
	if (!text) return true;
	const strip = (value: string) => value.replace(/^\.\//, "").replace(/\/+$/, "");
	const spellings = new Set([target.file, basename(target.file), relative(cwd, target.file)].map(strip));
	const home = homedir();
	if (target.file.startsWith(`${home}/`)) spellings.add(`~${target.file.slice(home.length)}`);
	try {
		spellings.add(strip(decodeURIComponent(href.replace(/[?#].*$/, ""))));
	} catch {
		// Malformed hrefs never resolve this far; keep the label to be safe.
	}
	return spellings.has(strip(text));
}

function renderTarget(target: LocalTarget): string {
	return codeSpan(target.path) + (target.fragment ? ` ${codeSpan(`#${target.fragment}`)}` : "");
}

/**
 * Keep source spelling except for resolved links. Marked validates link syntax
 * (balanced parentheses, escaped brackets, titles, and reference definitions).
 * Code spans/blocks, images, HTML, and escaped examples are not linkified.
 */
function resolveLinks(markdown: string, cwd: string): string {
	if (!markdown.includes("[")) return markdown;
	const parser = new Marked();
	const links = parser.lexer(markdown).links;
	const tokenizer = new parser.Tokenizer();
	// The public Lexer constructor initializes the tokenizer's rules and lexer.
	const lexer = new parser.Lexer({ tokenizer, gfm: true });
	let output = "";
	let index = 0;
	let fence: { char: string; length: number } | undefined;
	while (index < markdown.length) {
		if (index === 0 || markdown[index - 1] === "\n") {
			const end = markdown.indexOf("\n", index);
			const lineEnd = end < 0 ? markdown.length : end + 1;
			const line = markdown.slice(index, lineEnd);
			const unquoted = line.replace(/^(?: {0,3}>[ \t]?)+/, "");
			const marker = /^\s*(?:[-+*]|\d+[.)])?[ \t]*(`{3,}|~{3,})(.*)/.exec(unquoted);
			if (fence || marker) {
				if (fence) {
					if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
				} else if (marker) {
					fence = { char: marker[1][0], length: marker[1].length };
				}
				output += line;
				index = lineEnd;
				continue;
			}
			// Conservatively leave indented code and link definitions verbatim.
			const definition = tokenizer.def(markdown.slice(index));
			if (/^(?: {4}|\t)/.test(unquoted) || definition) {
				const raw = definition?.raw ?? line;
				output += raw;
				index += raw.length;
				continue;
			}
			const html = tokenizer.html(markdown.slice(index));
			if (html) {
				output += html.raw;
				index += html.raw.length;
				continue;
			}
		}
		const rest = markdown.slice(index);
		const char = markdown[index];
		const literal = char === "\\" ? tokenizer.escape(rest)
			: char === "`" ? tokenizer.codespan(rest)
				: char === "<" ? tokenizer.autolink(rest) ?? tokenizer.tag(rest)
					: /^(?:https?:\/\/|ftp:\/\/|www\.)/i.test(rest) ? tokenizer.url(rest) : undefined;
		if (literal) {
			output += literal.raw;
			index += literal.raw.length;
			continue;
		}
		const startsLink = char === "[" || (char === "!" && markdown[index + 1] === "[");
		const token = startsLink && !lexer.state.inRawBlock && !lexer.state.inLink
			? tokenizer.link(rest) ?? tokenizer.reflink(rest, links) : undefined;
		if (token && (token.type === "link" || token.type === "image")) {
			const target = token.type === "link" ? localTarget(token.href, cwd) : undefined;
			// No Markdown link means no OSC 8 URL for an external opener to mishandle;
			// plain absolute paths are detected by VS Code and terminal path matchers.
			if (!target) output += token.raw;
			else if (isRedundantLabel(token.text, token.href, target, cwd)) output += renderTarget(target);
			else output += `${token.text} (${renderTarget(target)})`;
			index += token.raw.length;
			continue;
		}
		output += char;
		index++;
	}
	return output;
}

export default function fileLinksExtension(pi: ExtensionAPI) {
	let cwd: string | undefined;
	pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });
	pi.on("session_shutdown", () => { cwd = undefined; });
	pi.registerMarkdownTransformer((markdown, context) => {
		if (!cwd || context.messageType !== "assistant") return markdown;
		let remote = false;
		pi.events.emit("hpc-mode:workspace-query", { reply: (host: string | undefined) => { remote = Boolean(host); } });
		if (remote) return markdown;
		return resolveLinks(markdown, cwd);
	});
}
