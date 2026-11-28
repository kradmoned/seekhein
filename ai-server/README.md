# Seekhein AI Server

The AI backend for **Seekhein**, an AI-powered programming lab assistant that helps students understand programming problems through Socratic questioning rather than simply providing solutions.

The server receives student messages, conversation context, code, execution results, and validation feedback. It uses retrieval-augmented generation (RAG) and an LLM-powered Socratic agent to generate contextual learning guidance.

\---

## 1\. Project Overview

The AI Server is responsible for:

* Understanding the student's programming questions.
* Analyzing current and previously executed code.
* Interpreting runtime errors and code-runner validation feedback.
* Retrieving relevant information from programming lab materials.
* Generating Socratic hints and explanations.
* Maintaining context using conversation history supplied by the backend.

The AI Server exposes a REST API that the main Seekhein backend can communicate with.

## 2\. Technology Stack

|Technology|Purpose|
|-|-|
|Python|Backend programming language|
|FastAPI|REST API framework|
|Uvicorn|ASGI server|
|OpenRouter|LLM API access|
|ChromaDB|Vector database|
|Sentence Transformers|Text embeddings|
|PyMuPDF|PDF text extraction|
|Pytest|Automated testing|
|uv|Python dependency and project management|

**Python requirement:** Python 3.14 or later, as specified in `pyproject.toml`.

## 3\. Project Structure

```text
ai-server/
│
├── agent/
│   ├── \_\_init\_\_.py
│   ├── context\_builder.py
│   ├── execution\_sanitizer.py
│   ├── rag\_integration.py
│   ├── session\_manager.py
│   └── socratic\_engine.py
│
├── api/
│   ├── \_\_init\_\_.py
│   ├── main.py
│   ├── routes.py
│   └── schemas.py
│
├── config/
│   └── settings.py
│
├── docs/
│   ├── agents\_and\_workflow.md
│   ├── architecture.md
│   ├── backend\_integration.md
│   ├── code-runner-spec.md
│   └── rag\_pipeline.md
│
├── knowledge\_base/
│   └── lab\_materials/
│
├── rag/
│   ├── \_\_init\_\_.py
│   ├── chunker.py
│   ├── document\_processor.py
│   ├── embedding.py
│   ├── ingest.py
│   ├── retriever.py
│   └── vector\_store.py
│
├── src/
│   └── seekhein/
│
├── tests/
│   ├── fixtures/
│   └── test\_\*.py
│
├── main.py
├── pyproject.toml
├── uv.lock
└── README.md
```

### Main Components

**`agent/` — AI Agent Layer**

Contains the logic responsible for building student context, sanitizing execution feedback, retrieving relevant lab information, managing session-related utilities, and generating Socratic responses.

**`api/` — API Layer**

Contains the FastAPI application, endpoint definitions, and request/response schemas.

**`config/` — Configuration**

Loads environment variables and provides application configuration, including the OpenRouter API key and model name.

**`rag/` — Retrieval-Augmented Generation**

Processes learning materials, creates embeddings, stores document chunks in ChromaDB, and retrieves relevant content for the AI agent.

**`knowledge\_base/` — Learning Materials**

Contains the educational material used by the retrieval system. Lab manuals and other course materials are not committed to Git when excluded by `.gitignore`.

**`tests/` — Testing**

Contains automated tests for the backend, agent components, and RAG pipeline.

## 4\. Setup and Installation

### Prerequisites

* Python 3.14 or later
* uv
* An OpenRouter API key

### Clone the Repository

```bash
git clone https://github.com/seekhain/seekhein.git
cd seekhein/ai-server
```

### Install Dependencies

```bash
uv sync
```

This installs the dependencies specified in `pyproject.toml` and `uv.lock`.

### Configure Environment Variables

Create a `.env` file in the `ai-server/` directory for local development:

```env
OPENROUTER\_API\_KEY=your\_openrouter\_api\_key
OPENROUTER\_MODEL=your\_model\_name
```

Do not commit `.env` or expose API keys in source code.

The deployed application should receive these variables through its hosting platform's environment-variable settings.

## 5\. Running the Server

From inside the `ai-server/` directory:

```bash
uv run uvicorn api.main:app --reload
```

The development server runs at:

```text
http://127.0.0.1:8000
```

### Available API Pages

|URL|Purpose|
|-|-|
|`/health`|Health check|
|`/docs`|Interactive Swagger API documentation|
|`/openapi.json`|OpenAPI specification|

## 6\. API Integration

### Main Endpoint

