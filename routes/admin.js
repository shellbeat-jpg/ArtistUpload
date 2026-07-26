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

                    // API-Abfrage an AzuraCast senden
                    const response = await fetch(`${process.env.AZURACAST_BASE_URL}/api/station/${stationStub}/media/${track.azuracast_media_id}`, {
                        headers: { 'Authorization': `Bearer ${process.env.AZURACAST_API_KEY}` }
                    });
                    
                    if (response.ok) {
                        const azuraTrack = await response.json();
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

        // Template rendern und alle Variablen sauber übergeben
        return res.render('admin/overview', { 
            artists: artists,
            tracks: allTracks, 
            pendingTracks: pendingTracks,
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
    
    const playlistIds = (req.body.playlist_ids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);

    // 1. DYNAMISCHE SENDER- UND PFADERMITTLUNG
    const stationDb = db.prepare('SELECT azuracast_station_id, url_stub FROM stations WHERE id = ?').get(track.station_id);
    const stationFolder = stationDb ? stationDb.azuracast_station_id : 'luziferase';
    const baseMediaDir = path.join(globalDockerDir, stationFolder, 'media');
    // Die Basis des Senders: /var/lib/.../_data/SENDERORDNER/media
   
    const stationStub = stationDb ? stationDb.url_stub : 'default';
    
    // Findet die temporäre Quell-Datei fehlerfrei im /new-Ordner dieses Senders (z.B. new/hash.wav)
    const localPath = path.join(baseMediaDir, track.filepath);
 
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
            result = await azuracast.replaceFile(
                stationStub,
                track.azuracast_media_id,
                localPath,
                targetFilename,
                playlistIds
            );
        } else {
            console.log(`[DEBUG-UPLOAD] Modus: Erst-Upload`);
            result = await azuracast.uploadFile(stationStub, localPath, targetFilename);
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
        // Da AzuraCast die Datei nun erfolgreich verarbeitet hat, fegen wir 
        // die Quell-Datei aus dem /new-Unterordner des Senders von der Platte.
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

        res.redirect('/admin?msg=Track erfolgreich freigegeben, Metadaten und Cover synchronisiert.');
    } catch (e) {
        console.error("Schwerer Fehler bei Freigabe-Route:", e.message);
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
        await azuracast.deleteFile(track.azuracast_media_id);
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
    
    const possibleFolders = ['mapped-to-playlist', 'incoming', 'archive', 'new'];
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
            const newFolder = path.join(globalDockerDir, 'new'); // Der globale Sammelordner
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
