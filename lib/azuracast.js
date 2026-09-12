// Metadaten- & Cover-Upload
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');
const axios = require('axios');
const SftpClient = require('ssh2-sftp-client');
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
 
 

async function uploadFile(stationStub, localFilePath, targetPath, sftpUser = null) {
    const sftp = new SftpClient();
          ' bassModular'
    const sftpConfig = {
        host: '65.21.244.212',
        port: 2022,
        username: sftpUser || process.env.AZURACAST_SFTP_USER || 'bassAdmin',
        password: process.env.AZURACAST_SFTP_PASSWORD || 'Speechy2026'
    };

    try {
        await sftp.connect(sftpConfig);
        await sftp.fastPut(localFilePath, `/${targetPath}`);
        await sftp.end();

        // Reindex triggern, aber 500 nicht sofort als hard fail behandeln
        try {
            await axios.post(`${BASE_URL}/api/station/${stationStub}/backend/media`, {}, {
                headers: { 'X-API-Key': API_KEY },
                timeout: 20000
            });
        } catch (reindexErr) {
            console.warn(`[AzuraCast] Reindex warn (${reindexErr.response?.status || 'no-status'}): ${reindexErr.message}`);
        }

        // ggf. kurz warten, bis AzuraCast indexiert hat
        await new Promise(r => setTimeout(r, 1500));

        const listRes = await axios.get(`${BASE_URL}/api/station/${stationStub}/files`, {
            headers: { 'X-API-Key': API_KEY },
            timeout: 20000
        });

        const matchedFile = (listRes.data || []).find(f => f.path === targetPath);

        if (!matchedFile) {
            throw new Error(`Datei hochgeladen, aber (noch) nicht in /files gefunden: ${targetPath}`);
        }

        return {
            id: matchedFile.id,
            unique_id: matchedFile.unique_id || matchedFile.id,
            success: true
        };
    } catch (err) {
        try { await sftp.end(); } catch (_) {}
        throw new Error(`AzuraCast SFTP Sync fehlgeschlagen: ${err.message}`);
    }
}   
 
async function uploadFileXXX(stationStub, localFilePath, targetFilename) {
    const fileBuffer = fs.readFileSync(localFilePath);
    const base64 = fileBuffer.toString('base64');
    
    console.log(`[DEBUG-AZURA] ${BASE_URL}/api/station/${stationStub}/files`);
    
    const res = await fetch(`${BASE_URL}/api/station/${stationStub}/files`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            path: targetFilename,
            file: base64,
        }),
    });
    
    console.log(`[DEBUG-AZURA] res.ok ? res.ok`);
    
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
async function replaceFile(stationStub, oldMediaId, localFilePath, targetFilename, playlistIds = [], sftpUser = null) {
    if (oldMediaId) {
        await deleteFile(stationStub, oldMediaId);
    }
    const uploadResult = await uploadFile(stationStub, localFilePath, targetFilename, sftpUser);
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


 /**
 * Liefert alle Playlists einer Station.
 * Rückgabe: Array mit Objekten inkl. id und name.
 */
async function getPlaylists(stationStub) {
    const res = await fetch(`${BASE_URL}/api/station/${stationStub}/playlists`, {
        method: 'GET',
        headers: authHeaders(),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AzuraCast Playlists laden fehlgeschlagen (${res.status}): ${text}`);
    }

    const data = await res.json();
    return Array.isArray(data) ? data : [];
}


/**
 * Fragt eine einzelne Media-Datei ab. Gibt null zurueck, wenn sie nicht (mehr)
 * existiert (z.B. weil sie direkt in AzuraCast geloescht wurde), statt zu werfen --
 * so laesst sich das Ergebnis direkt fuer eine Loeschungs-Erkennung nutzen.
 */
async function getMedia(stationStub, mediaId) {
    const res = await fetch(`${BASE_URL}/api/station/${stationStub}/file/${mediaId}`, {
        method: 'GET',
        headers: authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`AzuraCast Media-Abfrage fehlgeschlagen (${res.status}): ${text}`);
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
    getPlaylists,
    getMedia,
    ALL_LINK_PLATFORMS,
};
