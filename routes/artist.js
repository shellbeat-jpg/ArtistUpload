const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db/connection');
const { requireArtist } = require('../lib/auth');
const { upload, validateImageSize } = require('../lib/upload');
const azuracast = require('../lib/azuracast');
const { detectBpm } = require('../lib/bpm');
const {
    ALL_LINK_PLATFORMS,
    getArtistLinksMap,
    getArtistLinksForForm,
    parseArtistLinksFromBody,
    saveArtistLinks,
} = require('../lib/artist-links');

const router = express.Router();

const audioMetadataParser  = require('music-metadata');
 
require('dotenv').config();

// Ermittelt die Basis-Konfiguration
// const baseMediaDir = process.env.AZURACAST_MEDIA_BASE_PATH || path.join(__dirname, '..', 'uploads');
// Ermittelt das globale Docker-Mutterverzeichnis aus der .env
//const globalDockerDir = process.env.AZURACAST_MEDIA_BASE_PATH || path.join(__dirname, '..', 'uploads');
const globalDockerDir = process.env.AZURACAST_MEDIA_BASE_PATH || '/var/lib/docker/volumes/azuracast_station_data/_data';

// Baut den Pfad vollautomatisch stationsspezifisch zusammen!
// Ergebnis für Basspistol: /.../_data/luziferase/media
// Ergebnis für Bass:       /.../_data/bass/media

 
// Middleware: Weiterleitung falls bereits eine aktive Session existiert
function redirectIfLoggedIn(req, res, next) {
    if (req.session && req.session.artistId) {
        return res.redirect('/artist/dashboard');
    }
    next();
}

// Globale Middleware: Stellt lng und req automatisch in JEDEM EJS-Template bereit
router.use((req, res, next) => {
    res.locals.lng = req.language || 'de'; // i18next Sprache bereitstellen
    res.locals.req = req;                  // req-Objekt bereitstellen
    next();
});

// --- Login / Logout ---
router.get('/login', redirectIfLoggedIn, (req, res) => {
    // Falls Meldungen über Redirects reinkommen (z.B. nach erfolgreicher Registrierung)
    const errorMessage = req.query.err ? req.query.err : null;
    
    // Flash-Message aus der Session holen und direkt löschen
    const successMessage = req.session.flashMessage || null;
    if (req.session.flashMessage) {
        delete req.session.flashMessage;
    }
    
    res.render('artist/login', { 
        error: errorMessage, 
        successMessage: successMessage//, 
        // lng: req.language, // Wichtig für <html lang="<%= lng %>">
        // req: req 
    });
});

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    
    // Prüft, ob der Artist existiert
    const artist = db.prepare('SELECT * FROM artists WHERE email = ? AND station_id = ?').get(email, req.currentStation.id);
 
    if (!artist || !bcrypt.compareSync(password, artist.password_hash)) {
        return res.render('artist/login', { error: req.t('login.invalidCredentials'), successMessage: null });
    }

    // WICHTIG: Prüft, ob der Account über die E-Mail-Bestätigung aktiviert wurde
    if (artist.active !== 1) {
        return res.render('artist/login', { error: req.t('login.accountNotActiveYet'), successMessage: null });
    }

    req.session.artistId = artist.id;
    res.redirect('/artist/dashboard');
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/artist/login'));
});


// --- NEU: Registrierung (Self-Signup) ---  
const nodemailer = require('nodemailer');



// Werte strikt von eventuellen Leerzeichen oder unsichtbaren Zeichen befreien
const cleanSmtpHost = (process.env.SMTP_HOST || '://brevo.com').trim();
const cleanSmtpUser = (process.env.SMTP_USER || '').trim();
const cleanSmtpPass = (process.env.SMTP_PASS || '').trim();

// SMTP-Transporter für die Verifikations-Mails initialisieren
const transporter = nodemailer.createTransport({
    host: cleanSmtpHost,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465', // false für Port 587 (STARTTLS)
    auth: {
        user: cleanSmtpUser,
        pass: cleanSmtpPass
    }
});

 
// GET: Registrierungsseite anzeigen
router.get('/register', redirectIfLoggedIn, (req, res) => {
    res.render('artist/register', { 
        turnstileSiteKey: process.env.TURNSTILE_SITE_KEY,
        linkPlatforms: ALL_LINK_PLATFORMS, 
        error: null,
        formData: {} 
    });
});

