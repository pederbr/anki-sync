import os
import re
import base64
import json
import requests
import markdown
import unicodedata
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple, Optional, Set



# ------------- CONFIG -------------

ANKI_CONNECT_URL = "http://localhost:8765"

OBSIDIAN_ROOT = Path("/Users/pederbr/Documents/notater/1AB")   

# Decks / models
DEFAULT_BASIC_DECK = "Obsidian::Basic"
DEFAULT_CLOZE_DECK = "Obsidian::Cloze"
BASIC_MODEL = "Basic"
CLOZE_MODEL = "Cloze"

# Tags added to all notes
GLOBAL_TAGS = ["obsidian"]

# Enable / disable different card types
ENABLE_H3_SECTION_CARDS = True
ENABLE_LINE_BASIC_CARDS = False     # lines like "Question::Answer"
ENABLE_LINE_CLOZE_CARDS = False     # lines containing "{{c1:: ... }}"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}

# ----------------------------------


# ------------- ANKICONNECT HELPERS -------------
def clean_text(t: str) -> str:
    # remove weird control characters
    return "".join(c for c in t if unicodedata.category(c)[0] != "C")

def anki_invoke(action: str, **params):
    payload = {
        "action": action,
        "version": 6,
        "params": params or {}
    }
    res = requests.post(ANKI_CONNECT_URL, json=payload, timeout=10).json()
    if res.get("error") is not None:
        raise RuntimeError(f"AnkiConnect error in {action}: {res['error']}")
    return res["result"]


# Helper to check if AnkiConnect is running
def check_anki_running() -> bool:
    """Quick check if AnkiConnect is reachable before doing any work."""
    try:
        res = requests.post(
            ANKI_CONNECT_URL,
            json={"action": "version", "version": 6},
            timeout=1,
        )
        data = res.json()
    except Exception as e:
        print(f"AnkiConnect not reachable at {ANKI_CONNECT_URL}: {e}")
        return False

    if data.get("error"):
        print(f"AnkiConnect returned error on version check: {data['error']}")
        return False

    return True


def ensure_deck(deck_name: str) -> None:
    anki_invoke("createDeck", deck=deck_name)


def find_existing_note(deck: str, front: str) -> Optional[int]:
    front = clean_text(front)

    # Escape backslashes and quotes for Anki search
    safe_front = front.replace("\\", "\\\\")
    safe_front = safe_front.replace('"', '\\"')

    query = f'deck:"{deck}" front:"{safe_front}"'

    try:
        note_ids = anki_invoke("findNotes", query=query)
    except Exception:
        print(f"  ! Warning: search failed for front={front!r}, trying fuzzy match…")
        fuzzy = front[:30].replace("\\", "\\\\").replace('"', '\\"')
        note_ids = anki_invoke("findNotes", query=f'"{fuzzy}"')

    if not note_ids:
        return None
    return note_ids[0]

def upsert_basic(front: str, back: str, deck: str, tags: Sequence[str]) -> int:
    """Create or update a Basic note."""
    ensure_deck(deck)

    note_id = find_existing_note(deck, front)

    if note_id is None:
        # Try to create
        note = {
            "deckName": deck,
            "modelName": BASIC_MODEL,
            "fields": {
                "Front": front,
                "Back": back,
            },
            "tags": list(tags),
        }
        try:
            result = anki_invoke("addNote", note=note)
            print(f"  + Created Basic note {result} in deck '{deck}'")
            return result
        except RuntimeError as e:
            # If Anki says it's a duplicate, fall back to "find & update"
            if "duplicate" in str(e).lower():
                existing_id = find_existing_note(deck, front)
                if existing_id is not None:
                    anki_invoke(
                        "updateNoteFields",
                        note={
                            "id": existing_id,
                            "fields": {
                                "Front": front,
                                "Back": back,
                            },
                        },
                    )
                    if tags:
                        anki_invoke("addTags", notes=[existing_id], tags=" ".join(tags))
                    print(f"  ~ Updated existing Basic note {existing_id} after duplicate warning")
                    return existing_id

                # If we *still* can't find it, just log and skip
                print("  ! Duplicate reported by Anki, but could not find existing note. Skipping.")
                return -1
            else:
                # Some other AnkiConnect error
                raise
    else:
        # Update existing
        anki_invoke(
            "updateNoteFields",
            note={
                "id": note_id,
                "fields": {
                    "Front": front,
                    "Back": back,
                },
            },
        )
        if tags:
            anki_invoke("addTags", notes=[note_id], tags=" ".join(tags))
        print(f"  ~ Updated Basic note {note_id} in deck '{deck}'")
        return note_id
    

