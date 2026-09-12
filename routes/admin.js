//  (AzuraCast API offline)
const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('../db/connection');
const { requireAdmin } = require('../lib/auth');
const azuracast = require('../lib/azuracast');
const { getArtistLinksMap } = require('../lib/artist-links');
const globalDockerDir = process.env.AZURACAST_MEDIA_BASE_PATH || '/var/lib/docker/volumes/azuracast_station_data/_data'; 
const router = express.Router();


// Hilfsfunktion: Playlists einer Station laden (normalisiert auf [{id,name}])
async function loadStationPlaylists(stationStub) {
    if (!stationStub) return [];
    try {
        const list = await azuracast.getPlaylists(stationStub);
        return (Array.isArray(list) ? list : []).map((p) => ({
            id: String(p.id),
            name: p.name || `Playlist ${p.id}`
        }));
    } catch (e) {
        console.error(`[Playlist-Load] Station "${stationStub}" fehlgeschlagen:`, e.message);
        return [];
    }
}

// --- Login / Logout ---

// Unterstützt nun direkten Link-Klick (GET) und Formular-Senden (POST)
// Vorher: router.post('/admin/logout', ...)
// Jetzt: Nutzt .all (für Links und Formulare) und korrigiert den Pfad auf '/' (da '/admin' von der server.js kommt)
// Erlaubt Links (GET) und Formulare (POST) exakt auf dem Pfad /admin/logout
router.all('/admin/logout', (req, res) => {
    if (req.session) {
        req.session.destroy(() => {
            res.redirect('/admin/login');
        });
    } else {
        res.redirect('/admin/login');
    }
});

router.get('/admin/login', (req, res) => {
    return res.render('admin/login', {
        error: req.query.err || null,
        formData: {},
        currentStation: null 
    });
});
router.post('/admin/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        let admin;

        // Sicherheitsnetz: Prüfen, ob wir uns auf einer Subdomain befinden oder auf der Hauptdomain
        if (req.currentStation && req.currentStation.id) {
            // Szenario A: Login auf einer Sender-Subdomain -> Strikte Zuordnung prüfen
            admin = db.prepare('SELECT * FROM admins WHERE email = ? AND station_id = ?')
                      .get(email, req.currentStation.id);
        } else {
            // Szenario B: Login auf der Hauptdomain -> Admin global anhand der E-Mail finden
            admin = db.prepare('SELECT * FROM admins WHERE email = ?')
                      .get(email);
        }

        if (!admin) {
            return res.render('admin/login', { 
                error: 'Ungültige Zugangsdaten für dieses Portal.', 
                formData: req.body,
                currentStation: null 
            });
        }

        // Passwort-Vergleich mit Bcrypt
        const match = await bcrypt.compare(password, admin.password_hash);
        if (!match) {
            return res.render('admin/login', { 
                error: 'Ungültige Zugangsdaten für dieses Portal.', 
                formData: req.body,
                currentStation: null 
            });
        }

        // --- SESSION-ZUWEISUNG FÜR DEN ABGESCHOTTETEN ZUGRIFF ---
        req.session.isAdmin = true;
        req.session.adminId = admin.id;
        req.session.adminStationId = admin.station_id; // Nimmt die zugewiesene ID (z.B. 1 für Basspistol, 2 für Bass)

        // Erfolgreicher Login -> Weiterleitung zur Übersicht
        return res.redirect('/admin');

    } catch (err) {
        console.error("Schwerer Fehler beim Admin-Login:", err.message);
        return res.render('admin/login', { error: 'Interner Serverfehler beim Login: ' + err.message });
    }
});

//router.post('/admin/logout', (req, res) => {
//    req.session.destroy(() => res.redirect('/admin/login'));
//});

// --- Uebersicht ---

