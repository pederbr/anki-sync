import type { App, TFile, Vault } from "obsidian";
import type { PluginSettings, SyncState } from "./settings";
import { parseExcludedFolders, parseGlobalTags } from "./settings";
import * as anki from "./ankiClient";
import { listMarkdownFiles, indexImageFiles } from "./vaultScanner";
import { extractCardsFromFile, type ImageResolveContext } from "./parser";
import { SyncDebugLogger, truncateOneLine } from "./syncDebugLog";
import { ankiDeckNameForMarkdownFile, ankiDeckRootForManagedNotes } from "./deckPath";

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
	failedCards: number;
	nextState: SyncState;
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
	app: App,
	previousState: SyncState,
	onEvent: (event: SyncEvent) => void,
	onProgress?: (progress: SyncProgress) => void
): Promise<SyncResult> {
	const vault = app.vault;
	const log = (level: LogLevel, message: string) => onEvent({ level, message });

	const conn = await anki.ensureAnkiConnectReady(
		settings.ankiConnectUrl,
		settings.ankiConnectApiKey
	);
	const debugLog = SyncDebugLogger.fromSettings(vault, settings);

	if (!conn.ok) {
		log("error", conn.message);
		await debugLog?.line(`CONNECT_FAILED ${conn.message}`);
		return { totalCards: 0, syncedCards: 0, skippedCards: 0, failedCards: 0, nextState: previousState };
	}

	const excludedFolders = parseExcludedFolders(settings.excludedFolderNames);
	const globalTagsList = parseGlobalTags(settings.globalTags);
	if (settings.deleteRemovedNotes && globalTagsList.length === 0) {
		log("warn", "Global tags are empty; deletion of removed notes will be skipped.");
	}

	const config: anki.AnkiClientConfig = {
		baseUrl: settings.ankiConnectUrl.trim(),
		apiKey: settings.ankiConnectApiKey,
		basicModel: settings.basicModel,
	};
	const auth: anki.AnkiConnectAuth = {
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
	};

	const imageIndex = indexImageFiles(vault, settings.vaultRootSubpath, excludedFolders);
	log("info", `Indexed ${imageIndex.size} image files.`);

	const mdFiles = listMarkdownFiles(vault, settings.vaultRootSubpath, excludedFolders);
	log("info", `Found ${mdFiles.length} markdown files to sync.`);
	await debugLog?.writeSessionHeader(settings, mdFiles.length);
	onProgress?.({ processedFiles: 0, totalFiles: mdFiles.length, currentFile: null });

	const keptIds = new Set<number>();
	const nextCardHashes: Record<string, string> = {};
	const nextCardNoteIds: Record<string, number> = {};
	let totalCards = 0;
	let syncedCards = 0;
	let skippedCards = 0;
	let failedCards = 0;

	const uploadedMedia = new Set<string>();
	const storeMedia = async (file: TFile): Promise<string> => {
		if (uploadedMedia.has(file.name)) return file.name;
		const data = await vault.readBinary(file);
		const b64 = arrayBufferToBase64(data);
		await anki.storeMediaFile(auth, file.name, b64);
		uploadedMedia.add(file.name);
		return file.name;
	};

	const extractOptions = {
		sectionHeadingLevel: settings.sectionHeadingLevel,
		createIntroCard: settings.createIntroCard,
	};

	for (let fileIndex = 0; fileIndex < mdFiles.length; fileIndex++) {
		const file = mdFiles[fileIndex]!;
		const deckName = ankiDeckNameForMarkdownFile(
			vault,
			file,
			settings.defaultBasicDeckPrefix
		);
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

		const imageCtx: ImageResolveContext = {
			vault,
			metadataCache: app.metadataCache,
			sourcePath: file.path,
			imageIndex,
			attachmentsFolderName: settings.attachmentsFolderName,
		};
		const cards = await extractCardsFromFile(
			content,
			file,
			extractOptions,
			imageCtx,
			storeMedia
		);

		await debugLog?.line(
			`FILE ${file.path} extractedCards=${cards.length} deck=${deckName}`
		);

		const candidateSkipNoteIds: number[] = [];
		for (let i = 0; i < cards.length; i++) {
			const c = cards[i]!;
			const k = cardStateKey(deckName, c.front);
			const h = hashText(`${deckName}\n${c.front}\n${c.back}\n${tags.join(" ")}`);
			const prevH = previousState.cardHashes[k];
			const prevId = previousState.cardNoteIds[k];
			if (prevH === h && typeof prevId === "number" && prevId > 0) {
				candidateSkipNoteIds.push(prevId);
			}
		}
		const uniqueSkipIds = [...new Set(candidateSkipNoteIds)];
		let notesStillInAnki: Set<number> = new Set();
		if (uniqueSkipIds.length > 0) {
			notesStillInAnki = await anki.noteIdsStillInAnki(auth, uniqueSkipIds);
		}

		for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
			const card = cards[cardIndex]!;
			totalCards++;
			const key = cardStateKey(deckName, card.front);
			const cardHash = hashText(`${deckName}\n${card.front}\n${card.back}\n${tags.join(" ")}`);
			const previousHash = previousState.cardHashes[key];
			const previousNoteId = previousState.cardNoteIds[key];
			const frontPreview = truncateOneLine(card.front, 100);
			if (previousHash === cardHash && typeof previousNoteId === "number" && previousNoteId > 0) {
				if (notesStillInAnki.has(previousNoteId)) {
					keptIds.add(previousNoteId);
					nextCardHashes[key] = cardHash;
					nextCardNoteIds[key] = previousNoteId;
					skippedCards++;
					await debugLog?.line(
						`CARD ${file.path} #${cardIndex + 1}/${cards.length} SKIP_UNCHANGED noteId=${previousNoteId} front=${JSON.stringify(frontPreview)}`
					);
					continue;
				}
				await debugLog?.line(
					`CARD ${file.path} #${cardIndex + 1}/${cards.length} RESYNC noteId=${previousNoteId} missing in Anki front=${JSON.stringify(frontPreview)}`
				);
			}

			let nid = -1;
			try {
				if (settings.cardUpdateMode === "replace") {
					nid = await anki.upsertBasic(config, card.front, card.back, deckName, tags);
				} else {
					nid = await anki.appendBasic(config, card.front, card.back, deckName, tags);
					if (nid <= 0) {
						const existingId = await anki.findExistingNote(auth, deckName, card.front);
						nid = existingId ?? -1;
					}
				}
			} catch (e: unknown) {
				failedCards++;
				const msg = e instanceof Error ? e.message : String(e);
				await debugLog?.line(
					`CARD ${file.path} #${cardIndex + 1}/${cards.length} ERROR_ANKI front=${JSON.stringify(frontPreview)} :: ${msg}`
				);
				log("error", `${file.path} card ${cardIndex + 1}: ${msg}`);
				continue;
			}

			if (nid > 0) {
				keptIds.add(nid);
				nextCardHashes[key] = cardHash;
				nextCardNoteIds[key] = nid;
				syncedCards++;
				await debugLog?.line(
					`CARD ${file.path} #${cardIndex + 1}/${cards.length} OK noteId=${nid} front=${JSON.stringify(frontPreview)}`
				);
			} else {
				failedCards++;
				await debugLog?.line(
					`CARD ${file.path} #${cardIndex + 1}/${cards.length} FAIL_NO_NOTE_ID mode=${settings.cardUpdateMode} front=${JSON.stringify(frontPreview)}`
				);
				log(
					"warn",
					`Could not get Anki note id for ${file.path} (card ${cardIndex + 1}); see debug log for detail.`
				);
			}
		}
		onProgress?.({
			processedFiles: fileIndex + 1,
			totalFiles: mdFiles.length,
			currentFile: file.path,
		});
	}

	if (settings.deleteRemovedNotes && globalTagsList.length > 0) {
		const deckRoot = ankiDeckRootForManagedNotes(vault, settings.defaultBasicDeckPrefix);
		const tag = globalTagsList[0]!;
		const deleted = await anki.deleteRemovedNotes(auth, keptIds, deckRoot, tag);
		if (deleted > 0) log("info", `Deleted ${deleted} notes no longer in vault.`);
	}

	log(
		"info",
		`Sync complete. Cards seen: ${totalCards}, synced: ${syncedCards}, unchanged: ${skippedCards}${
			failedCards > 0 ? `, failed: ${failedCards}` : ""
		}.`
	);
	await debugLog?.line(
		`======== sync session end: seen=${totalCards} synced=${syncedCards} unchanged=${skippedCards} failed=${failedCards} ========`
	);
	return {
		totalCards,
		syncedCards,
		skippedCards,
		failedCards,
		nextState: { cardHashes: nextCardHashes, cardNoteIds: nextCardNoteIds },
	};
}
