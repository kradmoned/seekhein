
from rag.chunker import chunk_pages


def test_chunk_pages():
    pages = [{
        "text": "This is a sample programming lab. " * 100,
        "metadata": {
            "document_name": "Lab-03.pdf",
            "page_number": 1
        }
    }]

    chunks = chunk_pages(pages, chunk_size=200, overlap=30)

    assert len(chunks) > 1
    assert all(chunk["text"] for chunk in chunks)
    assert all(
        chunk["metadata"]["document_name"] == "Lab-03.pdf"
        for chunk in chunks
    )
    assert all(
        chunk["metadata"]["page_number"] == 1
        for chunk in chunks
    )


def test_empty_page():
    pages = [{
        "text": "   ",
        "metadata": {
            "document_name": "test.pdf",
            "page_number": 1
        }
    }]

    assert chunk_pages(pages) == []

def test_heading_preserved():
    pages = [{
        "text": "Activity-05: Find Maximum\nFind the largest element in an array.",
        "metadata": {
            "document_name": "test.pdf",
            "page_number": 1
        }
    }]

    chunks = chunk_pages(pages)

    assert any(
        "Activity-05" in chunk["text"]
        and "largest element" in chunk["text"]
        for chunk in chunks
    )