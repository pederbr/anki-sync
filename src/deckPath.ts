import type { TFile, Vault } from "obsidian";

/**
 * Matches `obsidian_to_anki_sync.py`:
 * `deck_parts = [root.name] + list(parts[:-1]) + [rel.stem]`, `deck_name = "::".join(deck_parts)`.
 * Each markdown file becomes its own leaf deck under folder-based subdecks.
 */
export function ankiDeckNameForMarkdownFile(
	vault: Vault,
	file: TFile,
	topLevelNameOverride: string
): string {
	const top = topLevelNameOverride.trim() || vault.getName();
	const normalized = file.path.replace(/\\/g, "/");
	const segments = normalized.split("/").filter(Boolean);
	if (segments.length === 0) {
		return top;
	}
	const last = segments[segments.length - 1]!;
	const stem = last.toLowerCase().endsWith(".md")
		? last.slice(0, -3)
		: last.replace(/\.[^/.]+$/, "");
	const dirs = segments.slice(0, -1);
	return [top, ...dirs, stem].join("::");
}

/** Root deck for tag-based cleanup (matches notes under this tree in Anki). */
export function ankiDeckRootForManagedNotes(
	vault: Vault,
	topLevelNameOverride: string
): string {
	return topLevelNameOverride.trim() || vault.getName();
}
