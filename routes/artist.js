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

const router = express.Router();

// --- Login / Logout ---

router.get('/login', (req, res) => {
    res.render('artist/login', { error: null });
});

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    const artist = db.prepare('SELECT * FROM artists WHERE email = ? AND active = 1').get(email);

    if (!artist || !bcrypt.compareSync(password, artist.password_hash)) {
        return res.render('artist/login', { error: req.t('login.invalidCredentials') });
    }

    req.session.artistId = artist.id;
    res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// --- Dashboard ---

router.get('/dashboard', requireArtist, (req, res) => {
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.session.artistId);
    const tracks = db.prepare('SELECT * FROM tracks WHERE artist_id = ? ORDER BY uploaded_at DESC').all(artist.id);

    const usedMb = tracks.reduce((sum, t) => sum + t.filesize_mb, 0);

    res.render('artist/dashboard', {
        artist,
        tracks,
        usedMb: usedMb.toFixed(1),
        quotaMb: artist.quota_mb,
        percentUsed: Math.min(100, Math.round((usedMb / artist.quota_mb) * 100)),
        message: req.query.msg || null,
        error: req.query.err || null,
    });
});

// --- Eigenes Profil aktualisieren (Artist Name, Artist Page URL, Kontakt, Bio) ---

router.post('/profile', requireArtist, async (req, res) => {
    const { name, artist_page_url, contact_email, contact_phone, bio } = req.body;

    if (!name || !name.trim()) {
        return res.redirect(`/dashboard?err=${encodeURIComponent(req.t('messages.profileNameRequired'))}`);
    }
    if (!artist_page_url || !artist_page_url.trim()) {
        return res.redirect(`/dashboard?err=${encodeURIComponent(req.t('messages.profileUrlRequired'))}`);
    }
    if (!contact_phone && !contact_email) {
        return res.redirect(`/dashboard?err=${encodeURIComponent(req.t('messages.profileContactRequired'))}`);
    }

    db.prepare(`
        UPDATE artists
        SET name = ?, artist_page_url = ?, contact_email = ?, contact_phone = ?, bio = ?
        WHERE id = ?
    `).run(
        name.trim(),
        artist_page_url.trim(),
        (contact_email || '').trim(),
        (contact_phone || '').trim(),
        (bio || '').trim(),
        req.session.artistId
    );

    // Name und Artist-Page-URL fliessen in die Metadaten (Standardfeld "artist" bzw.
    // Custom Field url_artist) jedes bereits mit AzuraCast synchronisierten Tracks
    // dieses Artists ein -- diese direkt nachziehen.
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.session.artistId);
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
            });
        } catch (e) {
            console.error(`AzuraCast-Sync fuer Track ${track.id} (Profil-Update) fehlgeschlagen:`, e.message);
            syncFailed = true;
        }
    }

    const msg = syncFailed
        ? req.t('messages.profileUpdatedSyncFailed')
        : req.t('messages.profileUpdated');
    res.redirect(`/dashboard?msg=${encodeURIComponent(msg)}`);
});

// --- Gemeinsame Validierung der Track-Zusatzfelder ---

function validateTrackFields(req, body) {
    const errors = [];
    if (!body.title || !body.title.trim()) errors.push(req.t('messages.trackTitleRequired'));
    if (!body.genre || !body.genre.trim()) errors.push(req.t('messages.trackGenreRequired'));
    if (!body.track_page_url || !body.track_page_url.trim()) errors.push(req.t('messages.trackPageUrlRequired'));
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
    upload.fields([{ name: 'track', maxCount: 1 }, { name: 'image', maxCount: 1 }])(req, res, (err) => {
        if (err) {
            return res.redirect(`/dashboard?err=${encodeURIComponent(err.message)}`);
        }

        const trackFile = req.files?.track?.[0];
        const imageFile = req.files?.image?.[0];

        const cleanup = () => {
            if (trackFile && fs.existsSync(trackFile.path)) fs.unlinkSync(trackFile.path);
            if (imageFile && fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
        };

        if (!trackFile) {
            cleanup();
            return res.redirect(`/dashboard?err=${encodeURIComponent(req.t('messages.noAudioFile'))}`);
        }
        if (!imageFile) {
            cleanup();
            return res.redirect(`/dashboard?err=${encodeURIComponent(req.t('messages.imageRequired'))}`);
        }

        const fieldErrors = validateTrackFields(req, req.body);
        if (fieldErrors.length > 0) {
            cleanup();
            return res.redirect(`/dashboard?err=${encodeURIComponent(fieldErrors.join(' '))}`);
        }

        try {
            validateImageSize(req, imageFile);
        } catch (e) {
            cleanup();
            return res.redirect(`/dashboard?err=${encodeURIComponent(e.message)}`);
        }

        const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.session.artistId);
        const fileSizeMb = trackFile.size / (1024 * 1024);

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

        db.prepare(`
            INSERT INTO tracks (
                artist_id, title, genre, bio_lyrics, bpm, track_page_url, video_url,
                image_filename, filename, filepath, filesize_mb, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eingereicht')
        `).run(
            artist.id,
            req.body.title.trim(),
            req.body.genre.trim(),
            (req.body.bio_lyrics || '').trim(),
            req.body.bpm ? parseInt(req.body.bpm, 10) : null,
            req.body.track_page_url.trim(),
            (req.body.video_url || '').trim(),
            imageFile.filename,
            trackFile.originalname,
            trackFile.filename,
            fileSizeMb
        );

        res.redirect(`/dashboard?msg=${encodeURIComponent(req.t('messages.trackUploaded'))}`);
    });
});