// POST: Registrierungsdaten verarbeiten
router.post('/register', async (req, res) => {
    const { 
        artist_name, 
        email, 
        contact_phone, 
        artist_page_url, 
        bio, 
        password, 
        password_confirm, 
        'cf-turnstile-response': turnstileResponse 
    } = req.body;

    // Hilfsfunktion: Übergibt req.body ALS formData an das Template
    const renderError = (errorKey) => {
        return res.render('artist/register', { 
            turnstileSiteKey: process.env.TURNSTILE_SITE_KEY, 
            linkPlatforms: ALL_LINK_PLATFORMS,
            error: errorKey.includes('.') ? req.t(errorKey) : errorKey,
            formData: req.body // Hier fließen die Eingaben zurück ans Template!
        });
    };

    // 1. Cloudflare Turnstile Captcha serverseitig verifizieren
    try {
        const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        const verifyParams = new URLSearchParams();
        verifyParams.append('secret', process.env.TURNSTILE_SECRET_KEY.trim());
        verifyParams.append('response', (turnstileResponse || '').trim());

        const verifyResponse = await fetch(verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: verifyParams
        });
        
        const outcome = await verifyResponse.json();
        
        if (!outcome.success) {
            console.error("Turnstile verweigerte Freigabe. Fehlercodes:", outcome['error-codes']);
            // REPARIERT: Nutzt jetzt die Hilfsfunktion
            return renderError('register.errorCaptcha');
        }
    } catch (err) {
        console.error("Netzwerkfehler beim Cloudflare-Siteverify:", err.message);
        // REPARIERT: Nutzt jetzt die Hilfsfunktion
        return renderError("Captcha Connection Error");
    }

    // 2. Passwort-Validierung
    if (password !== password_confirm) {
        // REPARIERT: Nutzt jetzt die Hilfsfunktion
        return renderError('register.errorPasswordMatch');
    }

    // 3. E-Mail-Duplikatsprüfung
    const existingArtist = db.prepare('SELECT id FROM artists WHERE email = ? AND station_id = ?').get(email, req.currentStation.id);

    if (existingArtist) {
        // REPARIERT: Nutzt jetzt die Hilfsfunktion
        return renderError('register.errorEmailExists');
    }

    // 4. Social-Media Links auslesen
    let links;
    try {
        links = parseArtistLinksFromBody(req, req.body);
    } catch (e) {
        // REPARIERT: Nutzt jetzt die Hilfsfunktion
        return renderError(e.message);
    }

    // 5. Passwort hashen & Token generieren
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    
    // Standard-Quota festlegen (z.B. 500 MB)
    const defaultQuotaMb = 500; 

    try {
        // Daten in die Tabelle einfügen (active = 0)
        const info = db.prepare(`
            INSERT INTO artists (name, email, contact_phone, artist_page_url, bio, password_hash, active, quota_mb, verification_token, station_id)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `).run(
            (artist_name || '').trim(),
            email.trim(),
            (contact_phone || '').trim(),
            (artist_page_url || '').trim(),
            (bio || '').trim(),
            passwordHash,
            defaultQuotaMb,
            verificationToken,
            req.currentStation.id
        );

        // 6. Die neue Artist-ID abgreifen und Social-Media Links verknüpfen
        const newArtistId = info.lastInsertRowid;
        saveArtistLinks(newArtistId, links);

        // 7. Aktivierungs-E-Mail absenden
        const verificationLink = `${process.env.SITE_URL}/artist/verify/${verificationToken}`;
        const stationName = req.currentStation.name;
        const mailOptions = {
            // from: process.env.SMTP_FROM,
            from: req.currentStation.email_from || 'post@luziferase.de',
            to: email,
            subject: `[${stationName}] ${req.t('email.subjectVerify', { defaultValue: 'Aktivierung deines Accounts' })}`,
            text: `${req.t('email.textVerify')}\n\n${verificationLink}`
        };   

        transporter.sendMail(mailOptions, (mailErr) => {
            if (mailErr) {
                console.error("Registrierungs-Mail fehlgeschlagen:", mailErr.message);
            }    
            req.session.flashMessage = req.t('register.successMailSent');
            res.redirect('/login');
        });

    } catch (dbError) {
        console.error("DB-Insert Error during registration:", dbError.message);
        return res.render('artist/register', { 
            turnstileSiteKey: process.env.TURNSTILE_SITE_KEY, 
            linkPlatforms: ALL_LINK_PLATFORMS,
            error: "Database Error"//,
            // lng: req.language
        });
    }
});
 

// GET: Bestätigungs-Link validieren
router.get('/verify/:token', (req, res) => {
    const { token } = req.params;

    // Suchen nach dem Artist mit diesem Token
    const artist = db.prepare('SELECT id FROM artists WHERE verification_token = ?').get(token);

    if (!artist) {
        return res.redirect(`/login?err=${encodeURIComponent(req.t('register.errorInvalidToken'))}`);
    }

    // Account aktivieren (active = 1) und Token entfernen
    db.prepare('UPDATE artists SET active = 1, verification_token = NULL WHERE id = ?').run(artist.id);
   
    req.session.flashMessage = req.t('register.successAccountActivated') || 'Dein Account wurde erfolgreich aktiviert. Du kannst dich jetzt einloggen.';

    res.redirect(`/login`);
});


