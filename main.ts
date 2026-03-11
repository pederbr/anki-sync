import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type PluginSettings } from "./settings";
import { AnkiSyncSettingTab } from "./AnkiSyncSettingTab";
import { SyncModal } from "./SyncModal";
import { runFullSync } from "./syncEngine";

export type LogLevel = "info" | "warn" | "error";

export default class AnkiSyncPlugin extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("sync", "Sync to Anki", () => this.openSyncModal());
		this.addCommand({
			id: "sync-to-anki",
			name: "Sync to Anki",
			callback: () => this.openSyncModal(),
		});
		this.addCommand({
			id: "open-sync-view",
			name: "Open Anki Sync",
			callback: () => this.openSyncModal(),
		});
		this.addSettingTab(new AnkiSyncSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	openSyncModal() {
		new SyncModal(this.app, this).open();
	}

	async runFullSync(onLog: (level: LogLevel, message: string) => void): Promise<void> {
		await runFullSync(this.settings, this.app.vault, (ev) => onLog(ev.level, ev.message));
	}
}
