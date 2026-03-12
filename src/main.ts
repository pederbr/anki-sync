import { Plugin, TAbstractFile, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	type PluginSettings,
	type SyncState,
	normalizeSyncState,
} from "./settings";
import { AnkiSyncSettingTab } from "./AnkiSyncSettingTab";
import { SyncModal } from "./SyncModal";
import { runFullSync, type SyncProgress } from "./syncEngine";

export type LogLevel = "info" | "warn" | "error";

export default class AnkiSyncPlugin extends Plugin {
	settings: PluginSettings;
	syncState: SyncState;
	private backgroundSyncTimer: number | null = null;
	private statusHideTimer: number | null = null;
	private statusWidgetEl: HTMLDivElement | null = null;
	private statusFillEl: HTMLDivElement | null = null;
	private statusTextEl: HTMLSpanElement | null = null;
	private syncInProgress = false;
	private syncQueued = false;
	private activeSync: Promise<void> | null = null;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("sync", "Sync to Anki (background)", () =>
			this.scheduleBackgroundSync("manual ribbon click", 0, true)
		);
		this.addCommand({
			id: "sync-to-anki",
			name: "Sync to Anki",
			callback: () => this.scheduleBackgroundSync("manual command", 0, true),
		});
		this.addCommand({
			id: "sync-to-anki-background",
			name: "Sync to Anki in background",
			callback: () => this.scheduleBackgroundSync("manual command", 0),
		});
		this.addCommand({
			id: "open-sync-view",
			name: "Open sync view",
			callback: () => this.openSyncModal(),
		});
		this.addSettingTab(new AnkiSyncSettingTab(this.app, this));
		this.setupStatusWidget();

