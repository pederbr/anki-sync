import { App, Modal, ButtonComponent } from "obsidian";
import type AnkiSyncPlugin from "./main";
import type { SyncProgress } from "./syncEngine";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
	level: LogLevel;
	message: string;
	timestamp: number;
}

const MAX_LOG_ENTRIES = 200;

export class SyncModal extends Modal {
	logEntries: LogEntry[] = [];
	logEl: HTMLPreElement | null = null;
	runButton: ButtonComponent | null = null;
	progressBarEl: HTMLProgressElement | null = null;
	progressLabelEl: HTMLDivElement | null = null;
	private plugin: AnkiSyncPlugin;

	constructor(app: App, plugin: AnkiSyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("anki-note-sync-modal");
		contentEl.createEl("h2", { text: "Anki note-sync" });

		contentEl.createEl("div", { cls: "anki-note-sync-status" }).setText("Idle");
		this.progressLabelEl = contentEl.createEl("div", { cls: "anki-note-sync-progress-label" });
		this.progressBarEl = contentEl.createEl("progress", { cls: "anki-note-sync-progress" });
		this.resetProgress();

		const buttonContainer = contentEl.createDiv();
		this.runButton = new ButtonComponent(buttonContainer)
			.setButtonText("Run sync")
			.setCta()
			.onClick(() => this.onRunSync());
		buttonContainer.createEl("br");

		this.logEl = contentEl.createEl("pre", { cls: "anki-note-sync-log" });
		this.logEl.setText("Log output will appear here after you run a sync.");
		this.refreshLogDisplay();
	}

	onClose(): void {
		this.contentEl.empty();
		this.logEl = null;
		this.runButton = null;
		this.progressBarEl = null;
		this.progressLabelEl = null;
	}

	appendLog(level: LogLevel, message: string): void {
		this.logEntries.push({ level, message, timestamp: Date.now() });
		if (this.logEntries.length > MAX_LOG_ENTRIES) this.logEntries.shift();
		this.refreshLogDisplay();
	}

	clearLog(): void {
		this.logEntries = [];
		this.refreshLogDisplay();
	}

	private refreshLogDisplay(): void {
		if (!this.logEl) return;
		if (this.logEntries.length === 0) {
			this.logEl.setText("Only errors are shown here.");
			this.logEl.querySelectorAll(".anki-note-sync-log-entry").forEach((el) => el.remove());
			return;
		}
		this.logEl.empty();
		this.logEl.setText("");
		for (const entry of this.logEntries) {
			const line = this.logEl.createEl("div", { cls: `anki-note-sync-log-entry ${entry.level}` });
			const time = new Date(entry.timestamp).toLocaleTimeString();
			line.setText(`[${time}] [${entry.level.toUpperCase()}] ${entry.message}`);
		}
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	setRunning(running: boolean): void {
		const status = this.contentEl.querySelector(".anki-note-sync-status");
		if (status) status.setText(running ? "Running…" : "Idle");
		if (this.runButton) this.runButton.setDisabled(running);
		if (!running && this.progressLabelEl) {
			this.progressLabelEl.setText("Progress: idle");
		}
	}

	setProgress(progress: SyncProgress): void {
		if (!this.progressBarEl || !this.progressLabelEl) return;
		const total = progress.totalFiles;
		const processed = Math.min(progress.processedFiles, total);
		if (total <= 0) {
			this.progressBarEl.max = 1;
			this.progressBarEl.value = 1;
			this.progressLabelEl.setText("Progress: no markdown files to sync");
			return;
		}
		this.progressBarEl.max = total;
		this.progressBarEl.value = processed;
		const percent = Math.floor((processed / total) * 100);
		this.progressLabelEl.setText(`Progress: ${processed}/${total} files (${percent}%)`);
	}

	private resetProgress(): void {
		if (this.progressBarEl) {
			this.progressBarEl.max = 1;
			this.progressBarEl.value = 0;
		}
		if (this.progressLabelEl) {
			this.progressLabelEl.setText("Progress: idle");
		}
	}

	/** Shown after connect/indexing, before the first file progress report. */
	private setProgressPreparing(): void {
		if (!this.progressBarEl || !this.progressLabelEl) return;
		this.progressBarEl.max = 1;
		this.progressBarEl.value = 0;
		this.progressLabelEl.setText("Progress: preparing…");
	}

	async onRunSync(): Promise<void> {
		if (this.plugin.settings.deleteRemovedNotes) {
			const confirmed = await new Promise<boolean>((resolve) => {
				const confirmModal = new (class extends Modal {
					constructor(app: App) {
						super(app);
					}
					onOpen(): void {
						const { contentEl } = this;
						contentEl.empty();
						contentEl.createEl("h2", { text: "Confirm sync" });
						contentEl.createEl("p", {
							text: "This sync will remove notes from Anki that no longer have a matching note in your vault. Continue?",
						});
						const buttons = contentEl.createDiv({ cls: "anki-note-sync-confirm-buttons" });
						new ButtonComponent(buttons)
							.setButtonText("Cancel")
							.onClick(() => {
								this.close();
								resolve(false);
							});
						new ButtonComponent(buttons)
							.setButtonText("Continue")
							.setCta()
							.onClick(() => {
								this.close();
								resolve(true);
							});
					}
				})(this.app);
				confirmModal.open();
			});
			if (!confirmed) return;
		}

		this.setRunning(true);
		this.setProgressPreparing();
		this.clearLog();
		this.appendLog("info", "Starting sync…");
		try {
			await this.plugin.runFullSync(
				(level, message) => this.appendLog(level, message),
				(progress) => this.setProgress(progress)
			);
			this.appendLog("info", "Sync finished.");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.appendLog("error", `Sync failed: ${msg}`);
		} finally {
			this.setRunning(false);
		}
	}
}
