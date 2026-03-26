import { requestUrl } from "obsidian";

const ANKI_CONNECT_VERSION = 6;

/** Connection/auth for all AnkiConnect calls except `requestPermission` (see docs). */
export interface AnkiConnectAuth {
	baseUrl: string;
	/** Same value as AnkiConnect config `apiKey` when API key auth is enabled. Omitted from `requestPermission`. */
	apiKey?: string;
}

export interface AnkiClientConfig extends AnkiConnectAuth {
	basicModel: string;
}

interface AnkiResponseV6<T = unknown> {
	result: T;
	error: string | null;
}

/** Result of `requestPermission` when permission is granted (AnkiConnect API v6). */
export interface RequestPermissionGranted {
	permission: "granted";
	requireApiKey: boolean;
	version: number;
}

export interface RequestPermissionDenied {
	permission: "denied";
}

export type RequestPermissionResult = RequestPermissionGranted | RequestPermissionDenied;

export type EnsureAnkiConnectResult =
	| { ok: true; apiVersion: number; requireApiKey: boolean }
	| { ok: false; message: string };

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

function parseV6Response<T>(data: unknown, action: string): AnkiResponseV6<T> {
	if (data == null || typeof data !== "object") {
		throw new Error(`AnkiConnect: invalid JSON for action "${action}"`);
	}
	const obj = data as Record<string, unknown>;
	if (!Object.prototype.hasOwnProperty.call(obj, "result")) {
		throw new Error(
			`AnkiConnect: response missing "result" (use request version ${ANKI_CONNECT_VERSION}). Action: ${action}`
		);
	}
	if (!Object.prototype.hasOwnProperty.call(obj, "error")) {
		throw new Error(
			`AnkiConnect: response missing "error" (use request version ${ANKI_CONNECT_VERSION}). Action: ${action}`
		);
	}
	return obj as unknown as AnkiResponseV6<T>;
}

/**
 * POST JSON body: `{ action, version, params }` and optional top-level `key` per AnkiConnect spec.
 * `requestPermission` must not include `key`; other actions must include `key` when AnkiConnect requires it.
 */