		this.registerEvent(
			this.app.vault.on("modify", (file) => this.onVaultFileChanged(file, "file modified"))
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => this.onVaultFileChanged(file, "file created"))
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => this.onVaultFileChanged(file, "file deleted"))
		);
		this.registerEvent(
			this.app.vault.on("rename", (file) => this.onVaultFileChanged(file, "file renamed"))
		);
	}

	onunload() {
		if (this.backgroundSyncTimer != null) {
			window.clearTimeout(this.backgroundSyncTimer);
			this.backgroundSyncTimer = null;
		}
		if (this.statusHideTimer != null) {
			window.clearTimeout(this.statusHideTimer);
			this.statusHideTimer = null;
		}
	}

	async loadSettings() {
		const raw = (await this.loadData()) as unknown;
		const source = (raw ?? {}) as
			| (Partial<PluginSettings> & { settings?: Partial<PluginSettings>; syncState?: unknown })
			| null;
		const loadedSettings = source?.settings ?? source ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...loadedSettings };
		this.syncState = normalizeSyncState(source?.syncState);
	}

	async saveSettings() {
		await this.saveData({ settings: this.settings, syncState: this.syncState });
	}

	openSyncModal() {
		new SyncModal(this.app, this).open();
	}

	async runFullSync(
		onLog: (level: LogLevel, message: string) => void,
		onProgress?: (progress: SyncProgress) => void
	): Promise<void> {
		if (this.syncInProgress) {
			this.syncQueued = true;
			onLog("info", "A sync is already running. Queued another pass.");
			await this.activeSync;
			return;
		}

		this.activeSync = this.runSyncLoop(onLog, onProgress);
		await this.activeSync;
	}

	private async runSyncLoop(
		onLog: (level: LogLevel, message: string) => void,
		onProgress?: (progress: SyncProgress) => void
	): Promise<void> {
		// Drop pending background triggers before a fresh run starts.
		if (this.backgroundSyncTimer != null) {
			window.clearTimeout(this.backgroundSyncTimer);
			this.backgroundSyncTimer = null;
		}
		this.syncInProgress = true;
		this.setStatusRunning(0, 1, "Starting sync...");
		let hadError = false;
		try {
			do {
				this.syncQueued = false;
				const result = await runFullSync(
					this.settings,
					this.app.vault,
					this.syncState,
					(ev) => {
						if (ev.level === "error") hadError = true;
						onLog(ev.level, ev.message);
					},
					(progress) => {
						this.setStatusRunning(
							progress.processedFiles,
							Math.max(progress.totalFiles, 1),
							progress.totalFiles > 0
								? `Syncing ${progress.processedFiles}/${progress.totalFiles}`
								: "No markdown files"
						);
						onProgress?.(progress);
					}
				);
				this.syncState = result.nextState;
				await this.saveSettings();
			} while (this.syncQueued);
			if (hadError) this.setStatusError("Sync finished with errors");
			else this.setStatusDone("Sync complete");
		} finally {
			this.syncInProgress = false;
			this.activeSync = null;
		}
	}

	private onVaultFileChanged(file: TAbstractFile, reason: string): void {
		if (!(file instanceof TFile)) return;
		if (file.extension.toLowerCase() !== "md") return;
		// Ignore file events while syncing to avoid immediate follow-up reruns.
		if (this.syncInProgress) return;
		this.scheduleBackgroundSync(reason);
	}

	private scheduleBackgroundSync(reason: string, delayMs = 1500, immediate = false): void {
		if (!this.settings.enableBackgroundSync) return;
		if (this.backgroundSyncTimer != null) {
			window.clearTimeout(this.backgroundSyncTimer);
		}
		if (!immediate) {
			this.setStatusQueued("Sync queued...");
		}
		this.backgroundSyncTimer = window.setTimeout(() => {
			this.backgroundSyncTimer = null;
			void this
				.runFullSync((level, message) => {
					if (level === "error") {
						console.error(`[anki-sync][background] ${reason}: ${message}`);
					}
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					this.setStatusError("Sync failed");
					console.error(`[anki-sync][background] ${reason}: ${message}`);
				});
		}, delayMs);
	}

	private setupStatusWidget(): void {
		const root = this.addStatusBarItem();
		root.empty();
		root.addClass("anki-sync-status-root");
		const widget = root.createDiv({ cls: "anki-sync-status-widget is-hidden" });
		const track = widget.createDiv({ cls: "anki-sync-status-track" });
		this.statusFillEl = track.createDiv({ cls: "anki-sync-status-fill" });
		this.statusTextEl = widget.createEl("span", {
			cls: "anki-sync-status-text",
			text: "Anki sync idle",
		});
		this.statusWidgetEl = widget;
	}

	private setStatusRunning(processedFiles: number, totalFiles: number, text: string): void {
		if (!this.statusWidgetEl || !this.statusFillEl || !this.statusTextEl) return;
		if (this.statusHideTimer != null) {
			window.clearTimeout(this.statusHideTimer);
			this.statusHideTimer = null;
		}
		const safeTotal = Math.max(totalFiles, 1);
		const ratio = Math.max(0, Math.min(1, processedFiles / safeTotal));
		this.statusFillEl.style.width = `${Math.round(ratio * 100)}%`;
		this.statusTextEl.setText(text);
		this.statusWidgetEl.removeClass("is-hidden");
		this.statusWidgetEl.removeClass("is-error");
	}

	private setStatusQueued(text: string): void {
		this.setStatusRunning(0, 1, text);
	}

	private setStatusDone(text: string): void {
		if (!this.statusWidgetEl || !this.statusFillEl || !this.statusTextEl) return;
		this.statusFillEl.style.width = "100%";
		this.statusTextEl.setText(text);
		this.statusWidgetEl.removeClass("is-error");
		this.statusWidgetEl.removeClass("is-hidden");
		if (this.statusHideTimer != null) window.clearTimeout(this.statusHideTimer);
		this.statusHideTimer = window.setTimeout(() => {
			this.statusWidgetEl?.addClass("is-hidden");
			this.statusHideTimer = null;
		}, 2500);
	}

	private setStatusError(text: string): void {
		if (!this.statusWidgetEl || !this.statusTextEl) return;
		this.statusWidgetEl.removeClass("is-hidden");
		this.statusWidgetEl.addClass("is-error");
		this.statusTextEl.setText(text);
	}
}
