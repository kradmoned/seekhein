
from pathlib import Path
import pymupdf


def extract_text(pdf_path: str | Path) -> list[dict]:
    """
    Extract text from a PDF, preserving page numbers.

    Args:
        pdf_path: Path to the PDF document.

    Returns:
        List of dictionaries containing page text and metadata.
    """
    pdf_path = Path(pdf_path)

    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    pages = []

    with pymupdf.open(pdf_path) as document:
        for page_number, page in enumerate(document, start=1):
            text = page.get_text("text").strip()

            if text:
                pages.append({
                    "text": text,
                    "metadata": {
                        "document_name": pdf_path.name,
                        "page_number": page_number
                    }
                })

    return pages
