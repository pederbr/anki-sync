import type { TFile, Vault } from "obsidian";
import type { PluginSettings } from "./settings";
import { parseExcludedFolders, parseGlobalTags } from "./settings";
import * as anki from "./ankiClient";
import { listMarkdownFiles, indexImageFiles } from "./vaultScanner";
import { extractCardsFromFile } from "./parser";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

export type LogLevel = "info" | "warn" | "error";

export interface SyncEvent {
	level: LogLevel;
	message: string;
}

function deckNameFromPath(deckPrefix: string, filePath: string): string {
	const withoutExt = filePath.replace(/\.md$/i, "");
	const parts = withoutExt.split("/").filter(Boolean);
	const name = parts.length > 0 ? parts[parts.length - 1] : "Notes";
	const parentParts = parts.slice(0, -1);
	const deckParts = [deckPrefix, ...parentParts, name];
	return deckParts.join("::");
}

export async function runFullSync(
	settings: PluginSettings,
	vault: Vault,
	onEvent: (event: SyncEvent) => void
): Promise<void> {
	const log = (level: LogLevel, message: string) => onEvent({ level, message });

	const ok = await anki.checkAnkiRunning(settings.ankiConnectUrl);
	if (!ok) {
		log("error", "Anki/AnkiConnect is not reachable. Is Anki open with AnkiConnect installed?");
		return;
	}

	const excludedFolders = parseExcludedFolders(settings.excludedFolderNames);
	const globalTagsList = parseGlobalTags(settings.globalTags);
	if (settings.deleteRemovedNotes && globalTagsList.length === 0) {
		log("warn", "Global tags are empty; deletion of removed notes will be skipped.");
	}

	const config: anki.AnkiClientConfig = {
		baseUrl: settings.ankiConnectUrl,
		basicModel: settings.basicModel,
	};

	const imageIndex = indexImageFiles(vault, settings.vaultRootSubpath, excludedFolders);
	log("info", `Indexed ${imageIndex.size} image files.`);

	const mdFiles = listMarkdownFiles(vault, settings.vaultRootSubpath, excludedFolders);
	log("info", `Found ${mdFiles.length} markdown files to sync.`);

	const keptIds = new Set<number>();
	let totalBasic = 0;

	const uploadedMedia = new Set<string>();
	const storeMedia = async (file: TFile): Promise<string> => {
		if (uploadedMedia.has(file.name)) return file.name;
		const data = await vault.readBinary(file);
		const b64 = arrayBufferToBase64(data);
		await anki.storeMediaFile(settings.ankiConnectUrl, file.name, b64);
		uploadedMedia.add(file.name);
		return file.name;
	};

	const extractOptions = {
		sectionHeadingLevel: settings.sectionHeadingLevel,
		createIntroCard: settings.createIntroCard,
	};

	for (const file of mdFiles) {
		const deckName = deckNameFromPath(settings.defaultBasicDeckPrefix, file.path);
		const fileTag = file.basename.replace(/\s/g, "_");
		const tags = [...globalTagsList, fileTag];

		log("info", `File: ${file.path} → Deck: ${deckName}`);

		let content: string;
		try {
			content = await vault.read(file);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			log("error", `Could not read ${file.path}: ${message}`);
			continue;
		}

		const cards = await extractCardsFromFile(
			content,
			file,
			extractOptions,
			imageIndex,
			storeMedia
		);

		for (const card of cards) {
			let nid: number;
			if (settings.cardUpdateMode === "replace") {
				nid = await anki.upsertBasic(config, card.front, card.back, deckName, tags);
			} else {
				nid = await anki.appendBasic(config, card.front, card.back, deckName, tags);
			}
			if (nid > 0) {
				keptIds.add(nid);
				totalBasic++;
			}
		}
	}

	if (settings.deleteRemovedNotes && globalTagsList.length > 0) {
		const deckRoot = settings.defaultBasicDeckPrefix;
		const tag = globalTagsList[0];
		const deleted = await anki.deleteRemovedNotes(
			settings.ankiConnectUrl,
			keptIds,
			deckRoot,
			tag
		);
		if (deleted > 0) log("info", `Deleted ${deleted} notes no longer in vault.`);
	}

	log("info", `Sync complete. Basic: ${totalBasic}.`);
}
