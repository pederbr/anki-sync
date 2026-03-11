import type { TFile } from "obsidian";
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

export function resolveImagePath(
	ref: string,
	imageIndex: Map<string, TFile>
): TFile | null {
	ref = ref.trim();
	if (!ref) return null;
	const basename = getBasename(ref);
	const stem = getStem(ref);
	const ext = getExt(ref);

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
	return text.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) =>
		alias != null ? alias.trim() : target.trim()
	);
}

export async function replaceImageSyntaxMarkdown(
	text: string,
	imageIndex: Map<string, TFile>,
	storeMedia: StoreMediaFn
): Promise<string> {
	const imgForRef = async (ref: string, alt = ""): Promise<string> => {
		const file = resolveImagePath(ref, imageIndex);
		if (!file) return `[missing image: ${ref}]`;
		const filename = await storeMedia(file);
		return `![${alt}](${filename})`;
	};

	const pastedRe = /^!Pasted image\s+(.+\.(?:png|jpg|jpeg|gif|svg|webp))\s*$/i;
	const lines = text.split("\n");
	const newLines: string[] = [];
	for (const line of lines) {
		const m = line.trim().match(pastedRe);
		if (m) {
			newLines.push(await imgForRef(m[1].trim()));
		} else {
			newLines.push(line);
		}
	}
	let out = newLines.join("\n");

	const obsidianRe = /!\[\[([^|\]]+)(?:\|([^]]*))?\]\]/g;
	const obsidianMatches: { full: string; ref: string; alt: string }[] = [];
	let obsidianM;
	while ((obsidianM = obsidianRe.exec(out)) !== null) {
		obsidianMatches.push({
			full: obsidianM[0],
			ref: obsidianM[1].trim(),
			alt: (obsidianM[2] ?? "").trim(),
		});
	}
	const obsidianReplacements = await Promise.all(
		obsidianMatches.map((m) => imgForRef(m.ref, m.alt))
	);
	for (let i = 0; i < obsidianMatches.length; i++) {
		out = out.replace(obsidianMatches[i].full, obsidianReplacements[i]);
	}

	const mdImgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
	const mdImgMatches: { full: string; ref: string; alt: string }[] = [];
	let mdImgM;
	while ((mdImgM = mdImgRe.exec(out)) !== null) {
		mdImgMatches.push({
			full: mdImgM[0],
			ref: mdImgM[2].trim(),
			alt: (mdImgM[1] ?? "").trim(),
		});
	}
	const mdImgReplacements = await Promise.all(
		mdImgMatches.map((m) => imgForRef(m.ref, m.alt))
	);
	for (let i = 0; i < mdImgMatches.length; i++) {
		out = out.replace(mdImgMatches[i].full, mdImgReplacements[i]);
	}

	return out;
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
	out = out.replace(/\\\([^)]*?\\\)/gs, (m) => {
		stored.push(m);
		return placeholder(stored.length - 1);
	});
	out = out.replace(/\\\[[^\]]*?\\\]/gs, (m) => {
		stored.push(m);
		return placeholder(stored.length - 1);
	});
	out = out.replace(/\$\$[\s\S]*?\$\$/g, (m) => {
		stored.push(m);
		return placeholder(stored.length - 1);
	});
	out = out.replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (m, inner) => {
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
		out = out.replace(ph, normalizeLatexChunk(stored[i]));
	}
	return out;
}

export async function processFrontText(
	text: string,
	imageIndex: Map<string, TFile>,
	storeMedia: StoreMediaFn
): Promise<string> {
	let out = replaceWikilinks(text);
	out = await replaceImageSyntaxMarkdown(out, imageIndex, storeMedia);
	const { text: afterProtect, stored } = protectLatex(out);
	out = restoreLatex(afterProtect, stored);
	return out;
}

const md = new MarkdownIt("commonmark", { html: true });

export async function processBackText(
	text: string,
	imageIndex: Map<string, TFile>,
	storeMedia: StoreMediaFn
): Promise<string> {
	let out = replaceWikilinks(text);
	out = await replaceImageSyntaxMarkdown(out, imageIndex, storeMedia);
	out = ensureBlankLineBeforeLists(out);
	const { text: afterProtect, stored } = protectLatex(out);
	const html = md.render(afterProtect);
	return restoreLatex(html, stored);
}

export async function extractCardsFromFile(
	content: string,
	file: TFile,
	options: ExtractOptions,
	imageIndex: Map<string, TFile>,
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
				front: await processFrontText(card.front, imageIndex, storeMedia),
				back: await processBackText(card.back, imageIndex, storeMedia),
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
			front: await processFrontText(frontRaw, imageIndex, storeMedia),
			back: await processBackText(backRaw, imageIndex, storeMedia),
		},
	];
}
