-- Memories: one row per markdown "file", addressed by a unique path like /writing/style.md
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL UNIQUE,
  description TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  tags        TEXT    NOT NULL DEFAULT '[]',   -- JSON array of strings
  source      TEXT    NOT NULL,                -- which AI wrote it: claude, chatgpt, gemini, ...
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);

-- Full-text index (external content table backed by memories).
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  path,
  description,
  body,
  tags,
  content = 'memories',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

-- Keep FTS in sync.
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, path, description, body, tags)
  VALUES (new.id, new.path, new.description, new.body, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, path, description, body, tags)
  VALUES ('delete', old.id, old.path, old.description, old.body, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, path, description, body, tags)
  VALUES ('delete', old.id, old.path, old.description, old.body, old.tags);
  INSERT INTO memories_fts(rowid, path, description, body, tags)
  VALUES (new.id, new.path, new.description, new.body, new.tags);
END;
