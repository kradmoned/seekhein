import re
from typing import Any


HEADING_PATTERN = re.compile(
    r"(?im)^(?:activity\s*[-:]?\s*\d+|"
    r"experiment\s*[-:]?\s*\d+|"
    r"exercise\s*[-:]?\s*\d+|"
    r"lab\s*[-:]?\s*\d+|"
    r"chapter\s*[-:]?\s*\d+)\b.*$"
)


def split_long_text(
    text: str,
    chunk_size: int,
    overlap: int
) -> list[str]:
    chunks = []
    start = 0

    while start < len(text):
        end = min(start + chunk_size, len(text))

        if end < len(text):
            boundary = text.rfind(" ", start, end)
            if boundary > start:
                end = boundary

        chunk = text[start:end].strip()

        if chunk:
            chunks.append(chunk)

        if end == len(text):
            break

        start = max(start + 1, end - overlap)

    return chunks


def chunk_pages(
    pages: list[dict[str, Any]],
    chunk_size: int = 1000,
    overlap: int = 150
) -> list[dict[str, Any]]:

    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")

    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("Invalid overlap")

    chunks = []

    for page in pages:
        text = page["text"].strip()

        if not text:
            continue

        matches = list(HEADING_PATTERN.finditer(text))
        sections = []

        if matches:
            # Preserve heading with its content
            for i, match in enumerate(matches):
                start = match.start()
                end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
                sections.append(text[start:end])

            # Preserve text before the first heading
            if matches[0].start() > 0:
                sections.insert(0, text[:matches[0].start()])
        else:
            # Fallback: paragraph-based splitting
            sections = re.split(r"\n\s*\n", text)

        for section in sections:
            section = " ".join(section.split())

            if not section:
                continue

            for part in split_long_text(section, chunk_size, overlap):
                chunks.append({
                    "text": part,
                    "metadata": {
                        **page["metadata"],
                        "chunk_id": len(chunks)
                    }
                })

    return chunks