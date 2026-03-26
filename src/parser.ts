import { TFile, type MetadataCache, type TAbstractFile, type Vault } from "obsidian";
import MarkdownIt from "markdown-it";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const LATEX_PLACEHOLDER_PREFIX = "§§LATEX";
const LATEX_PLACEHOLDER_SUFFIX = "§§";
const MATHY_CHARS = /[\\_^]|\d/;

export interface ExtractOptions {
	sectionHeadingLevel: 1 | 2 | 3 | 4 | 5 | 6;
	createIntroCard: boolean;
}

export interface Card {
	front: string;
	back: string;
}

export type StoreMediaFn = (file: TFile) => Promise<string>;

/** Context for resolving wiki/markdown image paths like the Python script (vault-relative path + index + Obsidian link resolution). */
export interface ImageResolveContext {
	vault: Vault;
	metadataCache: MetadataCache;
	/** Path of the markdown file being processed (for Obsidian link resolution). */
	sourcePath: string;
	imageIndex: Map<string, TFile>;
	attachmentsFolderName: string;
}

function stripQueryAndHash(s: string): string {
	let out = s;
	const q = out.indexOf("?");
	if (q >= 0) out = out.slice(0, q);
	const h = out.indexOf("#");
	if (h >= 0) out = out.slice(0, h);
	return out;
}

function normalizeImageRef(raw: string): string {
	let r = raw.trim().replace(/\\/g, "/");
	if (!r) return "";
	try {
		r = decodeURIComponent(r);
	} catch {
		/* ignore */
	}
	r = stripQueryAndHash(r);
	return r.trim();
}

function isImageFile(f: TFile): boolean {
	const ext = "." + f.extension.toLowerCase();
	return IMAGE_EXTENSIONS.has(ext);
}

function getBasename(ref: string): string {
	const idx = ref.replace(/\\/g, "/").lastIndexOf("/");
	return idx >= 0 ? ref.slice(idx + 1) : ref;
}

function getStem(ref: string): string {
	const base = getBasename(ref);
	const dot = base.lastIndexOf(".");
	return dot >= 0 ? base.slice(0, dot) : base;
}

