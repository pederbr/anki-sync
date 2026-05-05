/**
 * Interactive image occlusion editor modal.
 *
 * Opens a canvas-based editor where the user can draw, move, resize, and
 * label rectangular masks on top of an image.  On save the updated masks
 * and header are returned via an `onSave` callback so the caller can write
 * them back to the markdown code block.
 *
 * Interaction summary
 * ───────────────────
 * • Click + drag on blank area  → draw a new mask
 * • Click an existing mask      → select it (shows orange highlight + handles)
 * • Drag selected mask          → move
 * • Drag a corner handle        → resize
 * • Delete-key / Delete button  → remove selected mask
 * • Label input below canvas    → edit the selected mask's label
 */

import { App, Modal, Notice } from "obsidian";
import type { OcclusionMask } from "./imageOcclusionParser";

const NORMAL_FILL       = "rgba(90, 90, 90, 0.72)";
const NORMAL_STROKE     = "rgba(60, 60, 60, 0.9)";
const SELECTED_FILL     = "rgba(255, 180, 0, 0.45)";
const SELECTED_STROKE   = "#ff8c00";
const HANDLE_HALF       = 5;          // half-size of corner resize handles in CSS px
const MIN_MASK_FRACTION = 0.015;      // minimum mask dimension as fraction of image

type HandleId = "nw" | "ne" | "sw" | "se";

const CORNER_HANDLES: [HandleId, (x: number, y: number, w: number, h: number) => [number, number]][] = [
	["nw", (x, y)       => [x,     y    ]],
	["ne", (x, y, w)    => [x + w, y    ]],
	["sw", (x, y, w, h) => [x,     y + h]],
	["se", (x, y, w, h) => [x + w, y + h]],
];

// ── modal class ───────────────────────────────────────────────────────────────

export class ImageOcclusionModal extends Modal {
	private masks:    OcclusionMask[];
	private header:   string;

	// canvas / rendering
	private canvas!:  HTMLCanvasElement;
	private ctx!:     CanvasRenderingContext2D;
	private img!:     HTMLImageElement;
	private displayW = 0;
	private displayH = 0;

	// interaction state
	private selectedIdx: number | null                                                    = null;
	private drawing:     { startX: number; startY: number; curX: number; curY: number } | null = null;
	private dragging:    { startMx: number; startMy: number; origX: number; origY: number } | null = null;
	private resizing:    { handle: HandleId; orig: OcclusionMask; startMx: number; startMy: number } | null = null;

	// DOM refs updated after mounting
	private labelInput!:  HTMLInputElement;
	private headerInput!: HTMLInputElement;
	private deleteBtn!:   HTMLButtonElement;

