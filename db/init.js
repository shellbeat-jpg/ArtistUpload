// Legt die SQLite-Datenbank inkl. Schema an und erstellt den ersten Admin-Account.
// Aufruf: npm run init-db  (nur einmalig beim ersten Setup noetig)

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./connection');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                    -- Artist Name
    email TEXT UNIQUE NOT NULL,            -- Login-E-Mail
    password_hash TEXT NOT NULL,
    bio TEXT DEFAULT '',                   -- Freitext-Bio (optional)
    artist_page_url TEXT DEFAULT '',       -- URL Artist Page
    contact_email TEXT DEFAULT '',         -- Kontakt-E-Mail fuer interne Kommunikation
    contact_phone TEXT DEFAULT '',         -- Kontakt-Telefon (optional)
    quota_mb INTEGER NOT NULL DEFAULT 500,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,                   -- Track Name
    genre TEXT DEFAULT '',
    bio_lyrics TEXT DEFAULT '',            -- Freitext fuer Bio oder Lyrics (optional)
    bpm INTEGER,                           -- optional
    track_page_url TEXT DEFAULT '',
    video_url TEXT DEFAULT '',             -- optional
    image_filename TEXT,                   -- Track Image (Dateiname unter public/track-images)
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    filesize_mb REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'eingereicht', -- eingereicht | freigegeben | abgelehnt
    azuracast_media_id TEXT,
    reject_reason TEXT,
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Ersten Admin-Account anlegen, falls noch keiner existiert
const existing = db.prepare('SELECT COUNT(*) AS c FROM admins').get();
if (existing.c === 0) {
    const email = process.env.ADMIN_EMAIL || '[email protected]';
    const password = process.env.ADMIN_PASSWORD || 'changeme';
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(email, hash);
    console.log(`Admin-Account angelegt: ${email}`);
    console.log('Bitte Passwort nach dem ersten Login aendern (ueber die Datenbank oder ein spaeteres Profil-Feature).');
} else {
    console.log('Admin-Account existiert bereits, ueberspringe Anlage.');
}

console.log('Datenbank-Setup abgeschlossen.');
