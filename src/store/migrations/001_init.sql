-- 设备档案：一行一个物理 MAC
CREATE TABLE IF NOT EXISTS devices (
  mac            TEXT PRIMARY KEY,
  router_name    TEXT,
  custom_name    TEXT,
  canonical_mac  TEXT REFERENCES devices(mac) ON DELETE SET NULL,
  is_random_mac  INTEGER NOT NULL DEFAULT 0,
  conn_type      TEXT,
  last_ip        TEXT,
  is_online      INTEGER NOT NULL DEFAULT 0,
  notify         INTEGER NOT NULL DEFAULT 1,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
);

-- 连接会话：一行一次“上线→下线”
CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mac            TEXT NOT NULL REFERENCES devices(mac),
  ip             TEXT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  last_seen_at   INTEGER NOT NULL,
  duration_ms    INTEGER,
  start_source   TEXT NOT NULL DEFAULT 'poll',
  end_source     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_mac_started ON sessions(mac, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_started     ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_ended       ON sessions(ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_open        ON sessions(ended_at) WHERE ended_at IS NULL;

-- 键值设置
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