def upsert_cloze(text: str, deck: str, tags: Sequence[str]) -> int:
    ensure_deck(deck)
    text_snippet = text.replace('"', '\\"')
    query = f'deck:"{deck}" " {text_snippet} "'
    note_ids = anki_invoke("findNotes", query=query)

    if not note_ids:
        note = {
            "deckName": deck,
            "modelName": CLOZE_MODEL,
            "fields": {"Text": text, "Extra": ""},
            "tags": list(tags),
        }
        result = anki_invoke("addNote", note=note)
        print(f"  + Created Cloze note {result}")
        return result
    else:
        note_id = note_ids[0]
        anki_invoke(
            "updateNoteFields",
            note={"id": note_id, "fields": {"Text": text}},
        )
        if tags:
            anki_invoke("addTags", notes=[note_id], tags=" ".join(tags))
        print(f"  ~ Updated Cloze note {note_id}")
        return note_id



# ------------- MEDIA HANDLING -------------

uploaded_media: Set[str] = set()


def store_media_file(path: Path) -> str:
    """
    Upload an image into Anki's media collection via AnkiConnect.
    Returns the filename used in <img src="...">.
    """
    filename = path.name
    if filename in uploaded_media:
        return filename

    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    anki_invoke("storeMediaFile", filename=filename, data=b64)
    uploaded_media.add(filename)
    return filename


# ------------- OBSIDIAN PARSING -------------

def find_markdown_files(root: Path) -> Iterable[Path]:
    for path, dirs, files in os.walk(root):
        # Skip any folder named "LUB"
        dirs[:] = [d for d in dirs if d != "LUB"]
        for name in files:
            if name.lower().endswith(".md"):
                yield Path(path) / name


def index_image_files(root: Path) -> Dict[str, Path]:
    index: Dict[str, Path] = {}
    for path, _, files in os.walk(root):
        for name in files:
            ext = Path(name).suffix.lower()
            if ext in IMAGE_EXTS:
                full = Path(path) / name
                index.setdefault(name, full)
    return index


def resolve_image_path(ref: str, root: Path, image_index: Dict[str, Path]) -> Optional[Path]:
    """
    Try to resolve an image reference to an actual file path.
    Handles:
      - Exact relative/absolute paths
      - Direct basename matches
      - Missing extensions (try common IMAGE_EXTS)
      - Fuzzy matches where the ref/stem is contained in the filename
        (e.g. ref='20251031113455.png' vs 'Pasted image 20251031113455.png')
    """
    ref = ref.strip()
    if not ref:
        return None

    ref_path = Path(ref)

    # 1) Try direct relative path under root
    if not ref_path.is_absolute():
        candidate = (root / ref_path).resolve()
        if candidate.exists():
            return candidate

    # 2) Direct basename match
    basename = ref_path.name
    if basename in image_index:
        return image_index[basename]

    stem = ref_path.stem
    ext = ref_path.suffix.lower()

    # 3) If no extension given, try appending known extensions
    if not ext:
        for e in IMAGE_EXTS:
            candidate_name = stem + e
            if candidate_name in image_index:
                return image_index[candidate_name]

    # 4) Fuzzy match: look for filenames that contain the stem or basename
    #    e.g. stem='20251031113455' matches 'Pasted image 20251031113455.png'
    if stem:
        for name, path in image_index.items():
            if stem in name:
                return path

    # 5) As a last resort, try substring of the full ref
    for name, path in image_index.items():
        if basename and basename in name:
            return path

    return None


def replace_wikilinks(text: str) -> str:
    """
    Convert [[Link]] or [[Link|Alias]] to plain text ('Link' or 'Alias').
    """

    def repl(match: re.Match) -> str:
        target = match.group(1)
        alias = match.group(2)
        return alias if alias else target

    pattern = re.compile(r"\[\[([^|\]]+)(?:\|([^]]+))?\]\]")
    return pattern.sub(repl, text)


