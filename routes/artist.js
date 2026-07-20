const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const { requireArtist } = require('../lib/auth');
const { upload, validateImageSize } = require('../lib/upload');

const router = express.Router();

// --- Login / Logout ---

router.get('/login', (req, res) => {
    res.render('artist/login', { error: null });
});

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    const artist = db.prepare('SELECT * FROM artists WHERE email = ? AND active = 1').get(email);

    if (!artist || !bcrypt.compareSync(password, artist.password_hash)) {
        return res.render('artist/login', { error: 'E-Mail oder Passwort ist falsch.' });
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

router.post('/profile', requireArtist, (req, res) => {
    const { name, artist_page_url, contact_email, contact_phone, bio } = req.body;

    if (!name || !name.trim()) {
        return res.redirect('/dashboard?err=Artist Name darf nicht leer sein.');
    }
    if (!artist_page_url || !artist_page_url.trim()) {
        return res.redirect('/dashboard?err=URL Artist Page ist ein Pflichtfeld.');
    }
    if (!contact_phone && !contact_email) {
        return res.redirect('/dashboard?err=Bitte Telefon oder E-Mail als Kontakt angeben.');
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

    res.redirect('/dashboard?msg=Profil aktualisiert.');
});

// --- Gemeinsame Validierung der Track-Zusatzfelder ---

function validateTrackFields(body) {
    const errors = [];
    if (!body.title || !body.title.trim()) errors.push('Track Name ist ein Pflichtfeld.');
    if (!body.genre || !body.genre.trim()) errors.push('Genre ist ein Pflichtfeld.');
    if (!body.track_page_url || !body.track_page_url.trim()) errors.push('URL Track Page ist ein Pflichtfeld.');
    if (body.bpm && (isNaN(parseInt(body.bpm, 10)) || parseInt(body.bpm, 10) <= 0)) {
        errors.push('BPM muss eine positive Zahl sein.');
    }
    return errors;
}

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
            return res.redirect('/dashboard?err=Keine Audiodatei ausgewaehlt.');
        }
        if (!imageFile) {
            cleanup();
            return res.redirect('/dashboard?err=Track Image ist ein Pflichtfeld.');
        }

        const fieldErrors = validateTrackFields(req.body);
        if (fieldErrors.length > 0) {
            cleanup();
            return res.redirect(`/dashboard?err=${encodeURIComponent(fieldErrors.join(' '))}`);
        }

        try {
            validateImageSize(imageFile);
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
                `/dashboard?err=${encodeURIComponent(`Kontingent ueberschritten. Noch verfuegbar: ${remaining} MB.`)}`
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

        res.redirect('/dashboard?msg=Track hochgeladen und zur Pruefung eingereicht.');
    });
});

// --- Bestehenden Track ersetzen (Audio, Bild und Angaben) ---
// Hinweis: Der AzuraCast-Sync fuer bereits freigegebene Tracks erfolgt separat
// durch den Admin (routes/admin.js -> /admin/tracks/:id/approve-and-sync).

router.post('/tracks/:id/replace', requireArtist, (req, res) => {
    upload.fields([{ name: 'track', maxCount: 1 }, { name: 'image', maxCount: 1 }])(req, res, (err) => {
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
            return res.redirect('/dashboard?err=Track nicht gefunden.');
        }

        const fieldErrors = validateTrackFields(req.body);
        if (fieldErrors.length > 0) {
            cleanupNew();
            return res.redirect(`/dashboard?err=${encodeURIComponent(fieldErrors.join(' '))}`);
        }

        if (imageFile) {
            try {
                validateImageSize(imageFile);
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
                    `/dashboard?err=${encodeURIComponent(`Kontingent ueberschritten. Fuer diesen Austausch verfuegbar: ${remaining} MB.`)}`
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

        const msg = wasSynced
            ? 'Track aktualisiert. Da er bereits live war, muss die Aenderung erneut freigegeben werden.'
            : 'Track aktualisiert.';
        res.redirect(`/dashboard?msg=${encodeURIComponent(msg)}`);
    });
});

// --- Eigenen Track loeschen ---

router.post('/tracks/:id/delete', requireArtist, (req, res) => {
    const track = db
        .prepare('SELECT * FROM tracks WHERE id = ? AND artist_id = ?')
        .get(req.params.id, req.session.artistId);

    if (!track) {
        return res.redirect('/dashboard?err=Track nicht gefunden.');
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

    res.redirect('/dashboard?msg=Track geloescht.');
});

module.exports = router;
