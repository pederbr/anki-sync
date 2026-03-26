import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
	{
		files: ["**/*.ts", "**/*.tsx"],
		rules: {
			"obsidianmd/ui/sentence-case": [
				"error",
				{
					enforceCamelCaseLower: true,
					brands: ["AnkiConnect", "Anki", "Obsidian", "JSON"],
					ignoreWords: ["apiKey", "requestPermission"],
					ignoreRegex: ["anki-note-sync-debug\\.log"],
				},
			],
		},
	},
);
