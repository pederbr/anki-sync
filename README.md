# Anki Sync

Sync your Obsidian vault to Anki via [AnkiConnect](https://github.com/FooSoft/anki-connect). Creates Basic (and optionally Cloze) cards from your markdown notes with full control over heading levels, update behavior, and deletion.

## Requirements

- **Obsidian** (desktop)
- **Anki** with the [AnkiConnect](https://github.com/FooSoft/anki-connect) add-on installed and running

## Setup

1. Install AnkiConnect in Anki (Anki → Tools → Add-ons → Get Add-ons, then use the AnkiConnect code).
2. Open Anki so it is running (AnkiConnect listens on `http://localhost:8765` by default).
3. In Obsidian, install this plugin (copy the plugin folder into your vault’s `.obsidian/plugins/` and enable it in Settings → Community plugins).
4. Open **Settings → Anki Sync** and configure:
   - **AnkiConnect URL** (default: `http://localhost:8765`)
   - **Sync behavior**: Replace (upsert) vs Append only; whether to remove notes in Anki that no longer exist in the vault
   - **Card extraction**: Section heading level (H1–H6), intro card toggle
   - **Paths & tags**: Excluded folders, global tags, vault root subpath

## Usage

- Use the **sync icon** in the left ribbon, or run the command **Sync to Anki** / **Open Anki Sync**.
- In the sync window, click **Run sync** to scan your vault and create/update/delete notes in Anki.
- If “Remove notes no longer in vault” is on, you will be asked to confirm before notes are deleted.

## Behavior

- **Decks**: One deck per note file; deck name is `{prefix}::{path}::{filename}` (e.g. `Obsidian::Folder::MyNote`).
- **Cards**: Each note is split by the chosen section heading level (default H2). Each such heading becomes one Basic card (front = heading, back = content until the next same-level heading). Optionally, content before the first section becomes an “intro” card.
- **Tags**: All synced notes get the global tags you set, plus a tag derived from the file name.
- **Images**: Obsidian image syntax (`![[image.png]]`, `![alt](url)`) is resolved; images are uploaded to Anki and inlined.
- **LaTeX**: Inline and display math are preserved and normalized for Anki/MathJax.

## Safety

- **Deletion**: Only notes that have the plugin’s **global tag** and belong to the configured deck prefix are considered “managed.” Only those are ever deleted when “Remove notes no longer in vault” is enabled. Use a dedicated tag (e.g. `obsidian`) so other Anki notes are never touched.
- **Append-only mode**: If you want to never change or delete existing Anki notes, set **Card update mode** to “Append only” and turn off “Remove notes no longer in vault.”

## Building

```bash
npm install
npm run build
```

Output is `main.js` in the plugin folder. Use `npm run dev` for watch mode.

## License

Use and modify as you like.
