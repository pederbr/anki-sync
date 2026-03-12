export type CardUpdateMode = "replace" | "append";

export interface SyncState {
	cardHashes: Record<string, string>;
	cardNoteIds: Record<string, number>;
}

export interface PluginSettings {
	ankiConnectUrl: string;
	basicModel: string;
	defaultBasicDeckPrefix: string;
	cardUpdateMode: CardUpdateMode;
	enableBackgroundSync: boolean;
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
	defaultBasicDeckPrefix: "Obsidian",
	cardUpdateMode: "replace",
	enableBackgroundSync: true,
	deleteRemovedNotes: true,
	sectionHeadingLevel: 2,
	createIntroCard: true,
	vaultRootSubpath: "",
	excludedFolderNames: "LUB",
	globalTags: "obsidian",
};

export const EMPTY_SYNC_STATE: SyncState = {
	cardHashes: {},
	cardNoteIds: {},
};

export function normalizeSyncState(raw: unknown): SyncState {
	if (raw == null || typeof raw !== "object") return { ...EMPTY_SYNC_STATE };
	const src = raw as Partial<SyncState>;
	const cardHashes: Record<string, string> = {};
	const cardNoteIds: Record<string, number> = {};

	if (src.cardHashes != null && typeof src.cardHashes === "object") {
		for (const [key, value] of Object.entries(src.cardHashes)) {
			if (typeof value === "string") cardHashes[key] = value;
		}
	}
	if (src.cardNoteIds != null && typeof src.cardNoteIds === "object") {
		for (const [key, value] of Object.entries(src.cardNoteIds)) {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				cardNoteIds[key] = value;
			}
		}
	}

	return { cardHashes, cardNoteIds };
}

export function parseExcludedFolders(value: string): string[] {
	if (!value || !value.trim()) return [];
	return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseGlobalTags(value: string): string[] {
	if (!value || !value.trim()) return [];
	return value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}
