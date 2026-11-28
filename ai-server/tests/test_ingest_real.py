from pathlib import Path
from rag.ingest import ingest_pdf
from rag.vector_store import VectorStore


def test_real_pdf_ingestion(tmp_path):
    pdf_path = Path("knowledge_base/lab_manuals/Lab-03.pdf")

    assert pdf_path.exists(), "Sample lab manual not found"

    store = VectorStore(db_path=str(tmp_path / "real_test_db"))

    count = ingest_pdf(
        pdf_path,
        lab_id="cfp_lab_3"
    )

    assert count > 0
    assert store.count() == 0  # Separate database; see note below