
# AGENTS.md

## Project Overview
Socratic AI Lab Assistant: an AI-powered programming
education assistant that teaches through the Socratic Method.

## Architecture
- agent/: AI reasoning and student interaction.
- rag/: Document processing and retrieval.
- knowledge_base/: Educational documents.
- docs/: Architecture and technical documentation.
- tests/: Automated tests.

## Development Rules
- Use Python.
- Use uv for dependency management.
- Follow modular design and separation of concerns.
- Add type hints and concise docstrings.
- Write tests for new functionality.
- Avoid unnecessary dependencies.
- Never hardcode API keys or commit .env files.

## RAG Requirements
- Use PyMuPDF for PDF extraction.
- Use Sentence Transformers for local embeddings.
- Use ChromaDB for vector storage.
- Preserve document names and page numbers.
- Support lab_id and task_id metadata filtering.
- Keep retrieval independent from LLM generation.

## Token Efficiency
- Prefer deterministic Python logic over LLM calls.
- Do not use LLMs for extraction, chunking, embeddings, or retrieval.
- Retrieve only the most relevant chunks.
- Avoid sending entire documents to the LLM.
- Keep prompts and conversation history concise.
- Cache processed documents and embeddings.

## Documentation
- Document every completed module in docs/.
- Record significant architectural decisions in docs/decisions/.
- Update documentation when interfaces or behavior change.
- Keep documentation concise and accurate.

## Testing
- Use pytest.
- Test normal cases and failure cases.
- Do not require API calls for ordinary unit tests.

## Collaboration
- Respect other members' module ownership.
- Coordinate changes to shared interfaces.
- Do not modify another member's code without agreement.
