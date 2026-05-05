/**
 * Types and parser for `anki-occlusion` fenced code blocks.
 *
 * Block format (YAML-like):
 *   image: diagram.png
 *   header: My Quiz
 *   masks:
 *     - id: 1
 *       x: 0.10
 *       y: 0.15
 *       width: 0.25
 *       height: 0.12
 *       label: Mitochondria
 *
 * Coordinates are fractions of the image dimensions (0–1).
 */

/** One rectangular region to hide/test on a card. */
export interface OcclusionMask {
	/** Unique mask id within the block (positive integer). */
	id: number;
	/** Left edge as fraction of image width (0–1). */
	x: number;
	/** Top edge as fraction of image height (0–1). */
	y: number;
	/** Mask width as fraction of image width (0–1). */
	width: number;
	/** Mask height as fraction of image height (0–1). */
	height: number;
	/** Answer label shown on the back of the generated card. */
	label: string;
}

/** Parsed representation of one `anki-occlusion` code block. */
export interface OcclusionBlock {
	/** Image filename/path (wiki-link target syntax, resolved against vault). */
	image: string;
	/** Optional question header shown on the card front. */
	header: string;
	masks: OcclusionMask[];
	/** Vault path of the markdown file that contains this block. */
	sourceFile: string;
	/** Raw YAML between the fences (for hashing / re-serialization). */
	rawSource: string;
}

/** One Basic card to be generated — one per mask. */
export interface OcclusionCard {
	block: OcclusionBlock;
	/** Index into `block.masks`. */
	maskIndex: number;
}

// ── internal helpers ──────────────────────────────────────────────────────────

function unquote(raw: string): string {
	const s = raw.trim();
	if (s.length >= 2) {
		const first = s[0];
		const last  = s[s.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return s.slice(1, -1);
		}
	}
	return s;
}

function applyMaskProperty(line: string, mask: Partial<OcclusionMask>): void {
	const ci = line.indexOf(":");
	if (ci < 0) return;
	const key = line.slice(0, ci).trim();
	const val = unquote(line.slice(ci + 1));
	switch (key) {
		case "id":     mask.id     = parseInt(val, 10); break;
		case "x":      mask.x      = parseFloat(val);  break;
		case "y":      mask.y      = parseFloat(val);  break;
		case "width":  mask.width  = parseFloat(val);  break;
		case "height": mask.height = parseFloat(val);  break;
		case "label":  mask.label  = val;              break;
	}
}

function isMaskComplete(m: Partial<OcclusionMask>): m is OcclusionMask {
	return (
		typeof m.id     === "number" && !isNaN(m.id)     &&
		typeof m.x      === "number" && !isNaN(m.x)      &&
		typeof m.y      === "number" && !isNaN(m.y)      &&
		typeof m.width  === "number" && !isNaN(m.width)  && m.width  > 0 &&
		typeof m.height === "number" && !isNaN(m.height) && m.height > 0 &&
		typeof m.label  === "string"
	);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Parse the content between the `anki-occlusion` fences.
 * Returns `null` when the `image` key is absent.
 */
export function parseOcclusionSource(source: string, sourceFile: string): OcclusionBlock | null {
	const lines = source.split(/\r?\n/);
	let image   = "";
	let header  = "";
	const masks: OcclusionMask[] = [];
	let inMasks = false;
	let currentMask: Partial<OcclusionMask> | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		if (!inMasks) {
			if (trimmed === "masks:") { inMasks = true; continue; }
			const ci = trimmed.indexOf(":");
			if (ci < 0) continue;
			const key = trimmed.slice(0, ci).trim();
			const val = unquote(trimmed.slice(ci + 1));
			if (key === "image")  image  = val;
			if (key === "header") header = val;
		} else {
			if (trimmed.startsWith("- ")) {
				if (currentMask && isMaskComplete(currentMask)) masks.push(currentMask);
				currentMask = {};
				const rest = trimmed.slice(2).trim();
				if (rest) applyMaskProperty(rest, currentMask);
			} else if (currentMask !== null) {
				applyMaskProperty(trimmed, currentMask);
			}
		}
	}

	if (currentMask && isMaskComplete(currentMask)) masks.push(currentMask);
	if (!image) return null;

	return { image, header, masks, sourceFile, rawSource: source };
}

/** Extract all `anki-occlusion` code blocks from raw markdown file content. */
export function extractOcclusionBlocksFromContent(
	content: string,
	sourceFile: string
): OcclusionBlock[] {
	const blocks: OcclusionBlock[] = [];
	const re = /^```anki-occlusion[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		const block = parseOcclusionSource(m[1] ?? "", sourceFile);
		if (block) blocks.push(block);
	}
	return blocks;
}

/** Serialize an occlusion config back to YAML source for writing inside the fences. */
export function serializeOcclusionBlock(opts: {
	image: string;
	header: string;
	masks: OcclusionMask[];
}): string {
	const fmt = (n: number): string => {
		const s = n.toFixed(4);
		return s.replace(/(\.\d*[^0])0+$/, "$1").replace(/\.0+$/, "");
	};

	const lines: string[] = [
		`image: ${opts.image}`,
		`header: ${opts.header}`,
		`masks:`,
	];

	for (const m of opts.masks) {
		lines.push(`  - id: ${m.id}`);
		lines.push(`    x: ${fmt(m.x)}`);
		lines.push(`    y: ${fmt(m.y)}`);
		lines.push(`    width: ${fmt(m.width)}`);
		lines.push(`    height: ${fmt(m.height)}`);
		lines.push(`    label: ${m.label}`);
	}

	return lines.join("\n");
}