// --- Dashboard ---

router.get('/dashboard', requireArtist, (req, res) => {
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.session.artistId);
    const tracks = db.prepare('SELECT * FROM tracks WHERE artist_id = ? ORDER BY uploaded_at DESC').all(artist.id);

    const usedMb = tracks.reduce((sum, t) => sum + t.filesize_mb, 0);

    // Sekunden in Minuten umrechnen für das Dashboard
    const totalUsedSeconds = db
        .prepare('SELECT COALESCE(SUM(duration_seconds), 0) AS used FROM tracks WHERE artist_id = ?')
        .get(req.session.artistId).used;

    const usedMinutes = totalUsedSeconds / 60;
    const maxMinutes = artist.quota_minutes || 60;
    const percentage = Math.min(100, (usedMinutes / maxMinutes) * 100);
 
    res.render('artist/dashboard', {
        artist,
        tracks,
        // NEU: Diese Werte gehen direkt ans EJS-Template für die visuelle Anzeige
        quota: {
            used: usedMinutes.toFixed(1),
            max: maxMinutes,
            percent: percentage.toFixed(0)
        },
        usedMb: usedMb.toFixed(1),
        quotaMb: artist.quota_mb,
        percentUsed: Math.min(100, Math.round((usedMb / artist.quota_mb) * 100)),
        artistLinkSlots: getArtistLinksForForm(artist.id),
        linkPlatforms: ALL_LINK_PLATFORMS,
        message: req.query.msg || null,
        error: req.query.err || null,
    });
});

// --- Eigenes Profil aktualisieren (Artist Name, Artist Page URL, Kontakt, Bio) ---

router.post('/profile', requireArtist, async (req, res) => {
    const { name, artist_page_url, email, contact_phone, bio } = req.body;

    if (!name || !name.trim()) {
        return res.redirect(`/artist/dashboard?err=${encodeURIComponent(req.t('messages.profileNameRequired'))}`);
    }
    if (!artist_page_url || !artist_page_url.trim()) {
        return res.redirect(`/artist/dashboard?err=${encodeURIComponent(req.t('messages.profileUrlRequired'))}`);
    }
    if (!contact_phone && !email) {
        return res.redirect(`/artist/dashboard?err=${encodeURIComponent(req.t('messages.profileContactRequired'))}`);
    }
    
    // WICHTIG: Prüfen, ob die neue E-Mail bereits von einem ANDEREN Artist genutzt wird
    const emailConflict = db.prepare('SELECT id FROM artists WHERE email = ? AND id != ?').get(email.trim(), req.session.artistId);
    if (emailConflict) {
        return res.redirect(`/artist/dashboard?err=${encodeURIComponent(req.t('register.errorEmailExists'))}`);
    }
    
    let links;
    try {
        links = parseArtistLinksFromBody(req, req.body);
    } catch (e) {
        return res.redirect(`/artist/dashboard?err=${encodeURIComponent(e.message)}`);
    }

    db.prepare(`
        UPDATE artists
        SET name = ?, artist_page_url = ?, email = ?, contact_phone = ?, bio = ?
        WHERE id = ?
    `).run(
        name.trim(),
        artist_page_url.trim(),
        (email || '').trim(),
        (contact_phone || '').trim(),
        (bio || '').trim(),
        req.session.artistId
    );

    saveArtistLinks(req.session.artistId, links);

    // Name und Artist-Page-URL fliessen in die Metadaten (Standardfeld "artist" bzw.
    // Custom Field url_artist) jedes bereits mit AzuraCast synchronisierten Tracks
    // dieses Artists ein -- diese direkt nachziehen. Die Streaming-/Social-Links
    // ebenso, da sie als Custom Fields am Track (nicht am Artist) haengen.
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.session.artistId);
    const artistLinksMap = getArtistLinksMap(artist.id);
    const syncedTracks = db
        .prepare('SELECT * FROM tracks WHERE artist_id = ? AND azuracast_media_id IS NOT NULL')
        .all(artist.id);

    let syncFailed = false;
    for (const track of syncedTracks) {
        try {
            await azuracast.setMetadata(track.azuracast_media_id, {
                title: track.title,
                artist: artist.name,
                genre: track.genre,
                lyrics: track.bio_lyrics,
                bpm: track.bpm,
                url_track: track.track_page_url,
                url_artist: artist.artist_page_url,
                links: artistLinksMap,
            });
        } catch (e) {
            console.error(`AzuraCast-Sync fuer Track ${track.id} (Profil-Update) fehlgeschlagen:`, e.message);
            syncFailed = true;
        }
    }

    const msg = syncFailed
        ? req.t('messages.profileUpdatedSyncFailed')
        : req.t('messages.profileUpdated');
    res.redirect(`/artist/dashboard?msg=${encodeURIComponent(msg)}`);
});

