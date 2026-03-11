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

		containerEl.createEl("h3", { text: "Anki" });
		new Setting(containerEl)
			.setName("AnkiConnect URL")
			.setDesc("URL where AnkiConnect is listening (default: http://localhost:8765)")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:8765")
					.setValue(this.plugin.settings.ankiConnectUrl)
					.onChange(async (value) => {
						this.plugin.settings.ankiConnectUrl = value;
						await this.plugin.saveSettings();
					})
			);
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
			.setName("Cloze model name")
			.setDesc("Anki note type for cloze cards")
			.addText((text) =>
				text.setPlaceholder("Cloze").setValue(this.plugin.settings.clozeModel).onChange(async (value) => {
					this.plugin.settings.clozeModel = value;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Default deck prefix")
			.setDesc("Prefix for generated deck names (e.g. Obsidian)")
			.addText((text) =>
				text
					.setPlaceholder("Obsidian")
					.setValue(this.plugin.settings.defaultBasicDeckPrefix)
					.onChange(async (value) => {
						this.plugin.settings.defaultBasicDeckPrefix = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Sync behavior" }).addClass("anki-sync-settings-section");
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

		containerEl.createEl("h3", { text: "Card extraction" }).addClass("anki-sync-settings-section");
		new Setting(containerEl)
			.setName("Section heading level")
			.setDesc("Heading level that defines card boundaries (H1–H6). Each such heading becomes one card.")
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
			.setDesc("Create a card for content before the first section heading (front = H1 or filename).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.createIntroCard)
					.onChange(async (value) => {
						this.plugin.settings.createIntroCard = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Paths & tags" }).addClass("anki-sync-settings-section");
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
			.setName("Excluded folder names")
			.setDesc("Comma-separated folder names to skip (e.g. LUB, templates)")
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
					.setPlaceholder("obsidian")
					.setValue(this.plugin.settings.globalTags)
					.onChange(async (value) => {
						this.plugin.settings.globalTags = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
