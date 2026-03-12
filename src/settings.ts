export type CardUpdateMode = "replace" | "append";

export interface PluginSettings {
	ankiConnectUrl: string;
	basicModel: string;
	clozeModel: string;
	defaultBasicDeckPrefix: string;
	defaultClozeDeckPrefix: string;
	cardUpdateMode: CardUpdateMode;
	deleteRemovedNotes: boolean;
	sectionHeadingLevel: 1 | 2 | 3 | 4 | 5 | 6;
	createIntroCard: boolean;
	vaultRootSubpath: string;
	excludedFolderNames: string;
	globalTags: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	ankiConnectUrl: "http://localhost:8765",
	basicModel: "Basic",
	clozeModel: "Cloze",
	defaultBasicDeckPrefix: "Obsidian",
	defaultClozeDeckPrefix: "Obsidian::Cloze",
	cardUpdateMode: "replace",
	deleteRemovedNotes: true,
	sectionHeadingLevel: 2,
	createIntroCard: true,
	vaultRootSubpath: "",
	excludedFolderNames: "LUB",
	globalTags: "obsidian",
};

export function parseExcludedFolders(value: string): string[] {
	if (!value || !value.trim()) return [];
	return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseGlobalTags(value: string): string[] {
	if (!value || !value.trim()) return [];
	return value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}
