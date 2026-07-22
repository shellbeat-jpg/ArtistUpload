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

router.post('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

// --- Uebersicht ---

router.get('/admin', requireAdmin, (req, res) => {
    const pendingTracks = db.prepare(`
        SELECT tracks.*, artists.name AS artist_name
        FROM tracks JOIN artists ON tracks.artist_id = artists.id
        WHERE tracks.status = 'eingereicht'
        ORDER BY tracks.uploaded_at ASC
    `).all();

    const artists = db.prepare('SELECT * FROM artists ORDER BY name ASC').all();

    res.render('admin/overview', {
        pendingTracks,
        artists,
        message: req.query.msg || null,
        error: req.query.err || null,
    });
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

    const localPath = path.join(__dirname, '..', 'uploads', track.filepath);
    const targetFilename = `artists/${track.artist_id}/${track.filepath}`;
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(track.artist_id);

    try {
        let newMediaId;
        if (track.azuracast_media_id) {
            // Ersetzt eine bereits vorhandene AzuraCast-Datei (siehe lib/azuracast.js)
            newMediaId = await azuracast.replaceFile(
                track.azuracast_media_id,
                localPath,
                targetFilename,
                playlistIds
            );
        } else {
            const result = await azuracast.uploadFile(localPath, targetFilename);
            newMediaId = result.id || result.media_id;
            if (playlistIds.length > 0 && newMediaId) {
                await azuracast.assignToPlaylists(newMediaId, playlistIds);
            }
        }

        // Metadaten mit Standard-Feldern und Custom Fields (BPM, URL_Track, URL_Artist) uebertragen
        if (newMediaId) {
            await azuracast.setMetadata(newMediaId, {
                title: track.title,
                artist: artist.name,
                genre: track.genre,
                lyrics: track.bio_lyrics,
                bpm: track.bpm,
                url_track: track.track_page_url,
                url_artist: artist.artist_page_url,
                links: getArtistLinksMap(artist.id),
            });

            // Album-Cover hochladen
            const imagePath = path.join(__dirname, '..', 'public', 'track-images', track.image_filename);
            if (fs.existsSync(imagePath)) {
                try {
                    await azuracast.uploadArt(newMediaId, imagePath);
                } catch (artError) {
                    console.error('Album-Cover Upload fehlgeschlagen:', artError.message);
                    // Nicht fataal, Track ist trotzdem freigegeben
                }
            }
        }

        db.prepare(`
            UPDATE tracks
            SET status = 'freigegeben', azuracast_media_id = ?, playlist_ids = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(String(newMediaId), playlistIds.join(','), track.id);

        res.redirect('/admin?msg=Track freigegeben und mit AzuraCast synchronisiert.');
    } catch (e) {
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

module.exports = router;
