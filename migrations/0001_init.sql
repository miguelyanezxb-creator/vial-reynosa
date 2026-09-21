PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
  text TEXT NOT NULL DEFAULT '', confirmations INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', device_id TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_status_time ON incidents(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_category ON incidents(category);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, text TEXT NOT NULL, device_id TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
  FOREIGN KEY(incident_id) REFERENCES incidents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_incident ON comments(incident_id, created_at);
CREATE TABLE IF NOT EXISTS votes (
  incident_id TEXT NOT NULL, device_id TEXT NOT NULL, vote TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(incident_id, device_id)
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  ttl_minutes INTEGER NOT NULL DEFAULT 180
);
INSERT OR IGNORE INTO categories(id,name,icon,ttl_minutes) VALUES
('checkpoint','Tránsito / retén vial','👮',90),('acc','Accidente','🚗',180),('light','Semáforo averiado','🚦',480),
('traffic','Tráfico intenso','🚙',60),('flood','Inundación','🌊',360),('close','Calle cerrada / obra','🚧',480),
('pothole','Bache / obstáculo','🕳️',10080),('risk','Otro riesgo vial','⚠️',180);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ads (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, link TEXT, active INTEGER NOT NULL DEFAULT 1, starts_at INTEGER, ends_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blocked_devices (device_id TEXT PRIMARY KEY, reason TEXT, created_at INTEGER NOT NULL);