// --- Bestehenden Track ersetzen (Audio, Bild und Angaben) ---
// Hinweis: War der Track bereits mit AzuraCast synchronisiert (azuracast_media_id
// gesetzt), werden alle Aenderungen -- Audio, Bild und Textfelder -- direkt im
// Anschluss automatisch nach AzuraCast uebertragen. Der Status wird trotzdem auf
// "eingereicht" zurueckgesetzt, damit der Admin die Aenderung im Ueberblick sieht.

router.post('/tracks/:id/replace', requireArtist, (req, res) => {
    upload.fields([{ name: 'track', maxCount: 1 }, { name: 'image', maxCount: 1 }])(req, res, async (err) => {
        if (err) {
            return res.redirect(`/dashboard?err=${encodeURIComponent(err.message)}`);
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
            return res.redirect(`/dashboard?err=${encodeURIComponent(req.t('messages.trackNotFound'))}`);
        }

        const fieldErrors = validateTrackFields(req, req.body);
        if (fieldErrors.length > 0) {
            cleanupNew();
            return res.redirect(`/dashboard?err=${encodeURIComponent(fieldErrors.join(' '))}`);
        }

        if (imageFile) {
            try {
                validateImageSize(req, imageFile);
            } catch (e) {
                cleanupNew();
                return res.redirect(`/dashboard?err=${encodeURIComponent(e.message)}`);
            }
        }

        const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(req.session.artistId);

        // Audiodatei ist beim Ersetzen optional (nur Angaben aendern ist auch erlaubt);
        // Bild ist ebenfalls optional beim Ersetzen (Pflicht nur beim Erst-Upload).
        let newFilename = track.filename;
        let newFilepath = track.filepath;
        let newFilesizeMb = track.filesize_mb;

        if (trackFile) {
            const newFileSizeMb = trackFile.size / (1024 * 1024);
            const usedMbWithoutThis = db
                .prepare('SELECT COALESCE(SUM(filesize_mb), 0) AS used FROM tracks WHERE artist_id = ? AND id != ?')
                .get(artist.id, track.id).used;

            if (usedMbWithoutThis + newFileSizeMb > artist.quota_mb) {
                cleanupNew();
                const remaining = (artist.quota_mb - usedMbWithoutThis).toFixed(1);
                return res.redirect(
                    `/dashboard?err=${encodeURIComponent(req.t('messages.quotaExceededExchange', { remaining }))}`
                );
            }

            const oldLocalPath = path.join(__dirname, '..', 'uploads', track.filepath);
            if (fs.existsSync(oldLocalPath)) fs.unlinkSync(oldLocalPath);

            newFilename = trackFile.originalname;
            newFilepath = trackFile.filename;
            newFilesizeMb = newFileSizeMb;
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
                image_filename = ?, filename = ?, filepath = ?, filesize_mb = ?,
                status = 'eingereicht', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(
            req.body.title.trim(),
            req.body.genre.trim(),
            (req.body.bio_lyrics || '').trim(),
            req.body.bpm ? parseInt(req.body.bpm, 10) : null,
            req.body.track_page_url.trim(),
            (req.body.video_url || '').trim(),
            newImageFilename,
            newFilename,
            newFilepath,
            newFilesizeMb,
            track.id
        );

        let syncNote = '';
        if (wasSynced) {
            try {
                let mediaId = track.azuracast_media_id;

                // Audiodatei wurde ersetzt -> alte AzuraCast-Datei ersetzen und dabei
                // dieselben Playlists erneut zuordnen (aus der Admin-Freigabe gemerkt).
                if (trackFile) {
                    const localPath = path.join(__dirname, '..', 'uploads', newFilepath);
                    const targetFilename = `artists/${artist.id}/${newFilepath}`;
                    const playlistIds = (track.playlist_ids || '')
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .map(Number);
                    mediaId = await azuracast.replaceFile(track.azuracast_media_id, localPath, targetFilename, playlistIds);
                }

                await azuracast.setMetadata(mediaId, {
                    title: req.body.title.trim(),
                    artist: artist.name,
                    genre: req.body.genre.trim(),
                    lyrics: (req.body.bio_lyrics || '').trim(),
                    bpm: req.body.bpm ? parseInt(req.body.bpm, 10) : null,
                    url_track: req.body.track_page_url.trim(),
                    url_artist: artist.artist_page_url,
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
                syncNote = req.t('messages.syncFailedNote');
            }
        }

        const msg = wasSynced
            ? `${req.t('messages.trackUpdatedSynced')}${syncNote}`
            : req.t('messages.trackUpdated');
        res.redirect(`/dashboard?msg=${encodeURIComponent(msg)}`);
    });
});

// --- Eigenen Track loeschen ---

router.post('/tracks/:id/delete', requireArtist, (req, res) => {
    const track = db
        .prepare('SELECT * FROM tracks WHERE id = ? AND artist_id = ?')
        .get(req.params.id, req.session.artistId);

    if (!track) {
        return res.redirect(`/dashboard?err=${encodeURIComponent(req.t('messages.trackNotFound'))}`);
    }

    const localPath = path.join(__dirname, '..', 'uploads', track.filepath);
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

    if (track.image_filename) {
        const imagePath = path.join(__dirname, '..', 'public', 'track-images', track.image_filename);
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    }

    // Hinweis: War der Track schon in AzuraCast (azuracast_media_id gesetzt), bleibt er
    // dort bewusst bestehen, bis ein Admin ihn aktiv entfernt (routes/admin.js).
    db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);

    res.redirect(`/dashboard?msg=${encodeURIComponent(req.t('messages.trackDeleted'))}`);
});

module.exports = router;