function getExt(ref: string): string {
	const base = getBasename(ref);
	const dot = base.lastIndexOf(".");
	return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

function tryFileAsImage(abstract: TAbstractFile | null): TFile | null {
	return abstract instanceof TFile && isImageFile(abstract) ? abstract : null;
}

/**
 * Resolve an image reference to a vault file.
 * Mirrors obsidian_to_anki_sync.py: vault-relative path first, then basename index, fuzzy match.
 * Also uses Obsidian’s link resolver and optional default attachments folder.
 */
export function resolveImagePath(ref: string, ctx: ImageResolveContext): TFile | null {
	const r = normalizeImageRef(ref);
	if (!r) return null;

	const direct = tryFileAsImage(ctx.vault.getAbstractFileByPath(r));
	if (direct) return direct;

	const linked = tryFileAsImage(ctx.metadataCache.getFirstLinkpathDest(r, ctx.sourcePath));
	if (linked) return linked;

	const folder = ctx.attachmentsFolderName.trim().replace(/^\/+|\/+$/g, "");
	if (folder && !r.includes("/")) {
		const prefixed = tryFileAsImage(ctx.vault.getAbstractFileByPath(`${folder}/${r}`));
		if (prefixed) return prefixed;
	}

	const imageIndex = ctx.imageIndex;
	const basename = getBasename(r);
	const stem = getStem(r);
	const ext = getExt(r);

	if (imageIndex.has(basename)) return imageIndex.get(basename)!;
	if (!ext && stem) {
		for (const e of IMAGE_EXTENSIONS) {
			const name = stem + e;
			if (imageIndex.has(name)) return imageIndex.get(name)!;
		}
	}
	if (stem) {
		for (const [name, file] of imageIndex) {
			if (name.includes(stem)) return file;
		}
	}
	for (const [name, file] of imageIndex) {
		if (basename && name.includes(basename)) return file;
	}
	return null;
}

function replaceWikilinks(text: string): string {
	return text.replace(
		/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g,
		(_match: string, target: string, alias?: string) =>
			alias != null ? alias.trim() : target.trim()
	);
}

/** For use in HTML attribute values (e.g. img src / alt). */
function escapeHtmlAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * After upload, emit HTML img tags — not markdown `![]()`, because CommonMark treats
 * spaces in `![](Pasted image 123.png)` as invalid (URL cannot contain spaces), so
 * markdown-it leaves the literal syntax in the output and images never render.
 */
function imgHtmlUploaded(filename: string, alt: string): string {
	return `<img src="${escapeHtmlAttr(filename)}" alt="${escapeHtmlAttr(alt)}">`;
}

/** CommonMark HTML blocks run until a blank line; a newline right after `<img>` ends the block so markdown below is parsed. */
function insertNewlineAfterHtmlImgTags(text: string): string {
	return text.replace(/<img\b[^>]*>/gi, (m) => `${m}\n`);
}

export async function replaceImageSyntaxMarkdown(
	text: string,
	imageCtx: ImageResolveContext,
	storeMedia: StoreMediaFn
): Promise<string> {
	const imgForRef = async (ref: string, alt = ""): Promise<string> => {
		const file = resolveImagePath(ref, imageCtx);
		if (!file) return `[missing image: ${ref}]`;
		const filename = await storeMedia(file);
		return imgHtmlUploaded(filename, alt);
	};

	const pastedRe = /^!Pasted image\s+(.+\.(?:png|jpg|jpeg|gif|svg|webp))\s*$/i;
	const lines = text.split("\n");
	const newLines: string[] = [];
	for (const line of lines) {
		const m = line.trim().match(pastedRe);
		if (m != null) {
			newLines.push(await imgForRef(m[1]!.trim()));
		} else {
			newLines.push(line);
		}
	}
	let out = newLines.join("\n");

	const obsidianRe = /!\[\[([^|\]]+)(?:\|([^]]*))?\]\]/g;
	const obsidianMatches: { full: string; ref: string; alt: string }[] = [];
	let obsidianM: RegExpExecArray | null;
	while ((obsidianM = obsidianRe.exec(out)) !== null) {
		const [full, rawRef, rawAlt] = obsidianM;
		const ref = (rawRef ?? "").trim();
		const alt = (rawAlt ?? "").trim();
		obsidianMatches.push({ full, ref, alt });
	}
	const obsidianReplacements = await Promise.all(
		obsidianMatches.map((m) => imgForRef(m.ref, m.alt))
	);
	obsidianMatches.forEach((match, index) => {
		const replacement = obsidianReplacements[index];
		if (replacement) {
			out = out.replace(match.full, replacement);
		}
	});

	const mdImgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
	const mdImgMatches: { full: string; ref: string; alt: string }[] = [];
	let mdImgM: RegExpExecArray | null;
	while ((mdImgM = mdImgRe.exec(out)) !== null) {
		const [full, rawAlt, rawRef] = mdImgM;
		const ref = (rawRef ?? "").trim();
		const alt = (rawAlt ?? "").trim();
		mdImgMatches.push({ full, ref, alt });
	}
	const mdImgReplacements = await Promise.all(
		mdImgMatches.map((m) => imgForRef(m.ref, m.alt))
	);
	mdImgMatches.forEach((match, index) => {
		const replacement = mdImgReplacements[index];
		if (replacement) {
			out = out.replace(match.full, replacement);
		}
	});

	return insertNewlineAfterHtmlImgTags(out);
}

/** Inserts a blank line before ATX headings when missing so markdown-it parses them reliably (e.g. after paragraphs or images). Skipped inside fenced code (```). */
const ATX_HEADING_LINE_RE = /^(\s*)(#{1,6})(\s|$)/;

function ensureBlankLineBeforeAtxHeadings(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let inFence = false;

	for (const line of lines) {
		const trimmedStart = line.trimStart();
		if (trimmedStart.startsWith("```")) {
			inFence = !inFence;
		}

		const isAtxHeading = ATX_HEADING_LINE_RE.test(line);
		const last = out.length > 0 ? out[out.length - 1]! : "";
		if (!inFence && isAtxHeading && out.length > 0 && last.trim() !== "") {
			out.push("");
		}
		out.push(line);
	}

	return out.join("\n");
}

function ensureBlankLineBeforeLists(text: string): string {
	const listItemRe = /^(\s*)(\d+\.\s+|[-*+]\s+)/;
	const lines = text.split("\n");
	const out: string[] = [];
	let prevBlank = true;
	for (const line of lines) {
		const stripped = line.trimEnd();
		const isList = listItemRe.test(stripped);
		if (isList && out.length > 0 && !prevBlank) {
			out.push("");
			prevBlank = true;
		}
		out.push(line);
		prevBlank = stripped === "";
	}
	return out.join("\n");
}

function isProbablyMath(inner: string): boolean {
	return MATHY_CHARS.test(inner);
}

function normalizeLatexChunk(chunk: string): string {
	if (chunk.startsWith("$$") && chunk.endsWith("$$") && chunk.length >= 4) {
		return "\\[" + chunk.slice(2, -2) + "\\]";
	}
	if (chunk.startsWith("$") && chunk.endsWith("$") && chunk.length >= 2) {
		const inner = chunk.slice(1, -1);
		if (!isProbablyMath(inner)) return chunk;
		return "\\(" + inner + "\\)";
	}
	return chunk;
}

function protectLatex(text: string): { text: string; stored: string[] } {
	const stored: string[] = [];
	const placeholder = (i: number) => `${LATEX_PLACEHOLDER_PREFIX}${i}${LATEX_PLACEHOLDER_SUFFIX}`;

	let out = text;
	out = out.replace(/\\\([\s\S]*?\\\)/g, (m: string) => {
		stored.push(m);
		return placeholder(stored.length - 1);
	});
	out = out.replace(/\\\[[\s\S]*?\\\]/g, (m: string) => {
		stored.push(m);
		return placeholder(stored.length - 1);
	});
	out = out.replace(/\$\$[\s\S]*?\$\$/g, (m: string) => {
		stored.push(m);
		return placeholder(stored.length - 1);
	});
	out = out.replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (m: string, inner: string) => {
		if (isProbablyMath(inner)) {
			stored.push(m);
			return placeholder(stored.length - 1);
		}
		return m;
	});

	return { text: out, stored };
}