// router.get('/admin', requireAdmin, (req, res) => {
 
    
router.get('/admin', requireAdmin, async (req, res) => {
    console.log("==================================================");
    console.log(`[Admin-Check] Eingeloggter Admin-ID: ${req.session.adminId}`);
    console.log(`[Admin-Check] Erhaltene Admin-Station-ID aus Session: ${req.session.adminStationId}`);
    console.log("==================================================");
    console.log(`[Session] Aktuelle Session-ID (Cookie-Inhalt): ${req.sessionID}`);
    console.log(`[Session] adminId: ${req.session.adminId}`);
    //console.log(`[Session] adminStationId (Rohwert):`, rawSessionStationId);
    //console.log(`[Session] adminStationId (Konvertiert): ${adminStationId}`);
    
    // Sicherheitsnetz: Falls die Session aus irgendeinem Grund leer ist, 
    // erzwingen wir ein Fallback, anstatt alle Daten für alle Admins freizugeben!
    const adminStationId = req.session.adminStationId ? parseInt(req.session.adminStationId, 10) : 1;

    try {
        // 1. Alle Tracks für die Sortierschleife laden
        const tracks = db.prepare('SELECT * FROM tracks').all();
        
        // Globale Docker-Basis aus der .env holen
        // const globalDockerDir = process.env.AZURACAST_MEDIA_BASE_PATH || path.join(__dirname, '..', 'uploads');

        // --- AUTOMATISCHE BACKGROUND-SORTIERUNG IN GET /admin ---
        for (const track of tracks) {
            if (track.status === 'freigegeben' && track.azuracast_media_id) {
                try {
                    // KORREKTUR: Die Stations- und Pfadermittlung steht nun IN DER SCHLEIFE
                    // Dadurch ist 'track.station_id' hier fehlerfrei definiert!
                    const stationDb = db.prepare('SELECT azuracast_station_id, url_stub FROM stations WHERE id = ?').get(track.station_id);
                    const stationFolder = stationDb ? stationDb.azuracast_station_id : 'luziferase';
                    const stationStub = stationDb ? stationDb.url_stub : 'default';
                    // Der exakte, dynamische Medien-Pfad für diese spezifische Station
                    const baseMediaDir = path.join(globalDockerDir, stationFolder, 'media');

                    // Nutzt lib/azuracast.js (korrekter X-API-Key-Header + /file/-Endpunkt --
                    // vorher lief hier ein abweichender Bearer-Header gegen /media/ ins Leere)
                    const azuraTrack = await azuracast.getMedia(stationStub, track.azuracast_media_id);

                    if (azuraTrack === null) {
                        // Track wurde direkt in AzuraCast entfernt (z.B. manuell im Admin-UI) --
                        // lokal nachziehen, damit Admin- und Artist-Ansicht nicht faelschlich
                        // weiter "freigegeben" zeigen.
                        db.prepare(`
                            UPDATE tracks
                            SET azuracast_media_id = NULL, status = 'eingereicht', updated_at = CURRENT_TIMESTAMP
                            WHERE id = ?
                        `).run(track.id);
                        console.log(`[Auto-Sort] Track "${track.title}" war in AzuraCast nicht mehr auffindbar -- lokal zurueckgesetzt.`);
                    } else {
                        const hasPlaylists = azuraTrack.playlists && azuraTrack.playlists.length > 0;
                        
                        // Aktuellen Ordner aus dem gespeicherten Filepath extrahieren (z.B. "mapped-to-playlist")
                        const currentFolder = track.filepath.split('/')[0];
                        let expectedFolder = currentFolder;

                        if (hasPlaylists) {
                            expectedFolder = 'mapped-to-playlist';
                        } else if (currentFolder === 'mapped-to-playlist') {
                            // Wenn er die Playlist verloren hat -> ab ins Archiv
                            expectedFolder = 'archive';
                        }

                        // Wenn sich der Status geändert hat -> Datei auf Hetzner-Platte verschieben
                        if (currentFolder !== expectedFolder) {
                            const oldPath = path.join(baseMediaDir, track.filepath);
                            const newFolder = path.join(baseMediaDir, expectedFolder);
                            const newPath = path.join(newFolder, track.filename);

                            if (!fs.existsSync(newFolder)) {
                                fs.mkdirSync(newFolder, { recursive: true });
                            }

                            if (fs.existsSync(oldPath)) {
                                fs.renameSync(oldPath, newPath);
                                
                                // Berechtigungen für Docker-Container sicherstellen
                                fs.chmodSync(newPath, 0o666);

                                const newRelativePath = `${expectedFolder}/${track.filename}`;
                                db.prepare('UPDATE tracks SET filepath = ? WHERE id = ?').run(newRelativePath, track.id);
                                console.log(`[Auto-Sort] Track "${track.title}" erfolgreich nach /${expectedFolder} verschoben.`);
                            }
                        }
                    }
                } catch (syncErr) {
                    console.error(`[Auto-Sort-Fehler] Track-ID ${track.id} fehlgeschlagen:`, syncErr.message);
                }
            }
        }

        // ====================================================================
        // --- 2. DATEN FÜR DAS TEMPLATE LADEN (Nach dem Aufräumen) ---
        // ====================================================================
        const pendingTracks = db.prepare(`
            SELECT tracks.*, artists.name AS artist_name
            FROM tracks JOIN artists ON tracks.artist_id = artists.id
            WHERE tracks.status = 'eingereicht' AND tracks.station_id = ?
            ORDER BY tracks.uploaded_at ASC
        `).all(adminStationId);

        const artists = db.prepare(`
            SELECT * FROM artists 
            WHERE id IN (SELECT DISTINCT artist_id FROM tracks WHERE station_id = ?)
            ORDER BY name ASC
        `).all(adminStationId);
        const allTracks = db.prepare('SELECT * FROM tracks WHERE station_id = ? ORDER BY uploaded_at DESC').all(adminStationId);

        // Stationsbezogene Playlist-Optionen für die Pending-Station(en) laden
        const stationRows = db.prepare(`
            SELECT id, url_stub
            FROM stations
            WHERE id IN (
                SELECT DISTINCT station_id
                FROM tracks
                WHERE status = 'eingereicht' AND station_id = ?
            )
        `).all(adminStationId);

        const playlistsByStation = {};
        for (const st of stationRows) {
            playlistsByStation[String(st.id)] = await loadStationPlaylists(st.url_stub);
        }


        // Template rendern und alle Variablen sauber übergeben
        return res.render('admin/overview', { 
            artists: artists,
            tracks: allTracks, 
            pendingTracks: pendingTracks,
            playlistsByStation: playlistsByStation,
            error: req.query.err || null, 
            message: req.query.msg || null,
            currentStation: null // Sicherheitsnetz für das Login-Layout
        });

    } catch (macroErr) {
        console.error("[SCHWERER FEHLER] In GET /admin Hauptroute:", macroErr.message);
        return res.status(500).send("Serverfehler im Admin-Bereich: " + macroErr.message);
    }
});

    /*


    const artists = db.prepare('SELECT * FROM artists ORDER BY name ASC').all();

    res.render('admin/overview', {
        pendingTracks,
        artists,
        message: req.query.msg || null,
        error: req.query.err || null,
    });
    */
 

