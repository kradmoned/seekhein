
from rag.document_processor import extract_text


def test_extract_text():
    pages = extract_text("knowledge_base/lab_manuals/Lab-03.pdf")

    assert len(pages) > 0
    assert "text" in pages[0]
    assert "metadata" in pages[0]
    assert pages[0]["metadata"]["page_number"] == 1