/*
// GET: Audio-Stream im Artist-Bereich (Korrigiert für das /new- & Playlist-System)
//router.get('/tracks/:id/stream/:filename', requireArtist, (req, res) => {
router.get('/tracks/:id/stream/:filename', (req, res) => {
    // Holt den Track anhand ID und Künstler-Sitzung
    //const track = db.prepare('SELECT * FROM tracks WHERE id = ? AND artist_id = ?')
    //                .get(req.params.id, req.session.artistId);
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);

    if (!track) return res.status(404).send('Track nicht gefunden.');

    // 1. DYNAMISCHE SENDER-ISOLATION
    const globalDockerDir = process.env.AZURACAST_MEDIA_BASE_PATH || '/var/lib/docker/volumes/azuracast_station_data/_data';
    
    // Ermittelt den physikalischen Ordner direkt über die Track-Zuweisung aus der DB
    const stationDb = db.prepare('SELECT azuracast_station_id FROM stations WHERE id = ?').get(track.station_id);
    const stationFolder = stationDb ? stationDb.azuracast_station_id : 'luziferase';
    
    const baseMediaDir = path.join(globalDockerDir, stationFolder, 'media');
    
    // 2. ABSOLUTER DATEIPFAD-CHECK
    // Da track.filepath flexibel "new/hash.wav" oder "incoming/hash.wav" enthält,
    // findet diese Zeile die Datei in jeder Lebensphase des Tracks!
    const absoluteFilePath = path.join(baseMediaDir, track.filepath);

    console.log(`[Stream-Debug] Sende Datei: ${absoluteFilePath}`);

    if (!fs.existsSync(absoluteFilePath)) {
        console.error(`[Stream-Fehler] Datei physikalisch nicht gefunden: ${absoluteFilePath}`);
        return res.status(404).send('Audiodatei auf dem Server nicht gefunden.');
    }

    res.sendFile(absoluteFilePath);
});
*/
router.get('/tracks/:id/stream/:filename', (req, res) => { 
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);

    if (!track) return res.status(404).send('Track nicht gefunden.');

    const globalDockerDir = process.env.AZURACAST_MEDIA_BASE_PATH || '/var/lib/docker/volumes/azuracast_station_data/_data';
    const stationDb = db.prepare('SELECT azuracast_station_id FROM stations WHERE id = ?').get(track.station_id);
    const stationFolder = stationDb ? stationDb.azuracast_station_id : 'luziferase';
    const baseMediaDir = path.join(globalDockerDir, stationFolder, 'media');

    const possibleFolders = ['mapped-to-playlist', 'incoming', 'new'];
    let absoluteFilePath = null;

    for (const folder of possibleFolders) {
        const testPath = path.join(baseMediaDir, folder, req.params.filename);
        if (fs.existsSync(testPath)) {
            absoluteFilePath = testPath;
            break;
        }
    }

    if (!absoluteFilePath) {
        absoluteFilePath = path.join(baseMediaDir, track.filepath);
    }

    if (!fs.existsSync(absoluteFilePath)) {
        console.error(`[Stream-Fehler] Datei auf Festplatte unauffindbar: ${absoluteFilePath}`);
        return res.status(404).send('Audiodatei auf dem Server nicht gefunden.');
    }

    res.sendFile(absoluteFilePath);
});
 

/*
router.get('/tracks/:id/stream/:filename', requireArtist, (req, res) => {
    const track = db.prepare('SELECT * FROM tracks WHERE id = ? AND artist_id = ?')
                    .get(req.params.id, req.session.artistId);

    if (!track) return res.status(404).send('Track nicht gefunden.');

    // Nutzt den zentralen Basispfad aus der .env (z.B. /var/lib/.../media)
    // const baseMediaDir = process.env.AZURACAST_MEDIA_BASE_PATH || path.join(__dirname, '..', 'uploads');
    const baseMediaDir = req.currentStation 
        ? path.join(globalDockerDir, req.currentStation.azuracast_station_id, 'media')
        : globalDockerDir;
        
    // REPARIERT: Da track.filepath in der DB nun z.B. 'new/abc.wav' oder 'mapped-to-playlist/abc.wav' 
    // speichert, baut path.join daraus automatisch den perfekten absoluten Pfad!
    const absoluteFilePath = path.join(baseMediaDir, track.filepath);

    if (!fs.existsSync(absoluteFilePath)) {
        console.error(`[Streaming-Fehler] Datei nicht gefunden unter: ${absoluteFilePath}`);
        return res.status(404).send('Audiodatei auf dem Server nicht gefunden.');
    }

    res.sendFile(absoluteFilePath);
});
*/

