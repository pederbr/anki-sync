import type { TFile, Vault } from "obsidian";
import type { PluginSettings, SyncState } from "./settings";
import { parseExcludedFolders, parseGlobalTags } from "./settings";
import * as anki from "./ankiClient";
import { listMarkdownFiles, indexImageFiles } from "./vaultScanner";
import { extractCardsFromFile } from "./parser";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export type LogLevel = "info" | "warn" | "error";

export interface SyncEvent {
	level: LogLevel;
	message: string;
}

export interface SyncProgress {
	processedFiles: number;
	totalFiles: number;
	currentFile: string | null;
}

export interface SyncResult {
	totalCards: number;
	syncedCards: number;
	skippedCards: number;
	nextState: SyncState;
}

function targetDeckName(deckPrefix: string): string {
	const trimmed = deckPrefix.trim();
	return trimmed.length > 0 ? trimmed : "Obsidian";
}

function hashText(input: string): string {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function cardStateKey(deckName: string, front: string): string {
	return `${deckName}\u241f${front}`;
}

export async function runFullSync(
	settings: PluginSettings,
	vault: Vault,
	previousState: SyncState,
	onEvent: (event: SyncEvent) => void,
	onProgress?: (progress: SyncProgress) => void
): Promise<SyncResult> {
	const log = (level: LogLevel, message: string) => onEvent({ level, message });

	const ok = await anki.checkAnkiRunning(settings.ankiConnectUrl);
	if (!ok) {
		log("error", "Anki/AnkiConnect is not reachable. Is Anki open with AnkiConnect installed?");
		return { totalCards: 0, syncedCards: 0, skippedCards: 0, nextState: previousState };
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
	onProgress?.({ processedFiles: 0, totalFiles: mdFiles.length, currentFile: null });

	const keptIds = new Set<number>();
	const nextCardHashes: Record<string, string> = {};
	const nextCardNoteIds: Record<string, number> = {};
	let totalCards = 0;
	let syncedCards = 0;
	let skippedCards = 0;

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

	for (let fileIndex = 0; fileIndex < mdFiles.length; fileIndex++) {
		const file = mdFiles[fileIndex]!;
		const deckName = targetDeckName(settings.defaultBasicDeckPrefix);
		const fileTag = file.basename.replace(/\s/g, "_");
		const tags = [...globalTagsList, fileTag];

		log("info", `File: ${file.path} → Deck: ${deckName}`);

		let content: string;
		try {
			content = await vault.read(file);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			log("error", `Could not read ${file.path}: ${message}`);
			onProgress?.({
				processedFiles: fileIndex + 1,
				totalFiles: mdFiles.length,
				currentFile: file.path,
			});
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
			totalCards++;
			const key = cardStateKey(deckName, card.front);
			const cardHash = hashText(`${deckName}\n${card.front}\n${card.back}\n${tags.join(" ")}`);
			const previousHash = previousState.cardHashes[key];
			const previousNoteId = previousState.cardNoteIds[key];
			if (previousHash === cardHash && typeof previousNoteId === "number" && previousNoteId > 0) {
				keptIds.add(previousNoteId);
				nextCardHashes[key] = cardHash;
				nextCardNoteIds[key] = previousNoteId;
				skippedCards++;
				continue;
			}

			let nid: number;
			if (settings.cardUpdateMode === "replace") {
				nid = await anki.upsertBasic(config, card.front, card.back, deckName, tags);
			} else {
				nid = await anki.appendBasic(config, card.front, card.back, deckName, tags);
				if (nid <= 0) {
					const existingId = await anki.findExistingNote(
						settings.ankiConnectUrl,
						deckName,
						card.front
					);
					nid = existingId ?? -1;
				}
			}
			if (nid > 0) {
				keptIds.add(nid);
				nextCardHashes[key] = cardHash;
				nextCardNoteIds[key] = nid;
				syncedCards++;
			}
		}
		onProgress?.({
			processedFiles: fileIndex + 1,
			totalFiles: mdFiles.length,
			currentFile: file.path,
		});
	}

	if (settings.deleteRemovedNotes && globalTagsList.length > 0) {
		const deckRoot = settings.defaultBasicDeckPrefix;
		const tag = globalTagsList[0]!;
		const deleted = await anki.deleteRemovedNotes(
			settings.ankiConnectUrl,
			keptIds,
			deckRoot,
			tag
		);
		if (deleted > 0) log("info", `Deleted ${deleted} notes no longer in vault.`);
	}

	log(
		"info",
		`Sync complete. Cards seen: ${totalCards}, synced: ${syncedCards}, unchanged: ${skippedCards}.`
	);
	return {
		totalCards,
		syncedCards,
		skippedCards,
		nextState: { cardHashes: nextCardHashes, cardNoteIds: nextCardNoteIds },
	};
}
