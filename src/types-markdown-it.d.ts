declare module "markdown-it" {
	interface MarkdownItOptions {
		html?: boolean;
		[x: string]: unknown;
	}

	class MarkdownIt {
		constructor(preset?: string, options?: MarkdownItOptions);
		render(src: string): string;
	}

	export default MarkdownIt;
}