def replace_image_syntax(
    text: str,
    root: Path,
    image_index: Dict[str, Path],
) -> str:
    """
    Replace Obsidian / Markdown image syntax with <img src="filename">,
    and upload the referenced image to Anki via storeMediaFile().
    """

    def img_tag_for(ref: str) -> str:
        img_path = resolve_image_path(ref, root, image_index)
        if not img_path:
            return f"[missing image: {ref}]"
        filename = store_media_file(img_path)
        return f'<img src="{filename}">'

    # Obsidian: ![[path/to/image.png|optional alt]]
    obsidian_pattern = re.compile(r"!\[\[([^|\]]+)(?:\|[^]]*)?]]")

    def obsidian_sub(match: re.Match) -> str:
        ref = match.group(1)
        return img_tag_for(ref)

    text = obsidian_pattern.sub(obsidian_sub, text)

    # Markdown: ![alt](path/to/image.png)
    md_pattern = re.compile(r"!\[[^\]]*]\(([^)]+)\)")

    def md_sub(match: re.Match) -> str:
        ref = match.group(1)
        return img_tag_for(ref)

    text = md_pattern.sub(md_sub, text)

    return text

def replace_image_syntax_markdown(
    text: str,
    root: Path,
    image_index: Dict[str, Path],
) -> str:
    """
    Convert Obsidian / Markdown image syntax into *Markdown* image syntax,
    while uploading the files to Anki via storeMediaFile().

    - Obsidian: ![[path/to/image.png|alt]] -> ![alt](filename)
    - Markdown: ![alt](path/to/image.png)  -> ![alt](filename)
    - Bare Obsidian pasted lines: `!Pasted image 20251008083919.png`
      -> `![](Pasted image 20251008083919.png)`

    We return markdown (not HTML); markdown.markdown() will turn it into <img>.
    """

    def img_for_ref(ref: str, alt: str = "") -> str:
        img_path = resolve_image_path(ref, root, image_index)
        if not img_path:
            # fallback: show something visible
            return f"[missing image: {ref}]"
        filename = store_media_file(img_path)
        # Markdown image
        return f"![{alt}]({filename})"

    # 1) Handle bare "Pasted image" lines from Obsidian export:
    #    `!Pasted image 20251008083919.png`
    lines = text.splitlines()
    new_lines = []
    pasted_pattern = re.compile(
        r"^!Pasted image\s+(.+\.(?:png|jpg|jpeg|gif|svg|webp))\s*$",
        re.IGNORECASE,
    )
    for line in lines:
        m = pasted_pattern.match(line.strip())
        if m:
            ref = m.group(1).strip()
            new_lines.append(img_for_ref(ref))
        else:
            new_lines.append(line)
    text = "\n".join(new_lines)

    # 2) Obsidian: ![[path/to/image.png|optional alt]]
    def obsidian_sub(match: re.Match) -> str:
        inner = match.group(1)  # path or filename
        alt = match.group(2) or ""  # optional alias
        return img_for_ref(inner, alt)

    obsidian_pattern = re.compile(r"!\[\[([^|\]]+)(?:\|([^]]*))?\]\]")
    text = obsidian_pattern.sub(obsidian_sub, text)

    # 3) Markdown: ![alt](path/to/image.png)
    def md_sub(match: re.Match) -> str:
        alt = match.group(1) or ""
        ref = match.group(2)
        return img_for_ref(ref, alt)

    md_pattern = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
    text = md_pattern.sub(md_sub, text)

    return text

def ensure_blank_line_before_lists(text: str) -> str:
    """
    Make markdown more reliable by inserting a blank line before list blocks.

    Turns:
        Noe tekst
        1. Punkt én
        2. Punkt to

    into:
        Noe tekst

        1. Punkt én
        2. Punkt to
    """
    lines = text.splitlines()
    out: List[str] = []
    prev_blank = True

    list_item_pattern = re.compile(r"^(\s*)(\d+\.\s+|[-*+]\s+)")

    for line in lines:
        stripped = line.rstrip("\n")
        is_list_item = bool(list_item_pattern.match(stripped))

        if is_list_item and out and not prev_blank:
            # Insert a blank line before the list item
            out.append("")
            prev_blank = True

        out.append(line)
        prev_blank = (stripped.strip() == "")

    return "\n".join(out)

def process_front_text(text: str, root: Path, image_index: Dict[str, Path]) -> str:
    # Fronts: keep it simple: no markdown→HTML, just clean links + images.
    text = replace_wikilinks(text)
    text = replace_image_syntax_markdown(text, root, image_index)
    text, latex_chunks = protect_latex(text)
    text = restore_latex(text, latex_chunks)
    return text


def process_back_text(text: str, root: Path, image_index: Dict[str, Path]) -> str:
    # 1) Clean Obsidian-specific syntax
    text = replace_wikilinks(text)
    text = replace_image_syntax_markdown(text, root, image_index)

    # 1.5) Normalize lists so markdown recognizes them
    text = ensure_blank_line_before_lists(text)

    # 2) Protect LaTeX so markdown doesn't strip backslashes
    text, latex_chunks = protect_latex(text)

    # 3) Convert markdown -> HTML
    html = markdown.markdown(text, extensions=["extra"])

    # 4) Restore LaTeX in the resulting HTML
    html = restore_latex(html, latex_chunks)

    return html


