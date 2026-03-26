export type CardUpdateMode = "replace" | "append";

export interface SyncState {
	cardHashes: Record<string, string>;
	cardNoteIds: Record<string, number>;
}

export interface PluginSettings {
	ankiConnectUrl: string;
	/** Same as AnkiConnect add-on config `apiKey` when that feature is enabled (sent as top-level `key` in JSON). */
	ankiConnectApiKey: string;
	basicModel: string;
	defaultBasicDeckPrefix: string;
	cardUpdateMode: CardUpdateMode;
	/** When false, vault file events do not queue sync; ribbon/commands still sync. */
	enableBackgroundSync: boolean;
	deleteRemovedNotes: boolean;
	sectionHeadingLevel: 1 | 2 | 3 | 4 | 5 | 6;
	createIntroCard: boolean;
	vaultRootSubpath: string;
	/**
	 * Folder under the vault root where attachments live (e.g. `attachments`, `Assets`).
	 * Used as a fallback when resolving bare image filenames. Leave empty if you only use full paths or Obsidian’s link resolution.
	 */
	attachmentsFolderName: string;
	excludedFolderNames: string;
	globalTags: string;
	/** Append human-readable sync traces to this vault path (markdown or .log). */
	debugSyncLogEnabled: boolean;
	debugSyncLogPath: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	ankiConnectUrl: "http://127.0.0.1:8765",
	ankiConnectApiKey: "",
	basicModel: "Basic",
	/** Leading Anki deck segment; empty uses vault folder name. Full deck = this::folders::noteTitle. */
	defaultBasicDeckPrefix: "",
	cardUpdateMode: "replace",
	enableBackgroundSync: true,
	deleteRemovedNotes: true,
	sectionHeadingLevel: 2,
	createIntroCard: true,
	vaultRootSubpath: "",
	attachmentsFolderName: "",
	excludedFolderNames: "LUB",
	globalTags: "obsidian",
	debugSyncLogEnabled: false,
	debugSyncLogPath: "anki-sync-debug.log",
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
