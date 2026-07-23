CREATE TABLE codex_chat_settings (
    thread_id TEXT PRIMARY KEY NOT NULL,
    browser_access_enabled INTEGER NOT NULL CHECK (browser_access_enabled IN (0, 1)),
    updated_at TEXT NOT NULL
);