def extract_cards_from_file(
    path: Path,
    root: Path,
    image_index: Dict[str, Path],
) -> List[Tuple[str, str]]:
    """
    If the file contains any '## ' (H2) headings:
        - Each H2 becomes one Basic card:
            Front: the H2 text
            Back: all content until the next H2 (H3+ etc. included)
    If the file contains no H2:
        - The entire page becomes one Basic card:
            Front: first H1 ('# Title') if present, else filename (stem)
            Back: the rest of the page content (excluding that H1 line if present)
    """
    cards: List[Tuple[str, str]] = []

    # Read all lines once
    with path.open("r", encoding="utf-8") as f:
        lines = f.readlines()

    # Detect H1 / H2 presence
    title_h1: Optional[str] = None
    has_h2 = False

    for line in lines:
        stripped = line.rstrip("\n")
        if stripped.startswith("# "):
            if title_h1 is None:
                title_h1 = stripped[2:].strip()
        if stripped.startswith("## "):
            has_h2 = True

    # Case 1: there is at least one H2 -> split per H2 section
    if has_h2:
        current_h2: Optional[str] = None
        buffer: List[str] = []
        intro_lines: List[str] = []

        for line in lines:
            stripped = line.rstrip("\n")

            if stripped.startswith("## "):
                # flush previous H2 section if any
                if current_h2 is not None:
                    back_raw = "".join(buffer).strip()
                    front_raw = current_h2
                    front = process_front_text(front_raw, root, image_index)
                    back = process_back_text(back_raw, root, image_index)
                    cards.append((front, back))

                # start new H2 section
                current_h2 = stripped[3:].strip()
                buffer = []
                continue

            # Before the first H2, lines belong to the intro section
            if current_h2 is None:
                intro_lines.append(line)
            else:
                buffer.append(line)

        # flush last H2 section
        if current_h2 is not None:
            back_raw = "".join(buffer).strip()
            front_raw = current_h2
            front = process_front_text(front_raw, root, image_index)
            back = process_back_text(back_raw, root, image_index)
            cards.append((front, back))

        # Create an "intro" card for the content before the first H2 (if any)
        intro_text = "".join(intro_lines).strip()
        if intro_text:
            # Front for the intro card: H1 title if present, else filename stem
            front_raw = title_h1 if title_h1 else path.stem
            back_raw = intro_text
            front = process_front_text(front_raw, root, image_index)
            back = process_back_text(back_raw, root, image_index)
            cards.insert(0, (front, back))  # put intro card first

        return cards

    # Case 2: no H2 -> whole page = one card
    content_lines: List[str] = []
    used_title = None

    for line in lines:
        stripped = line.rstrip("\n")
        if stripped.startswith("# ") and used_title is None:
            used_title = stripped[2:].strip()
            # skip this line from the back content
            continue
        content_lines.append(line)

    front_raw = used_title if used_title else path.stem
    back_raw = "".join(content_lines).strip()

    front = process_front_text(front_raw, root, image_index)
    back  = process_back_text(back_raw,  root, image_index)  

    cards.append((front, back))
    return cards

LATEX_PLACEHOLDER_PREFIX = "§§LATEX"
LATEX_PLACEHOLDER_SUFFIX = "§§"

MATHY_CHARS_PATTERN = re.compile(r"[\\_^]|\d")

def is_probably_math(inner: str) -> bool:
    """Heuristic: treat $...$ as math only if it contains typical math chars."""
    return bool(MATHY_CHARS_PATTERN.search(inner))

def normalize_latex_chunk(chunk: str) -> str:
    """Convert $...$ / $$...$$ to MathJax-friendly delimiters."""
    if chunk.startswith("$$") and chunk.endswith("$$") and len(chunk) >= 4:
        inner = chunk[2:-2]
        return r"\[" + inner + r"\]"
    if chunk.startswith("$") and chunk.endswith("$") and len(chunk) >= 2:
        inner = chunk[1:-1]
        # Keep as-is if it doesn't look like math (e.g. currency)
        if not is_probably_math(inner):
            return chunk
        return r"\(" + inner + r"\)"
    return chunk