// --- Artist anlegen ---

router.post('/admin/artists', requireAdmin, (req, res) => {
    const { name, email, password, quota_mb, artist_page_url, contact_email, contact_phone } = req.body;

    if (!contact_email && !contact_phone) {
        return res.redirect('/admin?err=Bitte Kontakt-E-Mail oder Telefon angeben.');
    }

    try {
        const hash = bcrypt.hashSync(password, 12);
        db.prepare(`
            INSERT INTO artists (name, email, password_hash, quota_mb, artist_page_url, contact_email, contact_phone)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            name,
            email,
            hash,
            parseInt(quota_mb, 10) || 500,
            (artist_page_url || '').trim(),
            (contact_email || '').trim(),
            (contact_phone || '').trim()
        );
        res.redirect('/admin?msg=Artist angelegt.');
    } catch (e) {
        res.redirect(`/admin?err=${encodeURIComponent('Fehler: ' + e.message)}`);
    }
});

// --- Kontingent anpassen ---

router.post('/admin/artists/:id/quota', requireAdmin, (req, res) => {
    const { quota_mb } = req.body;
    db.prepare('UPDATE artists SET quota_mb = ? WHERE id = ?').run(
        parseInt(quota_mb, 10),
        req.params.id
    );
    res.redirect('/admin?msg=Kontingent aktualisiert.');
});

// --- Artist aktivieren/deaktivieren (statt loeschen, um Historie zu erhalten) ---

router.post('/admin/artists/:id/toggle-active', requireAdmin, (req, res) => {
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.params.id);
    db.prepare('UPDATE artists SET active = ? WHERE id = ?').run(artist.active ? 0 : 1, artist.id);
    res.redirect('/admin?msg=Status geaendert.');
});

// --- Track ablehnen ---

router.post('/admin/tracks/:id/reject', requireAdmin, (req, res) => {
    db.prepare(`
        UPDATE tracks SET status = 'abgelehnt', reject_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(req.body.reason || '', req.params.id);
    res.redirect('/admin?msg=Track abgelehnt.');
});

// --- Track freigeben UND nach AzuraCast synchronisieren ---
// playlistIds als kommaseparierte Liste im Formular (z.B. "3" oder "3,5")
router.post('/admin/tracks/:id/approve-and-sync', requireAdmin, async (req, res) => {
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
    if (!track) {
        return res.redirect('/admin?err=Track nicht gefunden.');
    }
    

    console.log(`[DEBUG-SYNC] Track ID: get(req.params.id)`);

    const selectedPlaylistId = String(req.body.playlist_ids || '').trim();
    const playlistIds = selectedPlaylistId ? [Number(selectedPlaylistId)] : [];

    // 1. DYNAMISCHE SENDER- UND PFADERMITTLUNG
    const stationDb = db.prepare('SELECT azuracast_station_id, url_stub, sftp_user FROM stations WHERE id = ?').get(track.station_id);
    const stationSftpUser = stationDb?.sftp_user || null;
    const stationFolder = stationDb ? stationDb.azuracast_station_id : 'luziferase';
    const baseMediaDir = path.join(globalDockerDir, stationFolder, 'media');
    // Die Basis des Senders: /var/lib/.../_data/SENDERORDNER/media
    const stationStub = stationDb ? stationDb.url_stub : 'default';
    // Holt den Pfad der externen HDD aus der .env für den Zugriff auf die Quelldatei
    const externalTempDir = process.env.AZURACAST_MEDIA_TEMP_PATH || path.join(globalDockerDir, 'new');
    // KORREKTUR: Zwei unterschiedliche Wahrheiten je nachdem, ob der Track schon mal
    // synchronisiert war -- track.azuracast_media_id ist dafuer das verlaessliche Signal:
    // - Noch NIE synchronisiert (Erst-Upload): Datei liegt flach im gemeinsamen,
    //   stationsunabhaengigen Temp-Ordner der externen HDD (lib/upload.js -> multer).
    // - Bereits synchronisiert und seither vom Artist per "Ersetzen" bearbeitet: die
    //   neue Datei wurde von routes/artist.js schon stationsspezifisch nach
    //   baseMediaDir/new/ verschoben, track.filepath ("new/<datei>") ist relativ dazu.
    const localPath = track.azuracast_media_id
        ? path.join(baseMediaDir, track.filepath)
        : path.join(externalTempDir, track.filename);
             
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(track.artist_id);
    
    console.log(`[DEBUG-SYNC] Artist ID: get(track.artist_id)`);
    
    try {
        // Bestimmt den finalen Zielordner im virtuellen Dateisystem von AzuraCast
        const targetSubFolder = playlistIds.length > 0 ? 'mapped-to-playlist' : 'incoming';
        const targetFilename = `${targetSubFolder}/${track.filename}`;

        // --- 1. MULTIPART-UPLOAD MIT LIVE-DEBUGGING ---
        console.log(`[Import-Check] Typ von azuracast.uploadFile in der Route: ${typeof azuracast.uploadFile}`);
        console.log(`[DEBUG-UPLOAD] Starte Upload an AzuraCast für Datei: ${localPath}`);
        console.log(`[DEBUG-UPLOAD] Ziel-Pfad in AzuraCast: ${targetFilename}`);
         
        console.log(`[DEBUG-UPLOAD] Verwendeter stationStub: "${stationStub}"`);
        
        let result;
        if (track.azuracast_media_id) {
            console.log(`[DEBUG-UPLOAD] Modus: Ersetzen von ID ${track.azuracast_media_id}`);
            const replacedId = await azuracast.replaceFile(
                stationStub,
                track.azuracast_media_id,
                localPath,
                targetFilename,
                playlistIds,
                stationSftpUser
            );
            result = { id: replacedId }; // normalisieren
        } else {
            console.log(`[DEBUG-UPLOAD] Modus: Erst-Upload`);
            result = await azuracast.uploadFile(stationStub, localPath, targetFilename, stationSftpUser);
        }

        // MASSIVE INSPEKTION DER API-ANTWORT
        console.log("==================================================");
        console.log("[DEBUG-RESPONSE] Rohe API-Antwort von AzuraCast:");
        console.log(JSON.stringify(result, null, 2));
        console.log("==================================================");

        newMediaId = result ? (result.id || result.media_id || result.unique_id) : null;
        console.log(`[DEBUG-ID] Extrahierte newMediaId: "${newMediaId}" (Typ: ${typeof newMediaId})`);

        if (!newMediaId) {
            throw new Error(`Keine gültige ID extrahiert. Rohes Resultat: ${JSON.stringify(result)}`);
        }

        if (playlistIds.length > 0 && !track.azuracast_media_id) {
            console.log(`[DEBUG-PLAYLIST] Weise Playlists zu: ${playlistIds.join(',')} für ID: ${newMediaId}`);
            await azuracast.assignToPlaylists(stationStub, newMediaId, playlistIds);
        }

        // --- 2. METADATEN-UPGRADE MIT LIVE-TEST ---
        const rawLinks = db.prepare('SELECT platform, url FROM artist_links WHERE artist_id = ?').all(artist.id);
        const artistLinksMap = {};
        rawLinks.forEach(link => {
            if (link.platform && link.url) {
                artistLinksMap[`url_${link.platform.toLowerCase()}`] = link.url;
            }
        });

        console.log(`[DEBUG-METADATA] Sende Metadaten-Update an Station "${stationStub}" für ID: ${newMediaId}`);

        // REPARIERT: stationStub als 1. Parameter übergeben, um die Metadaten im richtigen Sender zu sichern!
        await azuracast.setMetadata(stationStub, newMediaId, {
            title: track.title,
            artist: artist.name,
            genre: track.genre || '',
            lyrics: track.bio_lyrics,
            bpm: track.bpm,
            url_track: track.track_page_url || '',
            url_artist: artist.artist_page_url,
            links: artistLinksMap,
        });

        const imagePath = path.join(__dirname, '..', 'public', 'track-images', track.image_filename);
        if (fs.existsSync(imagePath)) {
            try {
                // REPARIERT: stationStub als 1. Parameter übergeben
                await azuracast.uploadArt(stationStub, newMediaId, imagePath);
            } catch (artError) {
                console.error('Album-Cover Upload fehlgeschlagen:', artError.message);
            }
        }

        // --- 3. REDUNDANZ-ELIMINIERUNG (Temporäre Datei löschen) ---
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }

        // --- 4. DATENBANK UPDATE ---
        // Der relative Filepath in der DB zeigt nun direkt auf das finale Ziel im Volume
        const finalRelativeDbPath = `${targetSubFolder}/${track.filename}`;

        db.prepare(`
            UPDATE tracks
            SET status = 'freigegeben', 
                filepath = ?, 
                azuracast_media_id = ?, 
                playlist_ids = ?, 
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(finalRelativeDbPath, String(newMediaId), playlistIds.join(','), track.id);


        // Bestätigungs-E-Mail an Artist
        try {
            if (artist && artist.email) {
            
                req.session.flashMessage = req.session.flashMessage  ? `${req.session.flashMessage} artist.email` : artist.email + ' ' ;
            
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
                        pass: cleanSmtpPass,
                        logger: true,
                        debug: true
                    }
                });
                
                const stationName = stationDb?.name || req.currentStation?.name || 'Radio';
                const artistDisplayName = artist.name || '';

                const mailOptions = {
                    from: req.currentStation?.email_from || process.env.SMTP_FROM || 'post@luziferase.de',
                    to: artist.email,
                    subject: `[${stationName}] Track approved: ${track.title}`,
                    text: `Hi ${artistDisplayName},

your Track "${track.title}" is approved and will be synced with the running broadcast now:
https://modular.luziferase.de

Cheers,
${stationName}
https://modular.luziferase.de`,
                    html: `<p>Hi ${artistDisplayName},</p>
<p>your Track  "<strong>${track.title}</strong>"  is approved and will be synced with the running broadcast now:<br /><a href="https://modular.luziferase.de">https://modular.luziferase.de</a></p>
<p>Cheers,<br />${stationName}</p>`
                };        

                transporter.sendMail(mailOptions, (mailErr) => {
                    if (mailErr) {
                        console.error('Freigabe-Mail an Artist fehlgeschlagen:', mailErr.message);
                        req.session.flashMessage = req.session.flashMessage  ? `${req.session.flashMessage} Freigabe-Mail an Artist fehlgeschlagen` : ' Freigabe-Mail an Artist fehlgeschlagen ' ;
                    }
                    req.session.flashMessage = req.session.flashMessage  ? `${req.session.flashMessage} Freigabe-Mail an Artist gesendet` : ' Freigabe-Mail an Artist gesendet ' ;
                });  
            }
        } catch (mailOuterErr) {
            console.error('Unerwarteter Fehler beim Erstellen/Versenden der Freigabe-Mail:', mailOuterErr.message);
            req.session.flashMessage = req.session.flashMessage  ? `${req.session.flashMessage} Unerwarteter Fehler beim Versenden ` : ' Unerwarteter Fehler beim Versenden ' ;
        }  

        res.redirect('/admin?msg=Track erfolgreich freigegeben, Metadaten und Cover synchronisiert.');
    } catch (e) {
        console.error("Schwerer Fehler bei Freigabe-Route:", e.message);
        req.session.flashMessage = req.session.flashMessage  ? `${req.session.flashMessage} Schwerer Fehler bei Freigabe-Route ` : ' Schwerer Fehler bei Freigabe-Route ' ;
        res.redirect(`/admin?err=${encodeURIComponent('AzuraCast-Sync fehlgeschlagen: ' + e.message)}`);
    }
});