	constructor(
		app: App,
		private readonly imageData: ArrayBuffer,
		private readonly imageName: string,
		initialMasks:  OcclusionMask[],
		initialHeader: string,
		private readonly onSave: (header: string, masks: OcclusionMask[]) => void
	) {
		super(app);
		this.masks  = initialMasks.map((m) => ({ ...m }));
		this.header = initialHeader;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("anki-occlusion-modal");

		contentEl.createEl("h2", { text: `Edit occlusions — ${this.imageName}` });

		// ── header row ────────────────────────────────────────────────────────
		const headerRow = contentEl.createDiv({ cls: "anki-occlusion-row" });
		headerRow.createEl("label", { text: "Question header:" });
		this.headerInput = headerRow.createEl("input", { type: "text", cls: "anki-occlusion-header-input" });
		this.headerInput.value = this.header;
		this.headerInput.addEventListener("input", () => { this.header = this.headerInput.value; });

		// ── canvas ────────────────────────────────────────────────────────────
		const canvasWrap = contentEl.createDiv({ cls: "anki-occlusion-canvas-wrap" });
		this.canvas = canvasWrap.createEl("canvas", { cls: "anki-occlusion-canvas" });

		// ── mask controls ─────────────────────────────────────────────────────
		const maskRow = contentEl.createDiv({ cls: "anki-occlusion-row anki-occlusion-mask-row" });
		maskRow.createEl("label", { text: "Label:" });
		this.labelInput = maskRow.createEl("input", {
			type: "text",
			cls: "anki-occlusion-label-input",
		});
		this.labelInput.placeholder = "Select a mask then type its label";
		this.labelInput.disabled    = true;
		this.labelInput.addEventListener("input", () => {
			if (this.selectedIdx !== null) {
				this.masks[this.selectedIdx]!.label = this.labelInput.value;
				this.render();
			}
		});

		this.deleteBtn = maskRow.createEl("button", { text: "Delete", cls: "anki-occlusion-delete-btn" });
		this.deleteBtn.disabled = true;
		this.deleteBtn.addEventListener("click", () => this.deleteSelected());

		// ── tip ───────────────────────────────────────────────────────────────
		contentEl.createEl("p", {
			text: "Drag to draw · click to select · drag to move · drag corner to resize · del key removes selected",
			cls: "anki-occlusion-tip",
		});

		// ── footer ────────────────────────────────────────────────────────────
		const footer  = contentEl.createDiv({ cls: "anki-occlusion-footer" });
		const saveBtn = footer.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.addEventListener("click", () => { this.onSave(this.header, this.masks); this.close(); });
		footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

		// keyboard shortcuts
		this.scope.register([], "Delete",    () => { this.deleteSelected(); return false; });
		this.scope.register([], "Backspace", () => { this.deleteSelected(); return false; });

		this.loadImageAndInit().catch((e: unknown) => {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Occlusion editor: ${msg}`);
		});
	}

	// ── image loading ─────────────────────────────────────────────────────────

	private async loadImageAndInit(): Promise<void> {
		const blob = new Blob([this.imageData]);
		const url  = URL.createObjectURL(blob);
		await new Promise<void>((resolve, reject) => {
			this.img          = new Image();
			this.img.onload  = () => { URL.revokeObjectURL(url); resolve(); };
			this.img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Cannot load image")); };
			this.img.src = url;
		});

		const maxW   = Math.min(680, Math.max(300, this.contentEl.clientWidth - 40));
		const scale  = maxW / this.img.naturalWidth;
		this.displayW = Math.round(this.img.naturalWidth  * scale);
		this.displayH = Math.round(this.img.naturalHeight * scale);

		const dpr         = window.devicePixelRatio || 1;
		this.canvas.width  = this.displayW * dpr;
		this.canvas.height = this.displayH * dpr;
		this.canvas.style.width  = `${this.displayW}px`;
		this.canvas.style.height = `${this.displayH}px`;

		this.ctx = this.canvas.getContext("2d")!;
		this.ctx.scale(dpr, dpr);

		this.attachEvents();
		this.render();
	}

	// ── event wiring ─────────────────────────────────────────────────────────

	private attachEvents(): void {
		const rel = (e: MouseEvent): { x: number; y: number } => {
			const r = this.canvas.getBoundingClientRect();
			return { x: (e.clientX - r.left) / this.displayW, y: (e.clientY - r.top) / this.displayH };
		};

		this.canvas.addEventListener("mousedown", (e) => {
			const { x, y } = rel(e);
			e.preventDefault();

			// Check resize handle first
			if (this.selectedIdx !== null) {
				const h = this.hitHandle(x, y, this.selectedIdx);
				if (h !== null) {
					this.resizing = { handle: h, orig: { ...this.masks[this.selectedIdx]! }, startMx: x, startMy: y };
					return;
				}
			}

			// Check mask hit
			const hit = this.hitMask(x, y);
			if (hit !== null) {
				this.select(hit);
				const m = this.masks[hit]!;
				this.dragging = { startMx: x, startMy: y, origX: m.x, origY: m.y };
				return;
			}

			// Start drawing
			this.deselect();
			this.drawing = { startX: x, startY: y, curX: x, curY: y };
		});

		this.canvas.addEventListener("mousemove", (e) => {
			const { x, y } = rel(e);

			if (this.drawing) {
				this.drawing.curX = x;
				this.drawing.curY = y;
				this.render();
				return;
			}
			if (this.dragging !== null && this.selectedIdx !== null) {
				const dx = x - this.dragging.startMx;
				const dy = y - this.dragging.startMy;
				const m  = this.masks[this.selectedIdx]!;
				m.x = clamp(this.dragging.origX + dx, 0, 1 - m.width);
				m.y = clamp(this.dragging.origY + dy, 0, 1 - m.height);
				this.render();
				return;
			}
			if (this.resizing !== null && this.selectedIdx !== null) {
				this.applyResize(x, y);
				this.render();
				return;
			}

			// Cursor feedback
			if (this.selectedIdx !== null && this.hitHandle(x, y, this.selectedIdx) !== null) {
				this.canvas.setCssProps({ cursor: "nwse-resize" });
			} else if (this.hitMask(x, y) !== null) {
				this.canvas.setCssProps({ cursor: "move" });
			} else {
				this.canvas.setCssProps({ cursor: "crosshair" });
			}
		});

		const finish = (e: MouseEvent) => {
			const { x, y } = rel(e);

			if (this.drawing) {
				const d  = this.drawing;
				this.drawing = null;
				const rx = Math.min(d.startX, x);
				const ry = Math.min(d.startY, y);
				const rw = Math.abs(x - d.startX);
				const rh = Math.abs(y - d.startY);
				if (rw >= MIN_MASK_FRACTION && rh >= MIN_MASK_FRACTION) {
					const nextId = (this.masks.reduce((max, m) => Math.max(max, m.id), 0)) + 1;
					this.masks.push({
						id:     nextId,
						x:      clamp(rx, 0, 1 - rw),
						y:      clamp(ry, 0, 1 - rh),
						width:  Math.min(rw, 1),
						height: Math.min(rh, 1),
						label:  "",
					});
					this.select(this.masks.length - 1);
					this.labelInput.focus();
				}
				this.render();
				return;
			}
			this.dragging = null;
			this.resizing = null;
		};

		this.canvas.addEventListener("mouseup",    finish);
		this.canvas.addEventListener("mouseleave", finish);
	}

	// ── interaction helpers ───────────────────────────────────────────────────

	private hitMask(rx: number, ry: number): number | null {
		for (let i = this.masks.length - 1; i >= 0; i--) {
			const m = this.masks[i]!;
			if (rx >= m.x && rx <= m.x + m.width && ry >= m.y && ry <= m.y + m.height) return i;
		}
		return null;
	}

	private hitHandle(rx: number, ry: number, idx: number): HandleId | null {
		const m  = this.masks[idx]!;
		const hw = HANDLE_HALF / this.displayW;
		const hh = HANDLE_HALF / this.displayH;
		for (const [id, pos] of CORNER_HANDLES) {
			const [cx, cy] = pos(m.x, m.y, m.width, m.height);
			if (Math.abs(rx - cx) <= hw && Math.abs(ry - cy) <= hh) return id;
		}
		return null;
	}

	private applyResize(rx: number, ry: number): void {
		if (!this.resizing || this.selectedIdx === null) return;
		const { handle, orig, startMx, startMy } = this.resizing;
		const dx = rx - startMx;
		const dy = ry - startMy;
		const m  = this.masks[this.selectedIdx]!;
		switch (handle) {
			case "nw":
				m.x      = clamp(orig.x + dx, 0, orig.x + orig.width  - MIN_MASK_FRACTION);
				m.y      = clamp(orig.y + dy, 0, orig.y + orig.height - MIN_MASK_FRACTION);
				m.width  = Math.max(MIN_MASK_FRACTION, orig.width  - dx);
				m.height = Math.max(MIN_MASK_FRACTION, orig.height - dy);
				break;
			case "ne":
				m.y      = clamp(orig.y + dy, 0, orig.y + orig.height - MIN_MASK_FRACTION);
				m.width  = Math.max(MIN_MASK_FRACTION, orig.width  + dx);
				m.height = Math.max(MIN_MASK_FRACTION, orig.height - dy);
				break;
			case "sw":
				m.x      = clamp(orig.x + dx, 0, orig.x + orig.width  - MIN_MASK_FRACTION);
				m.width  = Math.max(MIN_MASK_FRACTION, orig.width  - dx);
				m.height = Math.max(MIN_MASK_FRACTION, orig.height + dy);
				break;
			case "se":
				m.width  = Math.max(MIN_MASK_FRACTION, orig.width  + dx);
				m.height = Math.max(MIN_MASK_FRACTION, orig.height + dy);
				break;
		}
	}

	private select(idx: number): void {
		this.selectedIdx        = idx;
		this.labelInput.value   = this.masks[idx]!.label;
		this.labelInput.disabled = false;
		this.deleteBtn.disabled  = false;
		this.render();
	}

	private deselect(): void {
		this.selectedIdx         = null;
		this.labelInput.value    = "";
		this.labelInput.disabled = true;
		this.deleteBtn.disabled  = true;
	}

	private deleteSelected(): void {
		if (this.selectedIdx === null) return;
		this.masks.splice(this.selectedIdx, 1);
		this.deselect();
		this.render();
	}

	// ── rendering ─────────────────────────────────────────────────────────────

	private render(): void {
		if (!this.ctx || !this.img) return;
		const c  = this.ctx;
		const dw = this.displayW;
		const dh = this.displayH;

		c.clearRect(0, 0, dw, dh);
		c.drawImage(this.img, 0, 0, dw, dh);

		for (let i = 0; i < this.masks.length; i++) {
			const m   = this.masks[i]!;
			const px  = m.x      * dw;
			const py  = m.y      * dh;
			const pw  = m.width  * dw;
			const ph  = m.height * dh;
			const sel = i === this.selectedIdx;

			c.fillStyle   = sel ? SELECTED_FILL   : NORMAL_FILL;
			c.strokeStyle = sel ? SELECTED_STROKE : NORMAL_STROKE;
			c.lineWidth   = sel ? 2 : 1;
			c.fillRect  (px, py, pw, ph);
			c.strokeRect(px, py, pw, ph);

			// Label
			if (m.label) {
				c.save();
				c.font         = `bold ${clamp(Math.round(ph * 0.35), 10, 16)}px sans-serif`;
				c.fillStyle    = "white";
				c.textBaseline = "middle";
				c.shadowColor  = "rgba(0,0,0,0.8)";
				c.shadowBlur   = 3;
				c.fillText(m.label, px + 5, py + ph / 2, pw - 10);
				c.restore();
			}

			// Corner handles when selected
			if (sel) {
				for (const [, pos] of CORNER_HANDLES) {
					const [hx, hy] = pos(px, py, pw, ph);
					c.fillStyle   = "white";
					c.strokeStyle = SELECTED_STROKE;
					c.lineWidth   = 1.5;
					c.fillRect  (hx - HANDLE_HALF, hy - HANDLE_HALF, HANDLE_HALF * 2, HANDLE_HALF * 2);
					c.strokeRect(hx - HANDLE_HALF, hy - HANDLE_HALF, HANDLE_HALF * 2, HANDLE_HALF * 2);
				}
			}
		}

		// Preview rect while drawing
		if (this.drawing) {
			const d  = this.drawing;
			const rx = Math.min(d.startX, d.curX) * dw;
			const ry = Math.min(d.startY, d.curY) * dh;
			const rw = Math.abs(d.curX - d.startX) * dw;
			const rh = Math.abs(d.curY - d.startY) * dh;
			c.setLineDash([5, 4]);
			c.strokeStyle = SELECTED_STROKE;
			c.lineWidth   = 2;
			c.strokeRect(rx, ry, rw, rh);
			c.setLineDash([]);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ── utility ───────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}
