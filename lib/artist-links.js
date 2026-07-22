// Gemeinsame Logik fuer die Streaming-/Social-Media-Links im Artist-Profil.
// Wird sowohl von routes/artist.js (Profil-Formular, Speichern, Sync bei
// Profil-Aenderung/Track-Ersetzung) als auch von routes/admin.js (Sync beim
// Freigeben eines Tracks) verwendet, damit an allen drei Sync-Punkten
// garantiert dieselben Daten in gleicher Form an AzuraCast gehen.

const db = require('../db/connection');
const { ALL_LINK_PLATFORMS } = require('./azuracast');

/** Laedt die gespeicherten Links eines Artists als { platform: url }-Objekt (max. 3 Eintraege). */
function getArtistLinksMap(artistId) {
    const rows = db.prepare('SELECT platform, url FROM artist_links WHERE artist_id = ?').all(artistId);
    const map = {};
    rows.forEach((row) => { map[row.platform] = row.url; });
    return map;
}

/** Laedt die gespeicherten Links eines Artists als Array mit fester Laenge 3 fuers Formular (leere Slots = null). */
function getArtistLinksForForm(artistId) {
    const rows = db.prepare('SELECT platform, url FROM artist_links WHERE artist_id = ? ORDER BY id').all(artistId);
    const slots = [null, null, null];
    rows.slice(0, 3).forEach((row, i) => { slots[i] = row; });
    return slots;
}

/**
 * Liest die drei Link-Slots aus dem Request-Body (link_platform_1/link_url_1 usw.),
 * validiert sie und gibt ein Array gueltiger { platform, url }-Paare zurueck (max. 3).
 * Wirft eine Error mit uebersetzter Meldung, falls ein Slot inkonsistent befuellt ist
 * (nur Plattform ohne URL oder umgekehrt) oder eine unbekannte Plattform gewaehlt wurde.
 */
function parseArtistLinksFromBody(req, body) {
    const result = [];
    for (let i = 1; i <= 3; i++) {
        const platform = (body[`link_platform_${i}`] || '').trim();
        const url = (body[`link_url_${i}`] || '').trim();

        if (!platform && !url) continue; // leerer Slot, ueberspringen

        if (!platform || !url) {
            throw new Error(req.t('messages.linkSlotIncomplete', { slot: i }));
        }
        if (!ALL_LINK_PLATFORMS.includes(platform)) {
            throw new Error(req.t('messages.linkPlatformInvalid'));
        }
        result.push({ platform, url });
    }
    return result;
}

/** Ersetzt alle gespeicherten Links eines Artists durch die uebergebene Liste. */
function saveArtistLinks(artistId, links) {
    const tx = db.transaction((artistId, links) => {
        db.prepare('DELETE FROM artist_links WHERE artist_id = ?').run(artistId);
        const insert = db.prepare('INSERT INTO artist_links (artist_id, platform, url) VALUES (?, ?, ?)');
        links.forEach((link) => insert.run(artistId, link.platform, link.url));
    });
    tx(artistId, links);
}

module.exports = {
    ALL_LINK_PLATFORMS,
    getArtistLinksMap,
    getArtistLinksForForm,
    parseArtistLinksFromBody,
    saveArtistLinks,
};