// --- Gemeinsame Validierung der Track-Zusatzfelder ---

function validateTrackFields(req, body) {
    const errors = [];
    if (!body.title || !body.title.trim()) errors.push(req.t('messages.trackTitleRequired'));
    // if (!body.genre || !body.genre.trim()) errors.push(req.t('messages.trackGenreRequired'));
    // if (!body.track_page_url || !body.track_page_url.trim()) errors.push(req.t('messages.trackPageUrlRequired'));
    if (body.bpm && (isNaN(parseInt(body.bpm, 10)) || parseInt(body.bpm, 10) <= 0)) {
        errors.push(req.t('messages.bpmPositive'));
    }
    return errors;
}

// --- BPM-Erkennung fuer eine gerade ausgewaehlte, noch nicht endgueltig
// hochgeladene Audiodatei (siehe views/artist/dashboard.ejs) ---
// Datei landet nur temporaer in os.tmpdir() und wird nach der Analyse sofort
// wieder geloescht -- das ist kein persistenter Upload.

const analyzeUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, os.tmpdir()),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `bpm-analyze-${crypto.randomBytes(8).toString('hex')}${ext}`);
        },
    }),
    limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 300) * 1024 * 1024 },
});

router.post('/tracks/analyze-bpm', requireArtist, (req, res) => {
    analyzeUpload.single('track')(req, res, async (err) => {
        if (err || !req.file) {
            return res.status(400).json({ bpm: null, error: req.t('messages.invalidAudioFile') });
        }

        try {
            const bpm = await detectBpm(req.file.path);
            res.json({ bpm });
        } finally {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        }
    });
});

// --- Neuer Upload ---