def protect_latex(text: str) -> Tuple[str, List[str]]:
    """Replace LaTeX segments with placeholders so markdown doesn't eat backslashes."""
    stored: List[str] = []

    def make_placeholder(idx: int) -> str:
        return f"{LATEX_PLACEHOLDER_PREFIX}{idx}{LATEX_PLACEHOLDER_SUFFIX}"

    def store_and_replace(match: re.Match) -> str:
        stored.append(match.group(0))
        return make_placeholder(len(stored) - 1)

    # 1) MathJax/LaTeX style delimiters
    text = re.sub(r"\\\([^\)]*?\\\)", store_and_replace, text, flags=re.DOTALL)  # \( ... \)
    text = re.sub(r"\\\[[^\]]*?\\\]", store_and_replace, text, flags=re.DOTALL)  # \[ ... \]

    # 2) Display math with $$ ... $$ (always treat as math)
    text = re.sub(r"\$\$.*?\$\$", store_and_replace, text, flags=re.DOTALL)

    # 3) Inline math with $ ... $ (only treat as math if it looks mathy)
    def inline_dollar_sub(match: re.Match) -> str:
        full = match.group(0)
        inner = match.group(1)
        if is_probably_math(inner):
            stored.append(full)
            return make_placeholder(len(stored) - 1)
        return full

    text = re.sub(r"\$(?!\s)([^$\n]+?)(?<!\s)\$", inline_dollar_sub, text)

    return text, stored


def restore_latex(text: str, stored: List[str]) -> str:
    for idx, chunk in enumerate(stored):
        placeholder = f"{LATEX_PLACEHOLDER_PREFIX}{idx}{LATEX_PLACEHOLDER_SUFFIX}"
        text = text.replace(placeholder, normalize_latex_chunk(chunk))
    return text





# ------------- MAIN SYNC -------------



def delete_removed_notes(kept_ids: Set[int]) -> None:
    """
    Delete Anki notes that were previously created/managed by this script
    (identified by a global tag) but are no longer present in the current
    Obsidian scan (i.e., their IDs are not in kept_ids).
    """
    if not GLOBAL_TAGS:
        return

    tag = GLOBAL_TAGS[0]
    # Restrict to decks under this vault root (e.g. "1AB" and its subdecks)
    deck_root = OBSIDIAN_ROOT.name
    query = f'tag:"{tag}" deck:"{deck_root}"'

    try:
        managed_ids = anki_invoke("findNotes", query=query)
    except RuntimeError as e:
        print(f"Warning: could not fetch managed notes for deletion: {e}")
        return

    to_delete = [nid for nid in managed_ids if nid not in kept_ids]

    if not to_delete:
        print("No notes to delete.")
        return

    anki_invoke("deleteNotes", notes=to_delete)
    print(f"Deleted {len(to_delete)} notes that no longer exist in Obsidian.")


def main():
    # Bail out early if Anki / AnkiConnect is not reachable
    if not check_anki_running():
        print("Aborting sync because Anki/AnkiConnect is not available.")
        return

    root = OBSIDIAN_ROOT
    print(f"Scanning Obsidian vault: {root}")
    image_index = index_image_files(root)
    print(f"Indexed {len(image_index)} image files.\n")

    total_basic = 0
    total_cloze = 0
    kept_note_ids: Set[int] = set()

    for md_file in find_markdown_files(root):
        rel = md_file.relative_to(root)
        parts = rel.parts

        deck_parts = [root.name] + list(parts[:-1]) + [rel.stem]
        deck_name = "::".join(deck_parts)

        file_tag = rel.stem.replace(" ", "_")
        tags = GLOBAL_TAGS + [file_tag]

        print(f"File: {rel}")
        print(f"  Deck: {deck_name}")

        file_basic: List[Tuple[str, str]] = []
        file_cloze: List[str] = []
        new_note_ids: List[int] = []

        # Currently only H2/page-based cards are enabled
        file_basic.extend(
            extract_cards_from_file(md_file, root, image_index)
        )

        for front, back in file_basic:
            nid = upsert_basic(front, back, deck_name, tags)
            if nid and nid > 0:
                kept_note_ids.add(nid)
                new_note_ids.append(nid)
            total_basic += 1

        for text in file_cloze:
            nid = upsert_cloze(text, deck_name, tags)
            if nid and nid > 0:
                kept_note_ids.add(nid)
                new_note_ids.append(nid)
            total_cloze += 1

    # Delete notes that are no longer present in the Obsidian vault
    delete_removed_notes(kept_note_ids)

    print()
    print("Sync complete.")
    print(f"Total Basic notes processed: {total_basic}")
    print(f"Total Cloze notes processed: {total_cloze}")


if __name__ == "__main__":
    main()