
import chromadb

DB_PATH = "./chroma_db"
COLLECTION_NAME = "lab_documents"


class VectorStore:
    """Manage document embeddings using ChromaDB."""

    def __init__(self, db_path: str = DB_PATH):
        self.client = chromadb.PersistentClient(path=db_path)

        self.collection = self.client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"}
        )

    def add_chunks(
        self,
        chunks: list[dict],
        embeddings: list[list[float]]
    ) -> None:
        """Store chunks, embeddings, and metadata."""

        if len(chunks) != len(embeddings):
            raise ValueError("Chunks and embeddings count must match")

        if not chunks:
            return

        self.collection.upsert(
            ids=[
                f"{chunk['metadata']['document_name']}_"
                f"{chunk['metadata']['page_number']}_"
                f"{chunk['metadata']['chunk_id']}"
                for chunk in chunks
            ],
            documents=[chunk["text"] for chunk in chunks],
            embeddings=embeddings,
            metadatas=[chunk["metadata"] for chunk in chunks]
        )

    def count(self) -> int:
        """Return the number of stored chunks."""
        return self.collection.count()

    def search(
        self,
        query_embedding: list[float],
        top_k: int = 3,
        where: dict | None = None
    ) -> list[dict]:
        """Retrieve the most relevant chunks."""

        results = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            where=where
        )

        if not results["documents"] or not results["documents"][0]:
            return []

        return [
            {
                "text": document,
                "metadata": metadata,
                "distance": distance
            }
            for document, metadata, distance in zip(
                results["documents"][0],
                results["metadatas"][0],
                results["distances"][0]
            )
        ]