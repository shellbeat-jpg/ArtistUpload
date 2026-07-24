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

// --- DYNAMISCHE MANDANTEN- & i18n-MIDDLEWARE ---
app.use((req, res, next) => {
    res.locals.t = req.t;
    res.locals.lng = req.language;

    // 1. Globale Admin-Routen überspringen die Mandanten-Prüfung
    if (req.path.startsWith('/admin')) {
        return next();
    }

    // 2. Ermittelt den URL-Stub aus dem Hostname (z.B. artists-basspistol.luziferase.de -> basspistol)
    const host = req.headers.host || '';
    const match = host.match(/^artists-([^.]+)\.luziferase\.de/i);
    
    // Fallback für den Direktaufruf (z.B. während der Einrichtung)
    if (!match) {
        req.currentStation = { id: 1, name: 'Luziferase Portal', url_stub: 'default' };
        res.locals.currentStation = req.currentStation;
        return next();
    }
    
    // Korrekt aus der ersten Regex-Gruppe auslesen und in Kleinbuchstaben umwandeln
    const stationStub = match[1].toLowerCase();

    // 3. Station aus der DB abfragen
    try {
        const station = db.prepare('SELECT * FROM stations WHERE url_stub = ?').get(stationStub);
        
        if (!station) {
            return res.status(404).send("Dieses Sender-Portal existiert nicht im System.");
        }

        // 4. Daten an Request und Templates übergeben
        req.currentStation = station;
        res.locals.currentStation = station;
        process.env.SITE_URL = `https://${host}`;
    } catch (dbErr) {
        console.error("Fehler bei der Stationsabfrage in server.js:", dbErr.message);
        // Sicherer Fallback bei DB-Konflikten
        req.currentStation = { id: 1, name: 'Luziferase Portal', url_stub: 'default' };
        res.locals.currentStation = req.currentStation;
    }

    next();
});

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