export async function invoke<T = unknown>(
	baseUrl: string,
	action: string,
	params: Record<string, unknown> = {},
	options?: { apiKey?: string; omitApiKey?: boolean }
): Promise<T> {
	const body: Record<string, unknown> = {
		action,
		version: ANKI_CONNECT_VERSION,
		params,
	};
	const key = options?.apiKey?.trim();
	if (!options?.omitApiKey && key) {
		body.key = key;
	}

	const res = await requestUrl({
		url: baseUrl,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (res.status < 200 || res.status >= 300) {
		const hint = res.text?.trim() || "(empty body)";
		throw new Error(`AnkiConnect HTTP ${res.status} for "${action}": ${hint}`);
	}

	let parsed: unknown = res.json;
	if (parsed === undefined && typeof res.text === "string") {
		parsed = JSON.parse(res.text);
	}

	const data = parseV6Response<T>(parsed, action);
	if (data.error != null) {
		throw new Error(`AnkiConnect error in ${action}: ${data.error}`);
	}
	return data.result;
}

function invokeAuth<T>(
	auth: AnkiConnectAuth,
	action: string,
	params: Record<string, unknown> = {}
): Promise<T> {
	return invoke<T>(auth.baseUrl, action, params, { apiKey: auth.apiKey });
}

/**
 * First call recommended by AnkiConnect: validates origin/CORS and reports whether an API key is required.
 * Does not send `key` (per spec).
 */
export async function requestPermission(baseUrl: string): Promise<RequestPermissionResult> {
	return invoke<RequestPermissionResult>(baseUrl, "requestPermission", {}, { omitApiKey: true });
}

/**
 * Ensures Anki is reachable, permission is granted, and API key is present when AnkiConnect requires it.
 */
export async function ensureAnkiConnectReady(
	baseUrl: string,
	apiKey?: string
): Promise<EnsureAnkiConnectResult> {
	const trimmedUrl = baseUrl.trim();
	if (!trimmedUrl) {
		return { ok: false, message: "AnkiConnect URL is empty. Set it in plugin settings (e.g. http://127.0.0.1:8765)." };
	}

	let perm: RequestPermissionResult;
	try {
		perm = await requestPermission(trimmedUrl);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			message: `Cannot reach AnkiConnect at ${trimmedUrl}. Is Anki running with the AnkiConnect add-on? ${msg}`,
		};
	}

	if (perm.permission === "denied") {
		return {
			ok: false,
			message:
				"AnkiConnect denied this app (check the Anki permission dialog, or add Obsidian's origin to AnkiConnect config webCorsOriginList — see AnkiConnect README).",
		};
	}

	const requireKey = perm.requireApiKey === true;
	const trimmedKey = apiKey?.trim();
	if (requireKey && !trimmedKey) {
		return {
			ok: false,
			message:
				"AnkiConnect requires an API key. Set the same key in this plugin and in Anki: Tools → Add-ons → AnkiConnect → Config → apiKey.",
		};
	}

	return { ok: true, apiVersion: perm.version, requireApiKey: requireKey };
}

export async function checkAnkiRunning(baseUrl: string, apiKey?: string): Promise<boolean> {
	const r = await ensureAnkiConnectReady(baseUrl, apiKey);
	return r.ok;
}

export async function ensureDeck(auth: AnkiConnectAuth, deckName: string): Promise<void> {
	await invokeAuth(auth, "createDeck", { deck: deckName });
}

/**
 * Returns the subset of `noteIds` that still exist in the collection.
 * AnkiConnect `notesInfo` returns `{}` at the same index when a note was deleted.
 */
export async function noteIdsStillInAnki(
	auth: AnkiConnectAuth,
	noteIds: number[]
): Promise<Set<number>> {
	if (noteIds.length === 0) return new Set();
	const result = await invokeAuth<unknown[]>(auth, "notesInfo", { notes: noteIds });
	const alive = new Set<number>();
	for (let i = 0; i < noteIds.length; i++) {
		const info = result[i];
		if (
			info != null &&
			typeof info === "object" &&
			!Array.isArray(info) &&
			"noteId" in info &&
			typeof (info as { noteId?: unknown }).noteId === "number"
		) {
			alive.add(noteIds[i]!);
		}
	}
	return alive;
}

export async function findExistingNote(
	auth: AnkiConnectAuth,
	deck: string,
	front: string
): Promise<number | null> {
	const cleaned = cleanText(front);
	const safeFront = cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const query = `deck:"${deck}" front:"${safeFront}"`;
	let noteIds: number[];
	try {
		noteIds = await invokeAuth<number[]>(auth, "findNotes", { query });
	} catch {
		const fuzzy = cleaned.slice(0, 30).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		noteIds = await invokeAuth<number[]>(auth, "findNotes", { query: `"${fuzzy}"` });
	}
	if (noteIds.length === 0) return null;
	const id = noteIds[0];
	return typeof id === "number" ? id : null;
}

/** Matches AnkiConnect `addNote` / `canAddNotes` note shape; scope duplicates to this deck only. */
function basicNoteForAdd(
	deckName: string,
	modelName: string,
	fields: Record<string, string>,
	tags: string[]
) {
	return {
		deckName,
		modelName,
		fields,
		tags,
		// Default AnkiConnect duplicate check is collection-wide; same Front in another deck blocks add.
		// Only the target deck is empty — we still need to be allowed to create cards there.
		options: {
			allowDuplicate: false,
			duplicateScope: "deck" as const,
			duplicateScopeOptions: {
				deckName,
				checkChildren: true,
				checkAllModels: false,
			},
		},
	};
}

/**
 * AnkiConnect `addNote` returns `null` on failure without always setting `error` on the response,
 * so we ask `canAddNotesWithErrorDetail` when the id is missing.
 */
export async function addNote(
	auth: AnkiConnectAuth,
	deckName: string,
	modelName: string,
	fields: Record<string, string>,
	tags: string[]
): Promise<number> {
	const note = basicNoteForAdd(deckName, modelName, fields, tags);
	const id = await invokeAuth<number | null>(auth, "addNote", { note });
	if (typeof id === "number" && id > 0) return id;

	const details = await invokeAuth<
		{ canAdd: boolean; error?: string }[]
	>(auth, "canAddNotesWithErrorDetail", {
		notes: [basicNoteForAdd(deckName, modelName, fields, tags)],
	});
	const d = details[0];
	const reason =
		d?.error ??
		(d?.canAdd === false ? "cannot add note (see Anki note type / fields)" : "addNote returned null");
	throw new Error(`addNote failed: ${reason}`);
}

export async function updateNoteFields(
	auth: AnkiConnectAuth,
	noteId: number,
	fields: Record<string, string>
): Promise<void> {
	await invokeAuth(auth, "updateNoteFields", { note: { id: noteId, fields } });
}

export async function addTagsToNotes(
	auth: AnkiConnectAuth,
	noteIds: number[],
	tags: string
): Promise<void> {
	if (!tags.trim()) return;
	await invokeAuth(auth, "addTags", { notes: noteIds, tags });
}

export async function upsertBasic(
	config: AnkiClientConfig,
	front: string,
	back: string,
	deck: string,
	tags: string[]
): Promise<number> {
	const auth: AnkiConnectAuth = { baseUrl: config.baseUrl, apiKey: config.apiKey };
	await ensureDeck(auth, deck);
	const existingId = await findExistingNote(auth, deck, front);
	if (existingId != null) {
		await updateNoteFields(auth, existingId, { Front: front, Back: back });
		await addTagsToNotes(auth, [existingId], tags.join(" "));
		return existingId;
	}
	try {
		return await addNote(auth, deck, config.basicModel, { Front: front, Back: back }, tags);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.toLowerCase().includes("duplicate")) {
			const id = await findExistingNote(auth, deck, front);
			if (id != null) {
				await updateNoteFields(auth, id, { Front: front, Back: back });
				await addTagsToNotes(auth, [id], tags.join(" "));
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
	const auth: AnkiConnectAuth = { baseUrl: config.baseUrl, apiKey: config.apiKey };
	await ensureDeck(auth, deck);
	const existingId = await findExistingNote(auth, deck, front);
	if (existingId != null) return -1;
	try {
		return await addNote(auth, deck, config.basicModel, { Front: front, Back: back }, tags);
	} catch {
		return -1;
	}
}

export async function storeMediaFile(
	auth: AnkiConnectAuth,
	filename: string,
	dataBase64: string
): Promise<void> {
	await invokeAuth(auth, "storeMediaFile", { filename, data: dataBase64 });
}

export async function deleteRemovedNotes(
	auth: AnkiConnectAuth,
	keptIds: Set<number>,
	deckRoot: string,
	globalTag: string
): Promise<number> {
	if (!globalTag.trim()) return 0;
	const query = `tag:"${globalTag}" deck:"${deckRoot}"`;
	const managedIds = await invokeAuth<number[]>(auth, "findNotes", { query });
	const toDelete = managedIds.filter((id) => !keptIds.has(id));
	if (toDelete.length === 0) return 0;
	await invokeAuth(auth, "deleteNotes", { notes: toDelete });
	return toDelete.length;
}
