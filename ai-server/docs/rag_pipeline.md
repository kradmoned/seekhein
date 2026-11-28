# RAG Pipeline

## 1. Document Processing

**Module:** `rag/document_processor.py`  
**Library:** PyMuPDF

**Function:** `extract_text(pdf_path)`

**Purpose:** Extract text from PDFs page by page.

**Output:** Page text with `document_name` and `page_number`.

**Design Decisions:**
- Preserve page-level metadata for source attribution.
- Skip empty pages.
- No LLM API calls.

**Status:**
- [x] PDF text extraction
- [x] Page metadata preservation

## 2. Text Cleaning and Chunking

**Module:** `rag/chunker.py`

**Purpose:** Split extracted text into smaller overlapping chunks.

**Configuration:**
- Chunk size: 1000 characters
- Overlap: 150 characters
- Heading-based splitting with paragraph fallback
- Character-based splitting for long sections

**Design Decisions:**
- Preserve headings with related content.
- Maintain page-level source references.
- No LLM calls.

**Status:**
- [x] Text cleaning
- [x] Hybrid chunking
- [x] Overlapping chunks
- [x] Metadata preservation

## 3. Embeddings

**Module:** `rag/embedding.py`  
**Library:** Sentence Transformers  
**Model:** `all-MiniLM-L6-v2`

**Purpose:** Convert document chunks and queries into numerical vectors.

**Design Decisions:**
- Local embedding generation.
- 384-dimensional normalized embeddings.
- No external embedding API.

**Status:**
- [x] Document embeddings
- [x] Query embeddings
- [x] Dimension verification

## 4. Vector Storage

**Module:** `rag/vector_store.py`  
**Library:** ChromaDB

**Purpose:** Store and retrieve document embeddings.

**Configuration:**
- Persistent database
- Collection: `lab_documents`
- Distance metric: Cosine similarity

**Design Decisions:**
- Persistent local storage.
- Upsert prevents duplicate records.
- Store document metadata with each chunk.

**Status:**
- [x] Persistent database
- [x] Collection creation
- [x] Chunk and embedding storage
- [x] Semantic search

## 5. Retrieval

**Module:** `rag/retriever.py`

**Purpose:** Retrieve relevant content for student questions.

**Input:** Question, optional `lab_id` and `task_id`.

**Output:**
- `context`: Retrieved text chunks
- `sources`: Source metadata

**Design Decisions:**
- Search using query embeddings.
- Support lab and task filtering.
- Return top relevant chunks.
- Answer generation is handled by the Socratic Engine.

**Status:**
- [x] Query embedding
- [x] Semantic retrieval
- [x] Metadata filtering
- [x] End-to-end testing

## 6. Ingestion

**Module:** `rag/ingest.py`

**Function:** `ingest_pdf(pdf_path, lab_id, task_id)`

**Purpose:** Coordinate PDF extraction, chunking, embedding generation, and vector storage.

**Status:**
- [x] PDF ingestion pipeline
- [x] Metadata assignment
- [x] Vector database integration
- [x] End-to-end testing