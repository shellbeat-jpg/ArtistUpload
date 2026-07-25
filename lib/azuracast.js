// Metadaten- & Cover-Upload
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const BASE_URL = process.env.AZURACAST_BASE_URL;
const API_KEY = process.env.AZURACAST_API_KEY;

function authHeaders(extra = {}) {
    return {
        'X-API-Key': API_KEY,
        ...extra,
    };
}

/**
 * Jeder API-Endpunkt steuert über den stationStub die korrekte, isolierte AzuraCast-Station an [1.1]:
 * Weist AzuraCast an, eine bereits im Volume liegende Datei synchron einzulesen.
 */
async function importExistingFile(stationStub, relativePath) {
    const url = `${BASE_URL}/api/station/${stationStub}/media`;
    const response = await fetch(url, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ path: relativePath })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AzuraCast Import-Fehler (${response.status}): ${errText}`);
    }
    return await response.json();
}

/**
 * Laedt eine lokale Datei zur Station hoch (Base64-kodiert).
 */
async function uploadFile(stationStub, localFilePath, targetFilename) {
    const fileBuffer = fs.readFileSync(localFilePath);
    const base64 = fileBuffer.toString('base64');

    const res = await fetch(`${BASE_URL}/api/station/${stationStub}/files`, {
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
    
    const data = await res.json();
    return data; // Gibt das geloggte JSON-Objekt sicher an die Route weiter!
}

/**
 * Loescht eine bestehende Media-Datei anhand ihrer AzuraCast Media-ID.
 */
async function deleteFile(stationStub, mediaId) {
    const res = await fetch(`${BASE_URL}/api/station/${stationStub}/file/${mediaId}`, {
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
 */
async function assignToPlaylists(stationStub, mediaId, playlistIds) {
    const res = await fetch(`${BASE_URL}/api/station/${stationStub}/file/${mediaId}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ playlists: playlistIds }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AzuraCast Playlist-Zuordnung fehlgeschlagen (${res.status}): ${text}`);
    }
    return await res.json();
}

/**
 * Ersetzt einen bereits synchronisierten Track.
 */
async function replaceFile(stationStub, oldMediaId, localFilePath, targetFilename, playlistIds = []) {
    if (oldMediaId) {
        await deleteFile(stationStub, oldMediaId);
    }
    const uploadResult = await uploadFile(stationStub, localFilePath, targetFilename);
    const newMediaId = uploadResult.id || uploadResult.media_id;
    if (playlistIds.length > 0 && newMediaId) {
        await assignToPlaylists(stationStub, newMediaId, playlistIds);
    }
    return newMediaId;
}

const ALL_LINK_PLATFORMS = [
    'bandcamp', 'basspistol', 'beatport', 'instagram', 'hearthisat',
    'mixcloud', 'peertube', 'pixelfed', 'soundcloud', 'youtube'
];

/**
 * Setzt Standard-Metadaten und Custom Fields auf einer Media-Datei.
 */
async function setMetadata(stationStub, mediaId, { title, artist, genre, lyrics, bpm, url_track, url_artist, links }) {
    const body = { title, artist, genre, lyrics };

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

    const res = await fetch(`${BASE_URL}/api/station/${stationStub}/file/${mediaId}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AzuraCast Metadaten-Update fehlgeschlagen (${res.status}): ${text}`);
    }
    return await res.json();
}

/**
 * Ladet ein Bild als Album-Cover zu einer Media-Datei hoch.
 */
async function uploadArt(stationStub, mediaId, localImagePath) {
    const fileBuffer = fs.readFileSync(localImagePath);
    const form = new FormData();
    form.append('art', fileBuffer, path.basename(localImagePath));

    const res = await fetch(`${BASE_URL}/api/station/${stationStub}/art/${mediaId}`, {
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
    return await res.json();
}

module.exports = {
    uploadFile,
    importExistingFile,
    deleteFile,
    assignToPlaylists,
    replaceFile,
    setMetadata,
    uploadArt,
    ALL_LINK_PLATFORMS,
};
