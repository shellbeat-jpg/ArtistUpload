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
const publicRoutes = require('./routes/public');


 

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
    // 0. CORS
    const origin = req.headers.origin || '';
    const isAllowed =
        /^https:\/\/azuracast\.luziferase\.de$/i.test(origin) ||
        /^https:\/\/stream\.luziferase\.de$/i.test(origin) ||
        /^https:\/\/([a-z0-9-]+)\.luziferase\.de$/i.test(origin);

    if (isAllowed) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    // 1. i18n
    res.locals.t = req.t;
    res.locals.lng = req.language;

    const host = (req.headers.host || '').split(':')[0].toLowerCase();

    req.currentStation = null;
    res.locals.currentStation = null;

    // 2. Subdomain-Mandant
    if (
        host !== 'artists.luziferase.de' &&
        host !== 'azuracast.luziferase.de' &&
        host.includes('.luziferase.de')
    ) {
        let subdomain = host.split('.')[0].toLowerCase();

        if (subdomain.startsWith('artists-')) {
            subdomain = subdomain.slice('artists-'.length);
        }

        console.log(`[Mandant] Subdomain erkannt: "${subdomain}" für Host: ${host}`);

        try {
            const station = db.prepare('SELECT * FROM stations WHERE url_stub = ?').get(subdomain);

            if (station) {
                req.currentStation = station;
                res.locals.currentStation = station;
                process.env.SITE_URL = `https://${host}`;
            } else {
                console.log(`[Mandant-Warnung] Kein Datenbank-Eintrag für url_stub: "${subdomain}"`);
                if (!req.path.startsWith('/admin') && !req.path.startsWith('/public/station-message')) {
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



//app.use('/', artistRoutes);
//app.use('/', adminRoutes);

app.use(publicRoutes);
app.use('/artist', artistRoutes); 
app.use('/', adminRoutes);

app.get('/', (req, res) => res.redirect('/artist/login'));

app.use((req, res) => {
    console.log(`[404-Block] Nicht abgefangene URL blockiert: ${req.method} ${req.path}`);
    res.status(404).send('Seite nicht gefunden.');
});   

const port = process.env.PORT || 3500;
app.listen(port, '127.0.0.1', () => {
    console.log(`Artist-Upload-Portal laeuft auf http://127.0.0.1:${port}`);
});