// --- Track aus AzuraCast entfernen (z.B. nach Loeschung durch Artist) ---

router.post('/admin/tracks/:id/remove-from-azuracast', requireAdmin, async (req, res) => {
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
    if (!track || !track.azuracast_media_id) {
        return res.redirect('/admin?err=Kein synchronisierter Track gefunden.');
    }
    try {
        // KORREKTUR: deleteFile erwartet (stationStub, mediaId) -- vorher fehlte
        // stationStub komplett, wodurch die Loeschung gegen eine falsche URL lief.
        const stationDb = db.prepare('SELECT url_stub FROM stations WHERE id = ?').get(track.station_id);
        const stationStub = stationDb ? stationDb.url_stub : 'default';
        await azuracast.deleteFile(stationStub, track.azuracast_media_id);
        db.prepare('UPDATE tracks SET azuracast_media_id = NULL WHERE id = ?').run(track.id);
        res.redirect('/admin?msg=Aus AzuraCast entfernt.');
    } catch (e) {
        res.redirect(`/admin?err=${encodeURIComponent('Fehler: ' + e.message)}`);
    }
});

// GET: Audio-Stream im Admin-Bereich (Korrigiert für das /new- & Playlist-System)
// GET: Audio-Stream im Admin-Bereich (Ohne Session-Sperre für den HTML5-Player)
router.get('/admin/tracks/:id/stream/:filename', (req, res) => {
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
    if (!track) return res.status(404).send('Track nicht gefunden.');

    const stationDb = db.prepare('SELECT azuracast_station_id FROM stations WHERE id = ?').get(track.station_id);
    const stationFolder = stationDb ? stationDb.azuracast_station_id : 'luziferase';
    const baseMediaDir = path.join(globalDockerDir, stationFolder, 'media');
    
    const externalTempDir = process.env.AZURACAST_MEDIA_TEMP_PATH || path.join(globalDockerDir, 'new');
    
    let absoluteFilePath = null;

    // KORREKTUR: 'eingereicht' heisst nicht mehr zwingend "liegt noch im flachen Temp-
    // Ordner" -- ein bereits synchronisierter, seither per "Ersetzen" bearbeiteter Track
    // faellt ebenfalls auf 'eingereicht' zurueck, liegt dann aber schon stationsspezifisch
    // in baseMediaDir/new/ (siehe gleiche Unterscheidung wie bei approve-and-sync).
    if (track.status === 'eingereicht' && !track.azuracast_media_id) {
        absoluteFilePath = path.join(externalTempDir, req.params.filename);
    } else if (track.status === 'eingereicht' && track.azuracast_media_id) {
        const newPath = path.join(baseMediaDir, 'new', req.params.filename);
        if (fs.existsSync(newPath)) {
            absoluteFilePath = newPath;
        }
    } else {
        // Für alle bereits freigegebenen/sortierten Tracks durchsuchen wir das Docker-Volume
        const possibleFolders = ['mapped-to-playlist', 'incoming', 'archive'];
        for (const folder of possibleFolders) {
            const testPath = path.join(baseMediaDir, folder, req.params.filename);
            if (fs.existsSync(testPath)) {
                absoluteFilePath = testPath;
                break; 
            }
        }
    }
    
    /*
    const possibleFolders = ['mapped-to-playlist', 'incoming', 'archive', 'new'];
    let absoluteFilePath = null;

    for (const folder of possibleFolders) {
        const testPath = path.join(baseMediaDir, folder, req.params.filename);
        if (fs.existsSync(testPath)) {
            absoluteFilePath = testPath;
            break; 
        }
    }
    */
    
    if (!absoluteFilePath) {
        absoluteFilePath = path.join(baseMediaDir, track.filepath);
    }

    if (!fs.existsSync(absoluteFilePath)) {
        console.error(`[Admin-Streaming-Fehler] Datei unauffindbar unter: ${absoluteFilePath}`);
        return res.status(404).send('Datei nicht gefunden.');
    }

    res.sendFile(absoluteFilePath);
});
 
