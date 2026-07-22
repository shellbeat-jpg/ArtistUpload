-- Migration: Streaming-/Social-Links pro Artist (max. 3, in der Anwendung
-- durchgesetzt, nicht per DB-Constraint). Ein Artist kann bis zu drei Links
-- aus der festen Plattform-Liste hinterlegen (siehe lib/azuracast.js:
-- ALL_LINK_PLATFORMS fuer die gueltigen Werte von "platform").
--
-- Ausfuehren mit:
--   sqlite3 /opt/artist-upload/db/artist-upload.sqlite3 < migrations/xxxx_artist_links.sql
-- (Pfad zur .sqlite3-Datei ggf. an eure tatsaechliche Konfiguration anpassen)

CREATE TABLE IF NOT EXISTS artist_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    url TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artist_links_artist_id ON artist_links(artist_id);
