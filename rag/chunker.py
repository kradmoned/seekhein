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


def _format_json_value(value: Any, label: str | None = None) -> list[str]:
    """Convert structured JSON fields into readable text."""

    lines = []

    if isinstance(value, dict):
        if label:
            lines.append(f"{label}:")

        for key, item in value.items():
            lines.extend(_format_json_value(item, key))

    elif isinstance(value, list):
        if label:
            lines.append(f"{label}:")

        for index, item in enumerate(value, start=1):
            lines.extend(
                _format_json_value(item, f"Item {index}")
            )

    else:
        if label:
            lines.append(f"{label}: {value}")
        else:
            lines.append(str(value))

    return lines


def chunk_lab_json(
    lab_content: dict[str, Any],
    chunk_size: int = 1000,
    overlap: int = 150,
) -> list[dict[str, Any]]:
    """Create structure-aware chunks from a JSON lab manual."""

    if not isinstance(lab_content, dict) or not lab_content:
        raise ValueError("Lab content must be a non-empty JSON object.")

    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")

    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("Invalid overlap")

    units = []

    def add_unit(
        title: str,
        content: Any,
        metadata: dict[str, Any],
    ) -> None:
        lines = [title]
        lines.extend(_format_json_value(content))
        units.append({
            "text": "\n".join(lines),
            "metadata": metadata,
        })

    base_metadata = {
        "document_name": "lab_content.json",
        "page_number": 1,
    }

    # Lab metadata
    if lab_content.get("lab_metadata"):
        add_unit(
            "Lab Metadata",
            lab_content["lab_metadata"],
            {**base_metadata, "content_type": "lab_metadata"},
        )

    # Individual sections and their topics or activities
    for section in lab_content.get("sections", []):
        section_id = str(section.get("section_id", ""))
        section_title = str(section.get("title", "Untitled Section"))

        section_metadata = {
            **base_metadata,
            "section_id": section_id,
            "section_title": section_title,
        }

        section_details = {
            key: value
            for key, value in section.items()
            if key not in {"topics", "activities"}
        }

        add_unit(
            f"Section: {section_title}",
            section_details,
            {**section_metadata, "content_type": "section"},
        )

        for index, topic in enumerate(section.get("topics", []), start=1):
            topic_title = (
                topic.get("title", f"Topic {index}")
                if isinstance(topic, dict)
                else f"Topic {index}"
            )

            add_unit(
                f"Section: {section_title}\nTopic: {topic_title}",
                topic,
                {**section_metadata, "content_type": "topic"},
            )

        for index, activity in enumerate(
            section.get("activities", []),
            start=1,
        ):
            if not isinstance(activity, dict):
                continue

            activity_number = activity.get("activity_number", index)
            activity_title = activity.get(
                "title",
                f"Activity {activity_number}",
            )

            add_unit(
                f"Section: {section_title}\n"
                f"Activity {activity_number}: {activity_title}",
                activity,
                {
                    **section_metadata,
                    "content_type": "activity",
                    "activity_number": activity_number,
                },
            )

    # Source notes
        # Source notes
    for index, note in enumerate(
        lab_content.get("source_notes", []),
        start=1,
    ):
        add_unit(
            f"Source Note {index}",
            note,
            {**base_metadata, "content_type": "source_note"},
        )

    # Fallback for simpler lab JSON structures
    if not units:
        add_unit(
            "Lab Content",
            lab_content,
            {**base_metadata, "content_type": "lab_content"},
        )

    chunks = []

    for unit in units:
        parts = split_long_text(
            unit["text"],
            chunk_size,
            overlap,
        )

        for part in parts:
            chunks.append({
                "text": part,
                "metadata": {
                    **unit["metadata"],
                    "chunk_id": len(chunks),
                },
            })

    return chunks