// POST: Künstler restlos löschen (Volle Entkopplung gegen 504 Time-outs)
router.post('/admin/artists/:id/delete', requireAdmin, async (req, res) => {

    console.log("==================================================");
    console.log("[DEBUG] POST /admin/artists/:id/delete!");
    console.log("==================================================");

    const artistId = req.params.id;
    // const baseMediaDir = process.env.AZURACAST_MEDIA_BASE_PATH || path.join(__dirname, '..', 'uploads');

    // 1. Daten sichern, solange der Künstler noch in der DB existiert
    const artist = db.prepare('SELECT name FROM artists WHERE id = ?').get(artistId);
    if (!artist) {
        return res.redirect('/admin?err=Kuenstler nicht gefunden.');
    }

    // Holt alle Tracks, um die Dateien auf der Platte zu finden
    const artistTracks = db.prepare('SELECT id, filepath, image_filename, azuracast_media_id, station_id FROM tracks WHERE artist_id = ?').all(artistId);
    console.log(`[DEBUG] ${artistTracks.length} Tracks erfolgreich aus der DB geladen.`);
    

                    
    // Wir ermitteln die Stations-Stubs im Vorfeld absolut fehlerfrei
    const stationMap = {};
    try {
        const allStations = db.prepare('SELECT id, url_stub FROM stations').all();
        allStations.forEach(s => { stationMap[s.id] = s.url_stub; });
    } catch (e) {
        console.error("Stations konnten fuer Loeschung nicht geladen werden:", e.message);
    }

    try {
        // --- SCHRITT A: LOKALE DATEIEN SOFORT LÖSCHEN (Blitzschnell) --- 
        for (const singleTrack of artistTracks) {         
            // REPARIERT: Nutzt jetzt 'singleTrack.station_id' passend zur Schleifen-Variable!
            const stationDb = db.prepare('SELECT azuracast_station_id, url_stub FROM stations WHERE id = ?').get(singleTrack.station_id);
            const stationFolder = stationDb ? stationDb.azuracast_station_id : 'luziferase';
            const stationStub = stationDb ? stationDb.url_stub : 'default';
            
            // Der exakte, dynamische Medien-Pfad für diese spezifische Station
            const baseMediaDir = path.join(globalDockerDir, stationFolder, 'media');        
        
            // Musikdatei löschen
            if (singleTrack.filepath) {
                const audioPath = path.join(baseMediaDir, singleTrack.filepath);
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            }
            // Cover-Bild löschen
            if (singleTrack.image_filename) {
                const imagePath = path.join(__dirname, '..', 'public', 'track-images', singleTrack.image_filename);
                if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
            }
        }

        // --- SCHRITT B: DATENBANK SOFORT BEREINIGEN (Unter 5ms) ---
        db.prepare('DELETE FROM artist_links WHERE artist_id = ?').run(artistId);
        db.prepare('DELETE FROM tracks WHERE artist_id = ?').run(artistId);
        db.prepare('DELETE FROM artists WHERE id = ?').run(artistId);

        // --- SCHRITT C: AZURACAST-CLEANUP VOLLSTÄNDIG IN DEN HINTERGRUND VERLAGERN ---
        // Diese Funktion läuft völlig autark im RAM weiter, WÄHREND der Browser schon die Erfolgsmeldung sieht!
        setTimeout(async () => {
            console.log(`[Hintergrund-Job] Starte AzuraCast-Bereinigung fuer Kuenstler: ${artist.name}`);
            
            // Nutzt 'singleTrack' als eindeutige Variable innerhalb der Schleife
            for (const singleTrack of artistTracks) {
                if (singleTrack.azuracast_media_id) {
                    const stub = stationMap[singleTrack.station_id] || 'default';
                    try {
                        // REPARIERT: Greift jetzt fehlerfrei auf singleTrack zu!
                        await fetch(`${process.env.AZURACAST_BASE_URL}/api/station/${stub}/media/${singleTrack.azuracast_media_id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${process.env.AZURACAST_API_KEY}` }
                        });
                        console.log(`[Hintergrund-Job] Track-ID ${singleTrack.id} erfolgreich aus AzuraCast geloescht.`);
                    } catch (apiErr) {
                        console.error(`[Hintergrund-Job] Fehler beim Loeschen von Track ${singleTrack.id} aus AzuraCast:`, apiErr.message);
                    }
                }
            }
        }, 10);
        // --- SCHRITT D: SOFORTIGE ANTWORT AN NGINX (Kein 504 Time-out physikalisch moeglich!) ---
        return res.redirect('/admin?msg=' + encodeURIComponent(`Kuenstler "${artist.name}" wurde erfolgreich aus dem Portal geloescht.`));

    } catch (err) {
        console.error('Schwerer Fehler in der Loesch-Route:', err.message);
        return res.redirect(`/admin?err=${encodeURIComponent('Fehler beim Loeschen: ' + err.message)}`);
    }
});