router.post('/tracks/upload', requireArtist, (req, res) => {
    upload.fields([{ name: 'track', maxCount: 1 }, { name: 'image', maxCount: 1 }])(req, res, async (err) => {
    
        if (err) {
            return res.redirect(`/artist/dashboard?err=${encodeURIComponent(err.message)}`);
        }

        const trackFile = req.files?.track?.[0];
        const imageFile = req.files?.image?.[0];

        const cleanup = () => {
            if (trackFile && fs.existsSync(trackFile.path)) fs.unlinkSync(trackFile.path);
            if (imageFile && fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
        };

        if (!trackFile) {
            cleanup();
            return res.redirect(`/artist/dashboard?err=${encodeURIComponent(req.t('messages.noAudioFile'))}`);
        }
        if (!imageFile) {
            cleanup();
            return res.redirect(`/artist/dashboard?err=${encodeURIComponent(req.t('messages.imageRequired'))}`);
        }

        const fieldErrors = validateTrackFields(req, req.body);
        if (fieldErrors.length > 0) {
            cleanup();
            return res.redirect(`/artist/dashboard?err=${encodeURIComponent(fieldErrors.join(' '))}`);
        }

        try {
            validateImageSize(req, imageFile);
        } catch (e) {
            cleanup();
            return res.redirect(`/artist/dashboard?err=${encodeURIComponent(e.message)}`);
        }

        const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.session.artistId);
        const fileSizeMb = trackFile.size / (1024 * 1024);
        /*
        const usedMb = db
            .prepare('SELECT COALESCE(SUM(filesize_mb), 0) AS used FROM tracks WHERE artist_id = ?')
            .get(artist.id).used;

        if (usedMb + fileSizeMb > artist.quota_mb) {
            cleanup();
            const remaining = (artist.quota_mb - usedMb).toFixed(1);
            return res.redirect(
                `/dashboard?err=${encodeURIComponent(req.t('messages.quotaExceededUpload', { remaining }))}`
            );
        }
        */
        
        // ====================================================================
        // --- NEU: STATIONS-SPEZIFISCHE AUDIO-LÄNGEN-VALIDIERUNG (10 MIN) ---
        // ====================================================================
        let durationSeconds = 0;

        try {
            // REPARIERT: Nutzt jetzt den unzerstörbaren Modulnamen
            const metadata = await audioMetadataParser.parseFile(trackFile.path);
            durationSeconds = metadata.format.duration || 0;
            console.log(`[Upload-Check] Neuer Track hat eine Länge von: ${durationSeconds.toFixed(1)} Sekunden.`);
        } catch (metaErr) {
            console.error("Fehler beim Auslesen der Audio-Laenge:", metaErr.message);
            cleanup();
            return res.redirect(`/artist/dashboard?err=${encodeURIComponent('Ungueltige oder beschaedigte Audiodatei.')}`);
        }

        // Berechne die Summe der Sekunden aller bereits existierenden Tracks dieses Artists
        const usedSeconds = db
            .prepare('SELECT COALESCE(SUM(duration_seconds), 0) AS used FROM tracks WHERE artist_id = ?')
            .get(artist.id).used;

        const maxAllowedSeconds = (artist.quota_minutes || 60) * 60; // Minuten in Sekunden umrechnen

        // Prüfen, ob das Gesamtlimit durch diesen Upload überschritten wird
        if (usedSeconds + durationSeconds > maxAllowedSeconds) {
            cleanup();
            const remainingMinutes = Math.max(0, (maxAllowedSeconds - usedSeconds) / 60).toFixed(1);
            return res.redirect(
                `/artist/dashboard?err=${encodeURIComponent(`Kontingent ueberschritten! Dir verbleiben noch ${remainingMinutes} Minuten Gesamtsendezeit.`)}`
            );
        }
        
        
        // --- REPARIERT: Holt den echten Ordnernamen der aktuell aufgerufenen Subdomain ---
        // ID 1 -> 'luziferase', ID 3 -> 'bass'
        const stationFolder = req.currentStation ? req.currentStation.azuracast_station_id : 'luziferase';
        
        // Holt die globale Docker-Basis aus der .env (endet auf /_data)
        const globalDockerDir = process.env.AZURACAST_MEDIA_BASE_PATH || '/var/lib/docker/volumes/azuracast_station_data/_data';
        
        // Bestimmt den exakten, stationsspezifischen Zielordner für neue Tracks
        const targetAudioDir = path.join(globalDockerDir, stationFolder, 'media', 'new');
        
        // Ordner automatisch anlegen, falls er für diese Station noch nicht existiert
        if (!fs.existsSync(targetAudioDir)) {
            fs.mkdirSync(targetAudioDir, { recursive: true });
            fs.chmodSync(targetAudioDir, 0o777); // Berechtigungen für Docker-Container freigeben
        }

        // Der physische Zielpfad auf der Hetzner-Festplatte
        const finalDestinationPath = path.join(targetAudioDir, trackFile.filename);

        // Verschiebt die Datei aus dem globalen Sammelordner (/_data/new/) 
        // punktgenau in den /new-Ordner der jeweiligen Station (z.B. /_data/bass/media/new/)
        if (fs.existsSync(trackFile.path)) {
            fs.renameSync(trackFile.path, finalDestinationPath);
            fs.chmodSync(finalDestinationPath, 0o666); // Datei für den Docker-Container lesbar machen
        }

        // --- DATENBANK UPDATE: Relativen Pfad passend zum neuen Ziel abspeichern ---
        // Speichert 'new/dateiname.ext' -> Deine Streaming-Route weiß später über baseMediaDir, 
        // wo sie suchen muss!
        const relativeDbPath = `new/${trackFile.filename}`;
        
        // ====================================================================
        // --- ENDE DER NEUEN PRÜFUNG (Es folgt dein INSERT INTO tracks) ---
        // ====================================================================
        
        db.prepare(`
            INSERT INTO tracks (
                artist_id, station_id, title, genre, bio_lyrics, bpm, track_page_url, video_url,
                image_filename, filename, filepath, filesize_mb, duration_seconds, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eingereicht')
        `).run(
            artist.id,
            req.currentStation.id, // 2. Parameter für die Mandantentrennung
            req.body.title.trim(),
            (req.body.genre || '').trim(),
            (req.body.bio_lyrics || '').trim(),
            req.body.bpm ? parseInt(req.body.bpm, 10) : null,
            (req.body.track_page_url || '').trim(),
            (req.body.video_url || '').trim(),
            imageFile.filename,
            trackFile.filename,
            relativeDbPath, // `new/${trackFile.filename}`,
            fileSizeMb,
            durationSeconds // 13. Parameter für das zeitbasierte Kontingent
        );

        const adminMailOptions = {
            from: req.currentStation.email_from,
            // VORHER: to: process.env.ADMIN_EMAIL,
            // NACHHER: Schickt die Mail an das Postfach des Senders, wo hochgeladen wurde!
            to: req.currentStation.email_admin || 'post@luziferase.de',
            subject: `[${req.currentStation.name}] Neuer Track eingereicht`,
            text: `Der Künstler ${artist.name} hat einen neuen Track hochgeladen...`
        };
        transporter.sendMail(adminMailOptions, (mailErr) => {
            if (mailErr) {
               // console.error("Benachrichtigung-Mail fehlgeschlagen:", mailErr.message);
            }    
            //req.session.flashMessage = req.t('register.successMailSent');
        });


        res.redirect(`/artist/dashboard?msg=${encodeURIComponent(req.t('messages.trackUploaded'))}`);
    });
});

// --- Bestehenden Track ersetzen (Audio, Bild und Angaben) ---
// Hinweis: War der Track bereits mit AzuraCast synchronisiert (azuracast_media_id
// gesetzt), werden alle Aenderungen -- Audio, Bild und Textfelder -- direkt im
// Anschluss automatisch nach AzuraCast uebertragen. Der Status wird trotzdem auf
// "eingereicht" zurueckgesetzt, damit der Admin die Aenderung im Ueberblick sieht.

