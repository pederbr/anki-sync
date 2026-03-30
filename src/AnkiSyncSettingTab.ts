import { App, PluginSettingTab, Setting } from "obsidian";
import type AnkiSyncPlugin from "./main";
import type { CardUpdateMode } from "./settings";

export class AnkiSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: AnkiSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Preset")
			.setDesc("Apply a preset for sync behavior and deletion.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("", "—")
					.addOption("full", "Full replace (upsert + delete removed)")
					.addOption("safe", "Safe append-only (no updates, no deletion)")
					.setValue("")
					.onChange(async (value) => {
						if (value === "full") {
							this.plugin.settings.cardUpdateMode = "replace";
							this.plugin.settings.deleteRemovedNotes = true;
						} else if (value === "safe") {
							this.plugin.settings.cardUpdateMode = "append";
							this.plugin.settings.deleteRemovedNotes = false;
						}
						if (value) {
							await this.plugin.saveSettings();
							this.display();
						}
					})
			);

		new Setting(containerEl).setName("Anki").setHeading();
		new Setting(containerEl)
			.setName("Anki connect address")
			.setDesc(
				"POST URL for AnkiConnect (default: http://127.0.0.1:8765). Must match webBindAddress in Anki."
			)
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:8765")
					.setValue(this.plugin.settings.ankiConnectUrl)
					.onChange(async (value) => {
						this.plugin.settings.ankiConnectUrl = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("AnkiConnect API key.")
			.setDesc(
				"Optional. If you set apiKey in Anki (tools → add-ons → AnkiConnect → config), paste the same value here."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("Leave empty if AnkiConnect apiKey is not set.")
					.setValue(this.plugin.settings.ankiConnectApiKey)
					.onChange(async (value) => {
						this.plugin.settings.ankiConnectApiKey = value;
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName("Basic model name")
			.setDesc("Anki note type for basic cards")
			.addText((text) =>
				text.setPlaceholder("Basic").setValue(this.plugin.settings.basicModel).onChange(async (value) => {
					this.plugin.settings.basicModel = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Top-level deck name")
			.setDesc(
				"First segment of each Anki deck path. Leave empty to use your vault folder name. " +
					"Subdecks follow your folders and note title, e.g. Top::Toksikologi::Toksiske stoffer."
			)
			.addText((text) =>
				text
					.setPlaceholder("Vault name if empty")
					.setValue(this.plugin.settings.defaultBasicDeckPrefix)
					.onChange(async (value) => {
						this.plugin.settings.defaultBasicDeckPrefix = value;
						await this.plugin.saveSettings();
					})
			);

		const syncBehaviorSection = new Setting(containerEl).setName("Sync behavior").setHeading();
		syncBehaviorSection.settingEl.addClass("anki-note-sync-settings-section");
		new Setting(containerEl)
			.setName("Card update mode")
			.setDesc("Replace: update existing notes by front text. Append: only create new notes, never update.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("replace", "Replace (upsert)")
					.addOption("append", "Append only")
					.setValue(this.plugin.settings.cardUpdateMode)
					.onChange(async (value) => {
						this.plugin.settings.cardUpdateMode = value as CardUpdateMode;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Background sync on note changes")
			.setDesc(
				"When on, changes to a markdown note queue an incremental sync for that file only (after a short delay). " +
					"Renames and deletes update Anki for the affected paths. " +
					"Use a manual sync for a full vault pass (including vault-wide removal of orphaned notes, if enabled). " +
					"When off, only manual sync runs."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableBackgroundSync)
					.onChange(async (value) => {
						this.plugin.settings.enableBackgroundSync = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Remove notes no longer in vault")
			.setDesc("Delete Anki notes that were synced from the vault but no longer have a matching source.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.deleteRemovedNotes)
					.onChange(async (value) => {
						this.plugin.settings.deleteRemovedNotes = value;
						await this.plugin.saveSettings();
					})
			);

		const cardExtractionSection = new Setting(containerEl)
			.setName("Card extraction")
			.setHeading();
		cardExtractionSection.settingEl.addClass("anki-note-sync-settings-section");
		new Setting(containerEl)
			.setName("Section heading level")
			.setDesc("Heading level that defines card boundaries; each such heading becomes one card (h1–h6).")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("1", "H1")
					.addOption("2", "H2")
					.addOption("3", "H3")
					.addOption("4", "H4")
					.addOption("5", "H5")
					.addOption("6", "H6")
					.setValue(String(this.plugin.settings.sectionHeadingLevel))
					.onChange(async (value) => {
						this.plugin.settings.sectionHeadingLevel = parseInt(value, 10) as 1 | 2 | 3 | 4 | 5 | 6;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Create intro card")
			.setDesc("Create a card for content before the first section heading (front uses h1 or filename).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.createIntroCard)
					.onChange(async (value) => {
						this.plugin.settings.createIntroCard = value;
						await this.plugin.saveSettings();
					})
			);

		const pathsTagsSection = new Setting(containerEl).setName("Paths & tags").setHeading();
		pathsTagsSection.settingEl.addClass("anki-note-sync-settings-section");
		new Setting(containerEl)
			.setName("Vault root subpath")
			.setDesc("Only sync notes under this path (relative to vault root). Leave empty for entire vault.")
			.addText((text) =>
				text
					.setPlaceholder("")
					.setValue(this.plugin.settings.vaultRootSubpath)
					.onChange(async (value) => {
						this.plugin.settings.vaultRootSubpath = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Attachments folder name")
			.setDesc(
				"Folder under the vault root where images are stored (e.g. Attachments, assets). Used when resolving bare filenames like ![[photo.png]]. Leave empty to rely on full paths and Obsidian link resolution only."
			)
			.addText((text) =>
				text
					.setPlaceholder("Attachments")
					.setValue(this.plugin.settings.attachmentsFolderName)
					.onChange(async (value) => {
						this.plugin.settings.attachmentsFolderName = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Excluded folder names")
			.setDesc("Comma-separated folder names to skip (for example lub, templates).")
			.addText((text) =>
				text
					.setPlaceholder("LUB")
					.setValue(this.plugin.settings.excludedFolderNames)
					.onChange(async (value) => {
						this.plugin.settings.excludedFolderNames = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Global tags")
			.setDesc("Space-separated tags added to all synced notes (used to identify managed notes for deletion).")
			.addText((text) =>
				text
					.setPlaceholder("Enter global tags")
					.setValue(this.plugin.settings.globalTags)
					.onChange(async (value) => {
						this.plugin.settings.globalTags = value;
						await this.plugin.saveSettings();
					})
			);

		const debugSection = new Setting(containerEl).setName("Debugging").setHeading();
		debugSection.settingEl.addClass("anki-note-sync-settings-section");
		new Setting(containerEl)
			.setName("Write sync debug log")
			.setDesc(
				`Append a trace to a file under your vault root (not under ${this.app.vault.configDir}/plugins). Turn this on, run a sync, then open the file from the path below in the file explorer.`
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugSyncLogEnabled)
					.onChange(async (value) => {
						this.plugin.settings.debugSyncLogEnabled = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Debug log file path")
			.setDesc(
				"Relative to vault root only. Default creates e.g. MyVault/anki-note-sync-debug.log next to your notes. Folders are created if needed."
			)
			.addText((text) =>
				text
					.setPlaceholder("Anki-note-sync-debug.log")
					.setValue(this.plugin.settings.debugSyncLogPath)
					.onChange(async (value) => {
						this.plugin.settings.debugSyncLogPath = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
