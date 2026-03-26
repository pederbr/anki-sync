import { TFile, type Vault } from "obsidian";
import type { PluginSettings } from "./settings";

/** Collapse whitespace and newlines so each log record stays one line. */
export function truncateOneLine(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return flat.slice(0, max) + "…";
}

async function ensureParentFolders(vault: Vault, filePath: string): Promise<void> {
	const normalized = filePath.replace(/\\/g, "/");
	const lastSlash = normalized.lastIndexOf("/");
	if (lastSlash <= 0) return;
	const dir = normalized.slice(0, lastSlash);
	const parts = dir.split("/").filter(Boolean);
	let acc = "";
	for (const p of parts) {
		acc = acc ? `${acc}/${p}` : p;
		if (!vault.getAbstractFileByPath(acc)) {
			await vault.createFolder(acc);
		}
	}
}

export class SyncDebugLogger {
	constructor(
		private vault: Vault,
		private relativePath: string,
		public enabled: boolean
	) {}

	async line(message: string): Promise<void> {
		if (!this.enabled) return;
		const ts = new Date().toISOString();
		const text = `[${ts}] ${message}\n`;
		try {
			const path = this.relativePath.trim().replace(/^\//, "");
			if (!path) return;
			await ensureParentFolders(this.vault, path);
			const existing = this.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.vault.append(existing, text);
			} else {
				await this.vault.create(path, text);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`[anki-sync] debug log write failed: ${msg}`);
		}
	}

	static fromSettings(vault: Vault, settings: PluginSettings): SyncDebugLogger | null {
		if (!settings.debugSyncLogEnabled) return null;
		const path =
			settings.debugSyncLogPath.trim() || "anki-sync-debug.log";
		return new SyncDebugLogger(vault, path, true);
	}

	async writeSessionHeader(settings: PluginSettings, mdFileCount: number): Promise<void> {
		await this.line("======== sync session start ========");
		await this.line(
			`settings: url=${settings.ankiConnectUrl} model=${settings.basicModel} deckTop=${settings.defaultBasicDeckPrefix || "(vault name)"} mode=${settings.cardUpdateMode} heading=h${settings.sectionHeadingLevel} introCard=${settings.createIntroCard} vaultRoot=${settings.vaultRootSubpath || "(all)"} attachmentsFolder=${settings.attachmentsFolderName || "(none)"} excluded=${settings.excludedFolderNames || "(none)"} globalTags=${settings.globalTags || "(none)"} deleteRemoved=${settings.deleteRemovedNotes}`
		);
		await this.line(`markdown files matched: ${mdFileCount}`);
	}
}