router.post('/tracks/:id/replace', requireArtist, (req, res) => {
    // Dynamische Pfaderststellung innerhalb der Route sichern
    const baseMediaDir = req.currentStation 
        ? path.join(globalDockerDir, req.currentStation.azuracast_station_id, 'media')
        : globalDockerDir;

    upload.fields([{ name: 'track', maxCount: 1 }, { name: 'image', maxCount: 1 }])(req, res, async (err) => {
        if (err) {
            return res.redirect(`/artist/dashboard?err=${encodeURIComponent(err.message)}`);
        }

        const track = db
            .prepare('SELECT * FROM tracks WHERE id = ? AND artist_id = ?')
            .get(req.params.id, req.session.artistId);

        const trackFile = req.files?.track?.[0];
        const imageFile = req.files?.image?.[0];

        const cleanupNew = () => {
            if (trackFile && fs.existsSync(trackFile.path)) fs.unlinkSync(trackFile.path);
            if (imageFile && fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
        };

        if (!track) {
            cleanupNew();
            return res.redirect(`/artist/dashboard?err=${encodeURIComponent(req.t('messages.trackNotFound'))}`);
        }

        const fieldErrors = validateTrackFields(req, req.body);
        if (fieldErrors.length > 0) {
            cleanupNew();
            return res.redirect(`/artist/dashboard?err=${encodeURIComponent(fieldErrors.join(' '))}`);
        }

        if (imageFile) {
            try {
                validateImageSize(req, imageFile);
            } catch (e) {
                cleanupNew();
                return res.redirect(`/artist/dashboard?err=${encodeURIComponent(e.message)}`);
            }
        }

        const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.session.artistId);

        let newFilename = track.filename;
        let newFilepath = track.filepath;
        let newFilesizeMb = track.filesize_mb;
        let durationSeconds = track.duration_seconds || 0; 
        
        if (trackFile) {
            let newDurationSeconds = 0;
            try {
                const metadata = await audioMetadataParser.parseFile(trackFile.path);
                newDurationSeconds = metadata.format.duration || 0;
            } catch (e) {
                cleanupNew();
                return res.redirect(`/artist/dashboard?err=${encodeURIComponent('Ungueltige Audiodatei beim Ersetzen.')}`);
            }

            // Summe aller ANDEREN Tracks berechnen (ohne den aktuell bearbeiteten Track)
            const usedSecondsWithoutThis = db
                .prepare('SELECT COALESCE(SUM(duration_seconds), 0) AS used FROM tracks WHERE artist_id = ? AND id != ?')
                .get(artist.id, track.id).used;

            const maxAllowedSeconds = (artist.quota_minutes || 60) * 60;

            if (usedSecondsWithoutThis + newDurationSeconds > maxAllowedSeconds) {
                cleanupNew();
                const remainingMinutes = Math.max(0, (maxAllowedSeconds - usedSecondsWithoutThis) / 60).toFixed(1);
                return res.redirect(
                    `/artist/dashboard?err=${encodeURIComponent(`Ersetzen fehlgeschlagen! Restzeit: ${remainingMinutes} Min.`)}`
                );
            }

            // --- A. ALTE DATEI STATIONSSPEZIFISCH LÖSCHEN ---
            const oldLocalPath = path.join(baseMediaDir, track.filepath);
            if (fs.existsSync(oldLocalPath)) {
                fs.unlinkSync(oldLocalPath);
            }

            // --- B. NEUE DATEI IN SENDER-NEW-ORDNER VERSCHIEBEN ---
            const targetNewDir = path.join(baseMediaDir, 'new');
            if (!fs.existsSync(targetNewDir)) {
                fs.mkdirSync(targetNewDir, { recursive: true });
                fs.chmodSync(targetNewDir, 0o777); // Rechte für Docker freigeben
            }

            const finalDestinationPath = path.join(targetNewDir, trackFile.filename);
            if (fs.existsSync(trackFile.path)) {
                fs.renameSync(trackFile.path, finalDestinationPath);
                fs.chmodSync(finalDestinationPath, 0o666); // Datei für Docker lesbar machen
            }

            newFilename = trackFile.filename;
            newFilepath = `new/${trackFile.filename}`;
            newFilesizeMb = trackFile.size / (1024 * 1024);
            durationSeconds = newDurationSeconds;  
        }

        let newImageFilename = track.image_filename;
        if (imageFile) {
            if (track.image_filename) {
                const oldImagePath = path.join(__dirname, '..', 'public', 'track-images', track.image_filename);
                if (fs.existsSync(oldImagePath)) fs.unlinkSync(oldImagePath);
            }
            newImageFilename = imageFile.filename;
        }

        const wasSynced = !!track.azuracast_media_id;

        db.prepare(`
            UPDATE tracks
            SET title = ?, genre = ?, bio_lyrics = ?, bpm = ?, track_page_url = ?, video_url = ?,
                image_filename = ?, filename = ?, filepath = ?, filesize_mb = ?, duration_seconds = ?,
                status = 'eingereicht', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(
            req.body.title.trim(), 
            (req.body.genre || '').trim(),
            (req.body.bio_lyrics || '').trim(),
            req.body.bpm ? parseInt(req.body.bpm, 10) : null,
            (req.body.track_page_url || '').trim(),
            (req.body.video_url || '').trim(),
            newImageFilename,
            newFilename,
            newFilepath,
            newFilesizeMb,
            durationSeconds,
            track.id
        );

        let syncNote = '';
        if (wasSynced) {
            try {
                let mediaId = track.azuracast_media_id;

                if (trackFile) {
                    // Nimmt den frisch in den neuen Stations-New-Ordner umsortierten Pfad
                    const localPath = path.join(baseMediaDir, newFilepath);
                    
                    // Korrigiert: Nutzt targetFilename ohne Pfad-Verdopplungen für AzuraCast
                    const targetFilename = `new/${trackFile.filename}`;
                    const playlistIds = (track.playlist_ids || '')
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .map(Number); 
                    const stationStub = req.currentStation ? req.currentStation.url_stub : 'default';
                    mediaId = await azuracast.replaceFile(stationStub, track.azuracast_media_id, localPath, targetFilename, playlistIds);       
                }

                // Generiert die Social-Links-Map direkt aus der DB für diese Station
                const rawLinks = db.prepare('SELECT platform, url FROM artist_links WHERE artist_id = ?').all(artist.id);
                const artistLinksMap = {};
                rawLinks.forEach(link => {
                    if (link.platform && link.url) {
                        artistLinksMap[`url_${link.platform.toLowerCase()}`] = link.url;
                    }
                });

                await azuracast.setMetadata(mediaId, {
                    title: req.body.title.trim(),
                    artist: artist.name, 
                    genre: (req.body.genre || '').trim(),
                    lyrics: (req.body.bio_lyrics || '').trim(),
                    bpm: req.body.bpm ? parseInt(req.body.bpm, 10) : null,
                    url_track: (req.body.track_page_url || '').trim(),
                    url_artist: artist.artist_page_url,
                    links: artistLinksMap,
                });

                if (imageFile) {
                    const imagePath = path.join(__dirname, '..', 'public', 'track-images', newImageFilename);
                    if (fs.existsSync(imagePath)) {
                        await azuracast.uploadArt(mediaId, imagePath);
                    }
                }

                db.prepare('UPDATE tracks SET azuracast_media_id = ? WHERE id = ?').run(String(mediaId), track.id);
            } catch (e) {
                console.error(`AzuraCast-Sync fuer Track ${track.id} (Bearbeitung) fehlgeschlagen:`, e.message);
                syncNote = " " + req.t('messages.syncFailedNote');
            }
        }

        const msg = wasSynced
            ? `${req.t('messages.trackUpdatedSynced')}${syncNote}`
            : req.t('messages.trackUpdated');
        res.redirect(`/artist/dashboard?msg=${encodeURIComponent(msg)}`);
    });
});

// --- Eigenen Track loeschen ---

router.post('/tracks/:id/delete', requireArtist, (req, res) => {
    const track = db
        .prepare('SELECT * FROM tracks WHERE id = ? AND artist_id = ?')
        .get(req.params.id, req.session.artistId);

    if (!track) {
        return res.redirect(`/artist/dashboard?err=${encodeURIComponent(req.t('messages.trackNotFound'))}`);
    }
    const baseMediaDir = req.currentStation 
        ? path.join(globalDockerDir, req.currentStation.azuracast_station_id, 'media')
        : globalDockerDir;
        
    // const localPath = path.join(__dirname, '..', 'uploads', track.filepath);
    const trackSubFolder = track.status === 'freigegeben' ? `artists/${track.artist_id}` : 'incoming';
    const localPath = path.join(baseMediaDir, trackSubFolder, track.filename);

        
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

    if (track.image_filename) {
        const imagePath = path.join(__dirname, '..', 'public', 'track-images', track.image_filename);
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    }

    // Hinweis: War der Track schon in AzuraCast (azuracast_media_id gesetzt), bleibt er
    // dort bewusst bestehen, bis ein Admin ihn aktiv entfernt (routes/admin.js).
    db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);

    res.redirect(`/artist/dashboard?msg=${encodeURIComponent(req.t('messages.trackDeleted'))}`);
});

module.exports = router;
