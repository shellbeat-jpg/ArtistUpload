const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('../db/connection');
const { requireAdmin } = require('../lib/auth');
const azuracast = require('../lib/azuracast');
const { getArtistLinksMap } = require('../lib/artist-links');

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
    res.render('admin/login', { error: null });
});

router.post('/admin/login', (req, res) => {
    const { email, password } = req.body;
    const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);

    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
        return res.render('admin/login', { error: 'E-Mail oder Passwort ist falsch.' });
    }

    req.session.adminId = admin.id;
    res.redirect('/admin');
});

//router.post('/admin/logout', (req, res) => {
//    req.session.destroy(() => res.redirect('/admin/login'));
//});

// --- Uebersicht ---

// router.get('/admin', requireAdmin, (req, res) => {
router.get('/admin', requireAdmin, async (req, res) => {
const tracks = db.prepare('SELECT * FROM tracks').all();
    const baseMediaDir = process.env.AZURACAST_MEDIA_BASE_PATH || path.join(__dirname, '..', 'uploads');

    // --- AUTOMATISCHE AZURACAST-ORDNER-SORTIERUNG ---
// --- AUTOMATISCHE BACKGROUND-SORTIERUNG IN GET /admin ---
    for (const track of tracks) {
        if (track.status === 'freigegeben' && track.azuracast_media_id) {
            try {
                const station = db.prepare('SELECT url_stub FROM stations WHERE id = ?').get(track.station_id);
                const stationStub = station ? station.url_stub : 'default';

                const response = await fetch(`${process.env.AZURACAST_BASE_URL}/api/station/${stationStub}/media/${track.azuracast_media_id}`, {
                    headers: { 'Authorization': `Bearer ${process.env.AZURACAST_API_KEY}` }
                });
                
                if (response.ok) {
                    const azuraTrack = await response.json();
                    const hasPlaylists = azuraTrack.playlists && azuraTrack.playlists.length > 0;
                    
                    // NEUE LOGIK: Wenn Playlists da -> mapped-to-playlist. 
                    // Wenn KEINE Playlists da, war er aber SCHON MAL freigegeben? Dann ab ins archive!
                    const currentFolder = track.filepath.split('/')[0];
                    let expectedFolder = currentFolder;

                    if (hasPlaylists) {
                        expectedFolder = 'mapped-to-playlist';
                    } else if (currentFolder === 'mapped-to-playlist') {
                        // Er war in einer Playlist, hat sie aber verloren -> ins Archiv verschieben
                        expectedFolder = 'archive';
                    }

                    if (currentFolder !== expectedFolder) {
                        const oldPath = path.join(baseMediaDir, track.filepath);
                        const newFolder = path.join(baseMediaDir, expectedFolder);
                        const newPath = path.join(newFolder, track.filename);

                        if (!fs.existsSync(newFolder)) fs.mkdirSync(newFolder, { recursive: true });

                        if (fs.existsSync(oldPath)) {
                            fs.renameSync(oldPath, newPath);
                            const newRelativePath = `${expectedFolder}/${track.filename}`;
                            db.prepare('UPDATE tracks SET filepath = ? WHERE id = ?').run(newRelativePath, track.id);
                            console.log(`Track ${track.title} wurde automatisch nach /${expectedFolder} verschoben.`);
                        }
                    }
                }
            } catch (syncErr) {
                console.error(`Auto-Sortierung für Track ${track.id} fehlgeschlagen:`, syncErr.message);
            }
        }
    }
    
    const pendingTracks = db.prepare(`
        SELECT tracks.*, artists.name AS artist_name
        FROM tracks JOIN artists ON tracks.artist_id = artists.id
        WHERE tracks.status = 'eingereicht'
        ORDER BY tracks.uploaded_at ASC
    `).all();
    
    // Hole frische Daten aus der DB für die Anzeige
    const artists = db.prepare('SELECT * FROM artists ORDER BY name ASC').all();
    const allTracks = db.prepare('SELECT * FROM tracks ORDER BY uploaded_at DESC').all();

    res.render('admin/overview', { 
        artists, 
        pendingTracks,
        tracks: allTracks, 
        error: req.query.err || null, 
        message: req.query.msg || null 
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
});

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

    const playlistIds = (req.body.playlist_ids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);

    const baseMediaDir = process.env.AZURACAST_MEDIA_BASE_PATH || path.join(__dirname, '..', 'uploads');
    const localPath = path.join(baseMediaDir, track.filepath);
 
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(track.artist_id);

    try {
        const station = db.prepare('SELECT url_stub FROM stations WHERE id = ?').get(track.station_id);
        const stationStub = station ? station.url_stub : 'default';

        // Bestimmt den Zielordner im AzuraCast-Dateisystem
        const targetSubFolder = playlistIds.length > 0 ? 'mapped-to-playlist' : 'incoming';
        const targetFilename = `${targetSubFolder}/${track.filename}`;

        let newMediaId;

        // --- 1. STABILER AZURACAST-API-UPLOAD ---
        if (track.azuracast_media_id) {
            // Falls der Track schon existiert, ersetzen wir ihn über das API-Modul
            newMediaId = await azuracast.replaceFile(
                track.azuracast_media_id,
                localPath,
                targetFilename,
                playlistIds
            );
        } else {
            // Wir nutzen die originale Upload-Funktion, die die Datei per Multipart-Form an die API übergibt
            const result = await azuracast.uploadFile(localPath, targetFilename);
            newMediaId = result.id || result.media_id;
            
            if (playlistIds.length > 0 && newMediaId) {
                await azuracast.assignToPlaylists(newMediaId, playlistIds);
            }
        }

        if (!newMediaId) {
            throw new Error("AzuraCast hat den Upload nicht mit einer gültigen Media-ID bestätigt.");
        }

        // --- 2. METADATEN- & COVER-SYNCHRONISATION ---
        const rawLinks = db.prepare('SELECT platform, url FROM artist_links WHERE artist_id = ?').all(artist.id);
        const artistLinksMap = {};
        rawLinks.forEach(link => {
            if (link.platform && link.url) {
                artistLinksMap[`url_${link.platform.toLowerCase()}`] = link.url;
            }
        });

        await azuracast.setMetadata(newMediaId, {
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
                await azuracast.uploadArt(newMediaId, imagePath);
            } catch (artError) {
                console.error('Album-Cover Upload fehlgeschlagen:', artError.message);
            }
        }

        // --- 3. REDUNDANZ-ELIMINIERUNG (Die temporäre Upload-Datei löschen) ---
        // Da AzuraCast die Datei nun erfolgreich kopiert und verarbeitet hat, 
        // löschen wir die Quell-Datei aus dem Node-incoming-Ordner. 
        // AzuraCast besitzt nun die einzige Kopie im Docker-Volume!
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }

        // --- 4. DATENBANK UPDATE ---
        // Der Filepath in der DB zeigt nun direkt auf die von AzuraCast verwaltete Datei im Volume
        db.prepare(`
            UPDATE tracks
            SET status = 'freigegeben', 
                filepath = ?, 
                azuracast_media_id = ?, 
                playlist_ids = ?, 
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(targetFilename, String(newMediaId), playlistIds.join(','), track.id);

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
router.get('/admin/tracks/:id/stream/:filename', requireAdmin, (req, res) => {
    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
    if (!track) return res.status(404).send('Track nicht gefunden.');

    const baseMediaDir = process.env.AZURACAST_MEDIA_BASE_PATH || path.join(__dirname, '..', 'uploads');
    
    // REPARIERT: Nutzt die exakte, playlistbasierte Pfadreferenz aus der Datenbank
    const absoluteFilePath = path.join(baseMediaDir, track.filepath);

    if (!fs.existsSync(absoluteFilePath)) {
        console.error(`[Admin-Streaming-Fehler] Datei nicht gefunden unter: ${absoluteFilePath}`);
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
    const baseMediaDir = process.env.AZURACAST_MEDIA_BASE_PATH || path.join(__dirname, '..', 'uploads');

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
        for (const track of artistTracks) {
            // Musikdatei löschen
            if (track.filepath) {
                const audioPath = path.join(baseMediaDir, track.filepath);
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            }
            // Cover-Bild löschen
            if (track.image_filename) {
                const imagePath = path.join(__dirname, '..', 'public', 'track-images', track.image_filename);
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
            
            for (const track of artistTracks) {
                if (track.azuracast_media_id) {
                    const stub = stationMap[track.station_id] || 'default';
                    try {
                        // Korrekter AzuraCast API Endpunkt für das Löschen einer Datei anhand der Media-ID
                        await fetch(`${process.env.AZURACAST_BASE_URL}/api/station/${stub}/media/${track.azuracast_media_id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${process.env.AZURACAST_API_KEY}` }
                        });
                        console.log(`[Hintergrund-Job] Track-ID ${track.id} erfolgreich aus AzuraCast geloescht.`);
                    } catch (apiErr) {
                        console.error(`[Hintergrund-Job] Fehler beim Loeschen von Track ${track.id} aus AzuraCast:`, apiErr.message);
                    }
                }
            }
        }, 10); // Startet 10 Millisekunden nach der Server-Antwort

        // --- SCHRITT D: SOFORTIGE ANTWORT AN NGINX (Kein 504 Time-out physikalisch moeglich!) ---
        return res.redirect('/admin?msg=' + encodeURIComponent(`Kuenstler "${artist.name}" wurde erfolgreich aus dem Portal geloescht.`));

    } catch (err) {
        console.error('Schwerer Fehler in der Loesch-Route:', err.message);
        return res.redirect(`/admin?err=${encodeURIComponent('Fehler beim Loeschen: ' + err.message)}`);
    }
});

module.exports = router;
