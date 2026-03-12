import { requestUrl } from "obsidian";

const ANKI_CONNECT_VERSION = 6;

export interface AnkiClientConfig {
	baseUrl: string;
	basicModel: string;
}

interface AnkiResponse<T = unknown> {
	result: T;
	error: string | null;
}

function cleanText(t: string): string {
	let out = "";
	for (let i = 0; i < t.length; i++) {
		const code = t.charCodeAt(i);
		if (code >= 32 && code !== 127) {
			out += t[i]!;
		}
	}
	return out;
}

export async function invoke<T = unknown>(
	baseUrl: string,
	action: string,
	params: Record<string, unknown> = {}
): Promise<T> {
	const payload = { action, version: ANKI_CONNECT_VERSION, params };
	const res = await requestUrl({
		url: baseUrl,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const data = res.json as AnkiResponse<T>;
	if (data.error != null) {
		throw new Error(`AnkiConnect error in ${action}: ${data.error}`);
	}
	return data.result;
}

export async function checkAnkiRunning(baseUrl: string): Promise<boolean> {
	try {
		const data = await invoke<number>(baseUrl, "version");
		return typeof data === "number";
	} catch {
		return false;
	}
}

export async function ensureDeck(baseUrl: string, deckName: string): Promise<void> {
	await invoke(baseUrl, "createDeck", { deck: deckName });
}

export async function findExistingNote(
	baseUrl: string,
	deck: string,
	front: string
): Promise<number | null> {
	const cleaned = cleanText(front);
	const safeFront = cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const query = `deck:"${deck}" front:"${safeFront}"`;
	let noteIds: number[];
	try {
		noteIds = await invoke<number[]>(baseUrl, "findNotes", { query });
	} catch {
		const fuzzy = cleaned.slice(0, 30).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		noteIds = await invoke<number[]>(baseUrl, "findNotes", { query: `"${fuzzy}"` });
	}
	if (noteIds.length === 0) return null;
	const id = noteIds[0];
	return typeof id === "number" ? id : null;
}

export async function addNote(
	baseUrl: string,
	deckName: string,
	modelName: string,
	fields: Record<string, string>,
	tags: string[]
): Promise<number> {
	const note = { deckName, modelName, fields, tags };
	return invoke<number>(baseUrl, "addNote", { note });
}

export async function updateNoteFields(
	baseUrl: string,
	noteId: number,
	fields: Record<string, string>
): Promise<void> {
	await invoke(baseUrl, "updateNoteFields", { note: { id: noteId, fields } });
}

export async function addTagsToNotes(
	baseUrl: string,
	noteIds: number[],
	tags: string
): Promise<void> {
	if (!tags.trim()) return;
	await invoke(baseUrl, "addTags", { notes: noteIds, tags });
}

export async function upsertBasic(
	config: AnkiClientConfig,
	front: string,
	back: string,
	deck: string,
	tags: string[]
): Promise<number> {
	await ensureDeck(config.baseUrl, deck);
	const existingId = await findExistingNote(config.baseUrl, deck, front);
	if (existingId != null) {
		await updateNoteFields(config.baseUrl, existingId, { Front: front, Back: back });
		await addTagsToNotes(config.baseUrl, [existingId], tags.join(" "));
		return existingId;
	}
	try {
		return await addNote(
			config.baseUrl,
			deck,
			config.basicModel,
			{ Front: front, Back: back },
			tags
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.toLowerCase().includes("duplicate")) {
			const id = await findExistingNote(config.baseUrl, deck, front);
			if (id != null) {
				await updateNoteFields(config.baseUrl, id, { Front: front, Back: back });
				await addTagsToNotes(config.baseUrl, [id], tags.join(" "));
				return id;
			}
			return -1;
		}
		throw e;
	}
}

export async function appendBasic(
	config: AnkiClientConfig,
	front: string,
	back: string,
	deck: string,
	tags: string[]
): Promise<number> {
	await ensureDeck(config.baseUrl, deck);
	const existingId = await findExistingNote(config.baseUrl, deck, front);
	if (existingId != null) return -1;
	try {
		return await addNote(
			config.baseUrl,
			deck,
			config.basicModel,
			{ Front: front, Back: back },
			tags
		);
	} catch {
		return -1;
	}
}
export async function storeMediaFile(
	baseUrl: string,
	filename: string,
	dataBase64: string
): Promise<void> {
	await invoke(baseUrl, "storeMediaFile", { filename, data: dataBase64 });
}

export async function deleteRemovedNotes(
	baseUrl: string,
	keptIds: Set<number>,
	deckRoot: string,
	globalTag: string
): Promise<number> {
	if (!globalTag.trim()) return 0;
	const query = `tag:"${globalTag}" deck:"${deckRoot}"`;
	const managedIds = await invoke<number[]>(baseUrl, "findNotes", { query });
	const toDelete = managedIds.filter((id) => !keptIds.has(id));
	if (toDelete.length === 0) return 0;
	await invoke(baseUrl, "deleteNotes", { notes: toDelete });
	return toDelete.length;
}