function restoreLatex(text: string, stored: string[]): string {
	let out = text;
	for (let i = 0; i < stored.length; i++) {
		const ph = `${LATEX_PLACEHOLDER_PREFIX}${i}${LATEX_PLACEHOLDER_SUFFIX}`;
		const chunk = stored[i];
		if (chunk == null) continue;
		out = out.replace(ph, normalizeLatexChunk(chunk));
	}
	return out;
}

export async function processFrontText(
	text: string,
	imageCtx: ImageResolveContext,
	storeMedia: StoreMediaFn
): Promise<string> {
	let out = replaceWikilinks(text);
	out = await replaceImageSyntaxMarkdown(out, imageCtx, storeMedia);
	const { text: afterProtect, stored } = protectLatex(out);
	out = restoreLatex(afterProtect, stored);
	return out;
}

const md = new MarkdownIt("commonmark", { html: true });

export async function processBackText(
	text: string,
	imageCtx: ImageResolveContext,
	storeMedia: StoreMediaFn
): Promise<string> {
	let out = replaceWikilinks(text);
	out = await replaceImageSyntaxMarkdown(out, imageCtx, storeMedia);
	out = ensureBlankLineBeforeAtxHeadings(out);
	out = ensureBlankLineBeforeLists(out);
	const { text: afterProtect, stored } = protectLatex(out);
	const html = md.render(afterProtect);
	return restoreLatex(html, stored);
}

export async function extractCardsFromFile(
	content: string,
	file: TFile,
	options: ExtractOptions,
	imageCtx: ImageResolveContext,
	storeMedia: StoreMediaFn
): Promise<Card[]> {
	const lines = content.split(/\r?\n/);
	const prefix = "#".repeat(options.sectionHeadingLevel) + " ";
	let titleH1: string | null = null;
	let hasSectionHeading = false;
	for (const line of lines) {
		const stripped = line.trim();
		if (stripped.startsWith("# ")) {
			if (titleH1 == null) titleH1 = stripped.slice(2).trim();
		}
		if (stripped.startsWith(prefix)) hasSectionHeading = true;
	}

	if (hasSectionHeading) {
		const cards: Card[] = [];
		let currentHeading: string | null = null;
		let buffer: string[] = [];
		let introLines: string[] = [];

		for (const line of lines) {
			const stripped = line.trim();
			if (stripped.startsWith(prefix)) {
				if (currentHeading != null) {
					const backRaw = buffer.join("\n").trim();
					cards.push({ front: currentHeading, back: backRaw });
				}
				currentHeading = stripped.slice(prefix.length).trim();
				buffer = [];
				continue;
			}
			if (currentHeading == null) introLines.push(line);
			else buffer.push(line);
		}
		if (currentHeading != null) {
			const backRaw = buffer.join("\n").trim();
			cards.push({ front: currentHeading, back: backRaw });
		}
		if (options.createIntroCard && introLines.length > 0) {
			const introRaw = introLines.join("\n").trim();
			if (introRaw) {
				const frontRaw = titleH1 ?? file.basename;
				cards.unshift({ front: frontRaw, back: introRaw });
			}
		}

		const processed: Card[] = [];
		for (const card of cards) {
			processed.push({
				front: await processFrontText(card.front, imageCtx, storeMedia),
				back: await processBackText(card.back, imageCtx, storeMedia),
			});
		}
		return processed;
	}

	let frontRaw = titleH1 ?? file.basename;
	const backLines: string[] = [];
	let usedTitle = false;
	for (const line of lines) {
		const stripped = line.trim();
		if (stripped.startsWith("# ") && !usedTitle) {
			usedTitle = true;
			continue;
		}
		backLines.push(line);
	}
	const backRaw = backLines.join("\n").trim();
	return [
		{
			front: await processFrontText(frontRaw, imageCtx, storeMedia),
			back: await processBackText(backRaw, imageCtx, storeMedia),
		},
	];
}
