// Kapselt alle Aufrufe an die AzuraCast-API an einer Stelle.
// Doku deiner eigenen Installation: https://azuracast.luziferase.de/docs/api

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const BASE_URL = process.env.AZURACAST_BASE_URL;
const API_KEY = process.env.AZURACAST_API_KEY;
const STATION_ID = process.env.AZURACAST_STATION_ID;

function authHeaders(extra = {}) {
    return {
        'X-API-Key': API_KEY,
        ...extra,
    };
}

/**
 * Laedt eine lokale Datei zur Station hoch.
 * AzuraCast erwartet Base64-kodierten Inhalt unter dem Endpunkt /files.
 * Gibt die neue Media-ID zurueck.
 */
async function uploadFile(localFilePath, targetFilename) {
    const fileBuffer = fs.readFileSync(localFilePath);
    const base64 = fileBuffer.toString('base64');

    const res = await fetch(`${BASE_URL}/api/station/${STATION_ID}/files`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            path: targetFilename,
            file: base64,
        }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AzuraCast Upload fehlgeschlagen (${res.status}): ${text}`);
    }
    return res.json(); // enthaelt u.a. die neue Media-ID
}

/**
 * Loescht eine bestehende Media-Datei anhand ihrer AzuraCast Media-ID.
 */
async function deleteFile(mediaId) {
    const res = await fetch(`${BASE_URL}/api/station/${STATION_ID}/file/${mediaId}`, {
        method: 'DELETE',
        headers: authHeaders(),
    });
    if (!res.ok && res.status !== 404) {
        const text = await res.text();
        throw new Error(`AzuraCast Loeschen fehlgeschlagen (${res.status}): ${text}`);
    }
    return true;
}

/**
 * Ordnet eine Media-Datei einer oder mehreren Playlists zu.
 * playlistIds: Array von Playlist-IDs aus AzuraCast
 */
async function assignToPlaylists(mediaId, playlistIds) {
    const res = await fetch(`${BASE_URL}/api/station/${STATION_ID}/file/${mediaId}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ playlists: playlistIds }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AzuraCast Playlist-Zuordnung fehlgeschlagen (${res.status}): ${text}`);
    }
    return res.json();
}

/**
 * Ersetzt einen bereits synchronisierten Track: alte Datei loeschen,
 * neue hochladen, dieselben Playlists erneut zuordnen.
 */
async function replaceFile(oldMediaId, localFilePath, targetFilename, playlistIds = []) {
    if (oldMediaId) {
        await deleteFile(oldMediaId);
    }
    const uploadResult = await uploadFile(localFilePath, targetFilename);
    const newMediaId = uploadResult.id || uploadResult.media_id;
    if (playlistIds.length > 0 && newMediaId) {
        await assignToPlaylists(newMediaId, playlistIds);
    }
    return newMediaId;
}

// Feste Liste der waehlbaren Plattformen (Slugs = AzuraCast-Custom-Field-Suffix,
// d.h. es muessen in AzuraCast unter Admin -> Benutzerdefinierte Felder die
// Felder link_bandcamp, link_basspistol, ... angelegt sein). Reihenfolge hier
// ist nur informativ, die Anzeigereihenfolge im Player wird im Custom JS
// festgelegt.
const ALL_LINK_PLATFORMS = [
    'bandcamp',
    'basspistol',
    'beatport',
    'instagram',
    'hearthisat',
    'mixcloud',
    'peertube',
    'pixelfed',
    'soundcloud',
    'youtube',
];

/**
 * Setzt Standard-Metadaten (Titel, Artist, Genre, Lyrics-Freitextfeld) auf einer
 * bereits hochgeladenen Media-Datei. Diese vier Felder sind bestaetigt Teil des
 * regulaeren song-Objekts (siehe Now-Playing-API) und werden darum direkt unterstuetzt.
 *
 * Zusaetzlich werden Custom Fields unterstuetzt:
 * - bpm: Beats per Minute
 * - url_track: Track Page URL
 * - url_artist: Artist Page URL
 * - links: Objekt { platform: url }, z.B. { soundcloud: 'https://...', instagram: 'https://...' }
 *   mit maximal 3 befuellten Eintraegen (siehe Artist-Profil). Da AzuraCast Custom
 *   Fields an die Media-Datei gebunden sind (nicht an ein Artist-Profil), muss dieses
 *   Objekt bei jedem Sync eines Tracks des jeweiligen Artists mitgeschickt werden.
 *   Es werden bewusst ALLE bekannten Plattform-Felder gesetzt (befuellte mit ihrem
 *   Wert, alle anderen explizit mit '' geleert) -- sonst bliebe ein zuvor gesetzter
 *   Link stehen, wenn der Artist ihn im Profil wieder entfernt.
 */
async function setMetadata(mediaId, { title, artist, genre, lyrics, bpm, url_track, url_artist, links }) {
    const body = { title, artist, genre, lyrics };

    // Custom Fields nur hinzufuegen, wenn sie vorhanden sind
    if (bpm || url_track || url_artist || links) {
        body.custom_fields = {};
        if (bpm) body.custom_fields.bpm = String(bpm);
        if (url_track) body.custom_fields.url_track = url_track;
        if (url_artist) body.custom_fields.url_artist = url_artist;

        if (links) {
            ALL_LINK_PLATFORMS.forEach((platform) => {
                body.custom_fields[`link_${platform}`] = links[platform] || '';
            });
        }
    }

    const res = await fetch(`${BASE_URL}/api/station/${STATION_ID}/file/${mediaId}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AzuraCast Metadaten-Update fehlgeschlagen (${res.status}): ${text}`);
    }
    return res.json();
}

/**
 * Ladet ein Bild als Album-Cover zu einer Media-Datei hoch.
 * Erwartet multipart/form-data mit dem Bild-File.
 * WICHTIG: FormData.getHeaders() muss verwendet werden, damit die korrekten
 * Content-Type und Boundary-Header gesetzt werden. Manuelles Setzen von
 * Content-Type ueberschreibt die FormData-Header und fuehrt zu Fehlern.
 */
async function uploadArt(mediaId, localImagePath) {
    const fileBuffer = fs.readFileSync(localImagePath);
    const form = new FormData();
    form.append('art', fileBuffer, path.basename(localImagePath));

    const res = await fetch(`${BASE_URL}/api/station/${STATION_ID}/art/${mediaId}`, {
        method: 'POST',
        headers: {
            'X-API-Key': API_KEY,
            ...form.getHeaders(),
        },
        body: form,
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AzuraCast Album-Cover Upload fehlgeschlagen (${res.status}): ${text}`);
    }
    return res.json();
}

module.exports = {
    uploadFile,
    deleteFile,
    assignToPlaylists,
    replaceFile,
    setMetadata,
    uploadArt,
    ALL_LINK_PLATFORMS,
};