// GET: Tiefen-Debugging für URL- und File-Mapping aller Stationen
router.get('/admin/debug-stations', requireAdmin, async (req, res) => {
    const debugReport = {
        timestamp: new Date().toISOString(),
        currentRequest: {
            hostname: req.hostname,
            headersHost: req.headers.host,
            // Prüft, ob die Subdomain-Middleware in server.js gegriffen hat
            detectedStationFromMiddleware: req.currentStation || "Keine Station im Request-Kontext (Globaler Admin-Modus)"
        },
        environment: {
            AZURACAST_BASE_URL: process.env.AZURACAST_BASE_URL || "Nicht gesetzt",
            AZURACAST_MEDIA_BASE_PATH: process.env.AZURACAST_MEDIA_BASE_PATH || "Nicht gesetzt"
        },
        stationsInDatabase: []
    };

    try {
        // 1. Alle registrierten Radiostationen aus der DB laden
        const stations = db.prepare('SELECT * FROM stations').all();

        for (const station of stations) {
            // Berechne die Pfade exakt so, wie es deine Upload- und Sortier-Routen tun
            const baseMediaDir = path.join(globalDockerDir, station.azuracast_station_id, 'media');
            //const newFolder = path.join(globalDockerDir, 'new'); // Der globale Sammelordner   
            const newFolder = process.env.AZURACAST_MEDIA_TEMP_PATH || path.join(globalDockerDir, 'new');

            const mappedFolder = path.join(baseMediaDir, 'mapped-to-playlist');
            const archiveFolder = path.join(baseMediaDir, 'archive');

            // Statistiken für diese Station ermitteln
            const trackCount = db.prepare('SELECT COUNT(*) AS count FROM tracks WHERE station_id = ?').get(station.id).count;
            const artistCount = db.prepare('SELECT COUNT(*) AS count FROM artists WHERE id IN (SELECT artist_id FROM tracks WHERE station_id = ?)').get(station.id).count;

            debugReport.stationsInDatabase.push({
                stationId: station.id,
                name: station.name,
                urlStub: station.url_stub,
                azuraStationIdOrFolder: station.azuracast_station_id,
                expectedSubdomainUrl: `artists-${station.url_stub}.luziferase.de`,
                databaseStats: {
                    associatedTracks: trackCount,
                    activeArtists: artistCount
                },
                fileMappingPaths: {
                    calculatedBaseMediaDir: baseMediaDir,
                    foldersCheck: {
                        globalNewFolder: { path: newFolder, exists: fs.existsSync(newFolder) },
                        mappedToPlaylistFolder: { path: mappedFolder, exists: fs.existsSync(mappedFolder) },
                        archiveFolder: { path: archiveFolder, exists: fs.existsSync(archiveFolder) }
                    }
                }
            });
        }

        // 2. Stichproben-Check für verwaiste oder falsch gemappte Tracks
        const misconfiguredTracks = db.prepare(`
            SELECT id, title, filename, filepath, station_id FROM tracks 
            WHERE station_id NOT IN (SELECT id FROM stations)
        `).all();
        
        debugReport.databaseIntegrityAnomalyCheck = {
            tracksWithInvalidStationId: misconfiguredTracks.length,
            affectedTrackDetails: misconfiguredTracks
        };

        // Gibt den gesamten Report als sauberes JSON im Browser aus
        return res.json(debugReport);

    } catch (err) {
        console.error("[DEBUG-ROUTE FEHLER]:", err.message);
        return res.status(500).json({ error: "Fehler beim Generieren des Debug-Reports", message: err.message });
    }
});

module.exports = router;