```http
POST /api/v1/tutor
```

The endpoint receives student input and execution context from the main Seekhein backend.

### Request Fields

|Field|Description|
|-|-|
|`conversation\_id`|Conversation identifier, returned with the response|
|`message`|Current student message|
|`recent\_messages`|Recent conversation history supplied by the backend|
|`current\_code`|Current code in the editor|
|`executed\_code`|Code that was executed by the student|
|`output\_error`|Program output or error information|
|`validation\_feedback`|Complete code-runner validation feedback|

Fields that are not available in a particular interaction may be empty or null, subject to the API schema.

### Important Integration Notes

* The backend is responsible for supplying conversation history through `recent\_messages`.
* The AI Server does not independently maintain the complete conversation history.
* `conversation\_id` is returned for conversation association; it is not used as a substitute for the supplied history.
* `validation\_feedback` should contain the complete code-runner response in the agreed `view=tutor` format.
* The AI Server sanitizes and extracts relevant execution information internally.
* The AI Server is responsible for interpreting the supplied context and generating the tutoring response.

For the complete request/response contract and examples, see:

[`docs/backend\_integration.md`](docs/backend_integration.md)

## 7\. AI Agent Workflow

The general processing flow is:

```text
Main Seekhein Backend
        |
        v
POST /api/v1/tutor
        |
        v
API Request Validation
        |
        v
Context Builder
        |
        +----------------------+
        |                      |
        v                      v
Execution Sanitizer       RAG Integration
        |                      |
        v                      v
Execution Context       Relevant Lab Context
        |                      |
        +----------+-----------+
                   |
                   v
             Socratic Engine
                   |
                   v
          Generated AI Response
                   |
                   v
             API Response
                   |
                   v
          Main Seekhein Backend
```

The `SocraticEngine` is the primary LLM-powered agent. The other agent modules support context preparation, execution-feedback processing, retrieval, and session-related functionality.

For detailed responsibilities and workflow documentation, see:

[`docs/agents\_and\_workflow.md`](docs/agents_and_workflow.md)

## 8\. Retrieval-Augmented Generation (RAG)

The RAG pipeline provides the AI agent with relevant information from programming lab materials.

Its main stages are:

1. Load educational documents.
2. Extract text from supported documents.
3. Split documents into smaller chunks.
4. Generate embeddings using Sentence Transformers.
5. Store the embeddings and metadata in ChromaDB.
6. Retrieve relevant chunks when a student asks a question.
7. Pass retrieved context to the Socratic Engine.

The vector database is generated locally and should not be committed to Git.

The ingestion and retrieval implementation is located in `rag/`.

For further details, see:

[`docs/rag\_pipeline.md`](docs/rag_pipeline.md)

## 9\. Running Tests

From the `ai-server/` directory:

```bash
uv run pytest
```

To run tests with verbose output:

```bash
uv run pytest -v
```

To run a particular test file:

```bash
uv run pytest tests/test\_context\_builder.py
```

## 10\. Environment and Security

The following should remain local or be configured securely through the deployment platform:

* `.env`
* API keys and credentials
* `.venv/`
* Python cache files
* ChromaDB databases
* Local test vector databases
* Private lab manuals and course materials

Never commit secrets, credentials, or private educational material.

## 11\. Deployment Notes

The AI Server is organized as a separate project inside the Seekhein repository.

For deployment platforms that support configuring a project root directory, use:

```text
ai-server
```

The deployment environment must:

1. Use a compatible Python version.
2. Install dependencies from `pyproject.toml` and `uv.lock`.
3. Configure `OPENROUTER\_API\_KEY`.
4. Configure `OPENROUTER\_MODEL`.
5. Start the FastAPI application using an appropriate ASGI deployment configuration.

**Important:** Setting the project root directory alone does not guarantee deployment compatibility. The hosting platform must support the application's Python/FastAPI runtime and deployment entry point.

## 12\. Additional Documentation

|Document|Description|
|-|-|
|[`backend\_integration.md`](docs/backend_integration.md)|API contract and backend integration|
|[`agents\_and\_workflow.md`](docs/agents_and_workflow.md)|Agent responsibilities and processing workflow|
|[`architecture.md`](docs/architecture.md)|System architecture|
|[`rag\_pipeline.md`](docs/rag_pipeline.md)|RAG pipeline and retrieval|
|[`code-runner-spec.md`](docs/code-runner-spec.md)|Code-runner integration specification|

\---

**\*\*Seekhein AI Server\*\***



**Socratic AI Programming Lab Assistant**
