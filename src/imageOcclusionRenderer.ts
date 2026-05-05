/**
 * Canvas-based image generation for image occlusion cards.
 *
 * For each mask in a block this module produces a "front" PNG:
 *   - Original image drawn underneath
 *   - All masks drawn as solid gray rectangles (hiding the content)
 *   - The current mask gets an orange highlight border so the student
 *     knows which region they are being tested on
 *
 * The original (unmasked) image is re-used on the card back; it is stored
 * separately by the sync engine via the standard storeMedia path.
 */

import type { OcclusionMask } from "./imageOcclusionParser";

const MAX_DISPLAY_WIDTH  = 1920;
const MASK_FILL          = "rgba(90, 90, 90, 0.88)";
const HIGHLIGHT_STROKE   = "#ff8c00";
const HIGHLIGHT_WIDTH    = 4;

// ── helpers ───────────────────────────────────────────────────────────────────

async function loadImageElement(data: ArrayBuffer): Promise<HTMLImageElement> {
	const blob = new Blob([data]);
	const url  = URL.createObjectURL(blob);
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const img    = new Image();
		img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
		img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load occlusion source image")); };
		img.src = url;
	});
}

function canvasToBase64Png(canvas: HTMLCanvasElement): string {
	const dataUrl = canvas.toDataURL("image/png");
	const comma   = dataUrl.indexOf(",");
	return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Render the front image for one mask:
 * every mask is shown as a gray box; the target mask gets an orange border.
 * Returns a base64-encoded PNG string (no data-URL prefix).
 */
export async function renderFrontImage(
	imageData: ArrayBuffer,
	masks: OcclusionMask[],
	currentMaskIndex: number
): Promise<string> {
	const img = await loadImageElement(imageData);

	let w = img.naturalWidth;
	let h = img.naturalHeight;
	if (w > MAX_DISPLAY_WIDTH) {
		const scale = MAX_DISPLAY_WIDTH / w;
		h = Math.round(h * scale);
		w = MAX_DISPLAY_WIDTH;
	}

	const canvas     = document.createElement("canvas");
	canvas.width     = w;
	canvas.height    = h;
	const ctx        = canvas.getContext("2d")!;
	ctx.drawImage(img, 0, 0, w, h);

	for (let i = 0; i < masks.length; i++) {
		const m  = masks[i]!;
		const px = Math.round(m.x      * w);
		const py = Math.round(m.y      * h);
		const pw = Math.round(m.width  * w);
		const ph = Math.round(m.height * h);

		ctx.fillStyle = MASK_FILL;
		ctx.fillRect(px, py, pw, ph);

		if (i === currentMaskIndex) {
			const half = HIGHLIGHT_WIDTH / 2;
			ctx.strokeStyle = HIGHLIGHT_STROKE;
			ctx.lineWidth   = HIGHLIGHT_WIDTH;
			ctx.strokeRect(px + half, py + half, pw - HIGHLIGHT_WIDTH, ph - HIGHLIGHT_WIDTH);
		}
	}

	return canvasToBase64Png(canvas);
}

/**
 * FNV-1a 32-bit hash of the block's semantic content.
 * Changing any mask coordinate, label, image name, or header changes the hash,
 * which changes the derived media filenames so Anki picks up the update.
 */
export function occlusionBlockContentHash(
	imageName: string,
	header: string,
	masks: OcclusionMask[]
): string {
	const input =
		imageName +
		"\n" +
		header +
		"\n" +
		masks.map((m) => `${m.id}:${m.x}:${m.y}:${m.width}:${m.height}:${m.label}`).join("\n");

	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Anki media filename for the generated front image of a specific mask. */
export function frontImageFilename(blockHash: string, maskId: number): string {
	return `anki-occ-${blockHash}-${maskId}-f.png`;
}

/**
 * Unique Anki tag for a specific mask card.
 * Used by `upsertOcclusionCard` as a stable identity key instead of the front text.
 */
export function occlusionCardTag(blockHash: string, maskId: number): string {
	return `anki-occ-${blockHash}-${maskId}`;
}
