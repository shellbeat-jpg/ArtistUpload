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

const artistRoutes = require('./routes/artist');
const adminRoutes = require('./routes/admin');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'bitte-in-.env-aendern',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 Tage
        // In Produktion hinter HTTPS-Reverse-Proxy auf true setzen (siehe README):
        secure: process.env.NODE_ENV === 'production',
    },
}));

const { i18next, middleware } = require('./lib/i18n');
app.use(middleware.handle(i18next));
app.use((req, res, next) => {
   res.locals.t = req.t;
   res.locals.lng = req.language;
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
