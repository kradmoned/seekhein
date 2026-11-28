
# System Architecture

## Overview
The system consists of two main components:

1. AI Agent: Guides students through programming
   tasks using the Socratic Method.
2. RAG System: Retrieves relevant information
   from lab manuals and educational resources.

## RAG Responsibilities
- PDF text extraction
- Text cleaning and chunking
- Embedding generation
- Vector storage
- Semantic retrieval
- Source attribution

## Integration
The RAG retriever provides relevant context and
source references to the Socratic Engine.

The RAG system does not generate student responses.
