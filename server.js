//  (Subdomain-Middleware)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');

const dbPath = path.join(__dirname, 'db', 'artist-upload.sqlite3');
if (!fs.existsSync(dbPath)) {
    console.error('Datenbank nicht gefunden. Bitte zuerst ausfuehren: npm run init-db');
    process.exit(1);
}

// Wir nutzen die bestehende DB-Instanz, um Datei-Sperren zu vermeiden
const Database = require('better-sqlite3');
const db = new Database(dbPath);

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const artistRoutes = require('./routes/artist');
const adminRoutes = require('./routes/admin');

app.use(session({
    secret: process.env.SESSION_SECRET || 'bitte-in-.env-aendern',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 Tage
        secure: process.env.NODE_ENV === 'production',
    },
}));

const { i18next, middleware } = require('./lib/i18n');
app.use(middleware.handle(i18next));

// ====================================================================
// --- REPARIERTE & UNZERSTÖRBARE MANDANTEN-MIDDLEWARE ---
//     Der Hostname wird dynamisch gesplittet und analysiert, um den passenden Sender zu isolieren:
// ====================================================================
app.use((req, res, next) => {
    // 1. i18n Sprach-Variablen global einspeisen
    res.locals.t = req.t;
    res.locals.lng = req.language;

    const host = req.headers.host || ''; // z.B. "bass.luziferase.de", "artists-basspistol.luziferase.de" oder "artists.luziferase.de"
    
    // Fallback-Standardwerte definieren
    req.currentStation = null;
    res.locals.currentStation = null;

    // 2. Prüfen, ob wir uns auf einer Subdomain befinden (Wir ignorieren die nackte Hauptdomain)
    if (host !== 'artists.luziferase.de' && host.includes('.luziferase.de')) {
        
        // REPARIERT: Holt den exakten ersten Teil der Subdomain (z.B. "bass" aus "bass.luziferase.de")
        let subdomain = host.split('.')[0].toLowerCase();
        
        // Falls der Hoster "artists-bass" liefert, schneiden wir es sauber ab
        if (subdomain.startsWith('artists-')) {
            subdomain = subdomain.replace('artists-', '');
        }
        
        // Schneidet das alte "artists-" Präfix ab, falls es im Hostname enthalten ist
        if (subdomain.startsWith('artists-')) {
            subdomain = subdomain.replace('artists-', '');
        }

        console.log(`[Mandant] Subdomain erkannt: "${subdomain}" für Host: ${host}`);

        try {
            // Sucht den passenden Sender in der SQLite-Datenbank
            const station = db.prepare('SELECT * FROM stations WHERE url_stub = ?').get(subdomain);
            
            if (station) {
                req.currentStation = station;
                res.locals.currentStation = station; // Macht die Stationsdaten in JEDEM EJS-Template verfügbar!
                process.env.SITE_URL = `https://${host}`;
            } else {
                console.log(`[Mandant-Warnung] Kein Datenbank-Eintrag für url_stub: "${subdomain}"`);
                // Falls du als Admin eingeloggt bist, blockieren wir dich nicht mit einem 404
                if (!req.path.startsWith('/admin')) {
                    return res.status(404).send("Dieses Sender-Portal existiert nicht im System.");
                }
            }
        } catch (dbErr) {
            console.error("Fehler bei Mandanten-Datenbankabfrage:", dbErr.message);
        }
    } else {
        console.log(`[Mandant] Hauptdomain oder globaler Zugriff: ${host}`);
    }

    next();
});
// ====================================================================

app.get('/', (req, res) => res.redirect('/login'));

app.use('/', artistRoutes);
app.use('/', adminRoutes);

app.use((req, res) => {
    res.status(404).send('Seite nicht gefunden.');
});

const port = process.env.PORT || 3500;
app.listen(port, '127.0.0.1', () => {
    console.log(`Artist-Upload-Portal laeuft auf http://127.0.0.1:${port}`);
});