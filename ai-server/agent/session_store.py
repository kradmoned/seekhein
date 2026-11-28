from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import threading
from typing import Any


class SQLiteSessionStore:
    """Persist tutor sessions, pinned lab context, history, and idempotent turns."""

    def __init__(self, db_path: str = "./data/sessions.db"):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._memory_conn: sqlite3.Connection | None = None

        if db_path != ":memory:":
            Path(db_path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        else:
            self._memory_conn = self._open_connection()

        self._init_schema()

    def _open_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self.db_path,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        if self.db_path != ":memory:":
            conn.execute("PRAGMA journal_mode = WAL")
        return conn

    @contextmanager
    def _connect(self):
        conn = self._memory_conn if self._memory_conn is not None else self._open_connection()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            if self._memory_conn is None:
                conn.close()

    def _init_schema(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    conversation_id TEXT PRIMARY KEY,
                    lab_context_json TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL REFERENCES sessions(conversation_id) ON DELETE CASCADE,
                    turn_id INTEGER NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE INDEX IF NOT EXISTS idx_messages_conv_id
                    ON messages(conversation_id, id);

                CREATE TABLE IF NOT EXISTS turns (
                    conversation_id TEXT NOT NULL REFERENCES sessions(conversation_id) ON DELETE CASCADE,
                    idempotency_key TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    sources_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY (conversation_id, idempotency_key)
                );
                """
            )

    def ensure_session(
        self,
        conversation_id: str,
        lab_context: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Create the session if missing, optionally pin/update lab_context, and return it."""
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO sessions (conversation_id) VALUES (?)",
                (conversation_id,),
            )

            if isinstance(lab_context, dict) and lab_context:
                conn.execute(
                    """
                    UPDATE sessions
                    SET lab_context_json = ?, updated_at = datetime('now')
                    WHERE conversation_id = ?
                    """,
                    (json.dumps(lab_context, ensure_ascii=False), conversation_id),
                )

            row = conn.execute(
                "SELECT lab_context_json FROM sessions WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()

        if row is None or row["lab_context_json"] is None:
            return None

        return json.loads(row["lab_context_json"])

    def get_idempotent_response(
        self,
        conversation_id: str,
        idempotency_key: str,
    ) -> dict[str, Any] | None:
        """Return a previously stored response for (conversation_id, idempotency_key)."""
        with self._lock, self._connect() as conn:
            row = conn.execute(
                """
                SELECT answer, sources_json
                FROM turns
                WHERE conversation_id = ? AND idempotency_key = ?
                """,
                (conversation_id, idempotency_key),
            ).fetchone()

        if row is None:
            return None

        return {
            "answer": row["answer"],
            "sources": json.loads(row["sources_json"]),
        }

    def get_recent_messages(
        self,
        conversation_id: str,
        max_turns: int = 6,
    ) -> list[dict[str, str]]:
        """Return up to the last max_turns turns (2 messages per turn) in chronological order."""
        if max_turns < 1:
            raise ValueError("max_turns must be at least 1.")

        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT role, content
                FROM messages
                WHERE conversation_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (conversation_id, max_turns * 2),
            ).fetchall()

        return [
            {"role": row["role"], "content": row["content"]}
            for row in reversed(rows)
        ]

    def save_turn(
        self,
        conversation_id: str,
        user_message: str,
        assistant_answer: str,
        sources: list[Any],
        idempotency_key: str | None = None,
    ) -> None:
        """Atomically persist a completed user/assistant turn and optional idempotency record."""
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO sessions (conversation_id) VALUES (?)",
                (conversation_id,),
            )

            if idempotency_key is not None:
                existing = conn.execute(
                    """
                    SELECT 1
                    FROM turns
                    WHERE conversation_id = ? AND idempotency_key = ?
                    """,
                    (conversation_id, idempotency_key),
                ).fetchone()
                if existing is not None:
                    return

            row = conn.execute(
                "SELECT COALESCE(MAX(turn_id), 0) + 1 AS next_turn_id FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            next_turn_id = row["next_turn_id"]

            conn.executemany(
                """
                INSERT INTO messages (conversation_id, turn_id, role, content)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (conversation_id, next_turn_id, "user", user_message),
                    (conversation_id, next_turn_id, "assistant", assistant_answer),
                ],
            )

            if idempotency_key is not None:
                conn.execute(
                    """
                    INSERT INTO turns (conversation_id, idempotency_key, answer, sources_json)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        conversation_id,
                        idempotency_key,
                        assistant_answer,
                        json.dumps(sources, ensure_ascii=False),
                    ),
                )

            conn.execute(
                "UPDATE sessions SET updated_at = datetime('now') WHERE conversation_id = ?",
                (conversation_id,),
            )

    def delete_session(self, conversation_id: str) -> bool:
        """Delete a session and cascade-delete its messages and idempotency records."""
        with self._lock, self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM sessions WHERE conversation_id = ?",
                (conversation_id,),
            )
            return cursor.rowcount > 0
