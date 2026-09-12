// Gleicht lokal gespeicherte Tracks mit ihrem tatsächlichen Zustand in AzuraCast ab.
// Aktuell: erkennt Tracks, die direkt in AzuraCast gelöscht wurden (z.B. manuell im
// AzuraCast-Admin-UI), und zieht das lokal nach, damit weder Admin- noch Artist-Ansicht
// fälschlich weiter "freigegeben" zeigen.

const db = require('../db/connection');
const azuracast = require('./azuracast');

/**
 * Prüft für eine Liste bereits synchronisierter Tracks (DB-Zeilen mit gesetzter
 * azuracast_media_id), ob sie in AzuraCast noch existieren. Fehlt ein Track dort,
 * wird sowohl die DB als auch das übergebene Objekt selbst aktualisiert
 * (azuracast_media_id -> NULL, status -> 'eingereicht') -- damit ein bereits
 * geladenes Array sofort mitrendert, ohne einen zweiten Request zu brauchen.
 *
 * Nicht-synchronisierte Tracks (azuracast_media_id ist NULL) werden übersprungen.
 * Ein Fehler bei einer einzelnen Prüfung (z.B. AzuraCast kurz nicht erreichbar)
 * wird nur geloggt und bricht die übrigen Prüfungen nicht ab.
 *
 * Gibt die Anzahl der als "in AzuraCast entfernt" erkannten Tracks zurück.
 */
async function reconcileDeletedTracks(tracks) {
    let removedCount = 0;

    for (const track of tracks) {
        if (!track.azuracast_media_id) continue;

        try {
            const stationDb = db.prepare('SELECT url_stub FROM stations WHERE id = ?').get(track.station_id);
            const stationStub = stationDb ? stationDb.url_stub : 'default';

            const media = await azuracast.getMedia(stationStub, track.azuracast_media_id);
            if (media === null) {
                db.prepare(`
                    UPDATE tracks
                    SET azuracast_media_id = NULL, status = 'eingereicht', updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(track.id);

                track.azuracast_media_id = null;
                track.status = 'eingereicht';
                removedCount++;
                console.log(`[Sync] Track ${track.id} war in AzuraCast nicht mehr auffindbar -- lokal zurueckgesetzt.`);
            }
        } catch (e) {
            console.error(`[Sync] Existenz-Check fuer Track ${track.id} fehlgeschlagen:`, e.message);
        }
    }

    return removedCount;
}

module.exports = { reconcileDeletedTracks };
