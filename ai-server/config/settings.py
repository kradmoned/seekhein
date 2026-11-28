import os
from dotenv import load_dotenv

load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
MODEL_NAME = os.getenv("OPENROUTER_MODEL")

if not OPENROUTER_API_KEY:
    raise ValueError("OpenRouter API key not found!")

SESSION_DB_PATH = os.getenv("SESSION_DB_PATH", "./data/sessions.db")
MAX_HISTORY_TURNS = int(os.getenv("MAX_HISTORY_TURNS", "6"))
if MAX_HISTORY_TURNS < 1:
    raise ValueError("MAX_HISTORY_TURNS must be at least 1.")
