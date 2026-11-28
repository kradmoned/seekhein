from pathlib import Path

from rag.ingest import ingest_pdf
from rag.retriever import retrieve


def test_real_pdf_retrieval(tmp_path):
    pdf_path = Path("knowledge_base/lab_manuals/Lab-03.pdf")
    db_path = str(tmp_path / "e2e_db")

    count = ingest_pdf(
        pdf_path,
        lab_id="cfp_lab_03",
        db_path=db_path
    )

    assert count > 0

    result = retrieve(
        "How do I reverse an array?",
        lab_id="cfp_lab_03",
        db_path=db_path
    )

    assert len(result["context"]) > 0
    assert len(result["sources"]) > 0