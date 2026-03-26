import { TFile, Vault } from "obsidian";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

function pathMatchesRoot(path: string, rootSubpath: string): boolean {
	const normalized = rootSubpath.trim().replace(/^\//, "").replace(/\/$/, "");
	if (!normalized) return true;
	return path === normalized || path.startsWith(normalized + "/");
}

function pathHasExcludedSegment(path: string, excludedFolders: string[]): boolean {
	const segments = path.split("/");
	return segments.some((seg) => excludedFolders.includes(seg));
}

export function isMarkdownFileInSyncScope(
	file: TFile,
	rootSubpath: string,
	excludedFolders: string[]
): boolean {
	if (file.extension.toLowerCase() !== "md") return false;
	if (!pathMatchesRoot(file.path, rootSubpath)) return false;
	if (pathHasExcludedSegment(file.path, excludedFolders)) return false;
	return true;
}

export function listMarkdownFiles(
	vault: Vault,
	rootSubpath: string,
	excludedFolders: string[]
): TFile[] {
	const all = vault.getMarkdownFiles();
	return all.filter((f) => isMarkdownFileInSyncScope(f, rootSubpath, excludedFolders));
}

export function indexImageFiles(
	vault: Vault,
	rootSubpath: string,
	excludedFolders: string[]
): Map<string, TFile> {
	const map = new Map<string, TFile>();
	const all = vault.getFiles();
	for (const f of all) {
		if (!(f instanceof TFile)) continue;
		const ext = f.extension?.toLowerCase();
		if (!ext || !IMAGE_EXTENSIONS.has("." + ext)) continue;
		if (!pathMatchesRoot(f.path, rootSubpath)) continue;
		if (pathHasExcludedSegment(f.path, excludedFolders)) continue;
		map.set(f.name, f);
	}
	return map;
}
