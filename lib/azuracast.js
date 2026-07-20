// Kapselt alle Aufrufe an die AzuraCast-API an einer Stelle.
// Doku deiner eigenen Installation: https://azuracast.luziferase.de/docs/api

const fs = require('fs');
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

/**
 * Setzt Standard-Metadaten (Titel, Artist, Genre, Lyrics-Freitextfeld) auf einer
 * bereits hochgeladenen Media-Datei. Diese vier Felder sind bestaetigt Teil des
 * regulaeren song-Objekts (siehe Now-Playing-API) und werden darum direkt unterstuetzt.
 *
 * BPM, Video-URL, Track-/Artist-Page-URL haben in AzuraCast selbst keine festen
 * Standardfelder -- dafuer muesstest du in Administration -> Custom Fields passende
 * Felder anlegen und sie hier per zusaetzlichem PUT-Aufruf mitschicken. Bis dahin
 * bleiben diese Angaben in der eigenen Datenbank dieser Anwendung gepflegt und stehen
 * im Admin-Bereich zur manuellen Uebernahme bereit.
 */
async function setMetadata(mediaId, { title, artist, genre, lyrics }) {
    const res = await fetch(`${BASE_URL}/api/station/${STATION_ID}/file/${mediaId}`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title, artist, genre, lyrics }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AzuraCast Metadaten-Update fehlgeschlagen (${res.status}): ${text}`);
    }
    return res.json();
}

module.exports = {
    uploadFile,
    deleteFile,
    assignToPlaylists,
    replaceFile,
    setMetadata,
};
