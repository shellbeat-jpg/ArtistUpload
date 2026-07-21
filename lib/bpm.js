// Ermittelt automatisch das Tempo (BPM) einer Audiodatei: Dekodierung per ffmpeg
// nach mono-WAV, danach Tempo-/Beat-Erkennung per `aubio tempo`.
//
// Erfordert auf dem Server installierte Kommandozeilen-Tools:
//   sudo apt install ffmpeg aubio-tools
//
// Bewusst als externer Prozess statt als Node-Bibliothek umgesetzt, da es fuer
// die eigentliche Tempo-Erkennung keine ausgereifte, aktiv gepflegte reine
// JS-Implementierung gibt.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

/**
 * Analysiert eine lokale Audiodatei (FLAC/WAV/MP3) und gibt die erkannte Tempo
 * (BPM) als ganzzahlig gerundete Zahl zurueck, oder null, falls die Erkennung
 * fehlschlaegt (z.B. Tools nicht installiert, kein erkennbarer Beat, Timeout).
 * Wirft bewusst keine Exception nach aussen -- eine fehlgeschlagene Analyse soll
 * den Upload/die Bearbeitung nie blockieren, das BPM-Feld bleibt dann leer und
 * manuell ausfuellbar.
 */
async function detectBpm(inputFilePath) {
    const tmpWav = path.join(os.tmpdir(), `bpm-${crypto.randomBytes(8).toString('hex')}.wav`);

    try {
        // 1. Nach mono-WAV @ 44.1kHz dekodieren -- einheitliches Zwischenformat
        //    fuer FLAC/WAV/MP3, unabhaengig davon, mit welchen Format-Bibliotheken
        //    aubio-tools auf dem jeweiligen System gebaut wurde.
        await execFileAsync('ffmpeg', [
            '-y',
            '-hide_banner',
            '-loglevel', 'error',
            '-i', inputFilePath,
            '-ar', '44100',
            '-ac', '1',
            tmpWav,
        ], { timeout: 60_000 });

        // 2. Tempo erkennen. Erwartete Ausgabe (letzte Zeile): "123.45 bpm"
        const { stdout } = await execFileAsync('aubio', ['tempo', tmpWav], { timeout: 60_000 });

        const matches = [...stdout.matchAll(/([\d.]+)\s*bpm/gi)];
        if (matches.length === 0) return null;

        const lastValue = parseFloat(matches[matches.length - 1][1]);
        if (!Number.isFinite(lastValue) || lastValue <= 0) return null;

        return Math.round(lastValue);
    } catch (e) {
        console.error('BPM-Erkennung fehlgeschlagen:', e.message);
        return null;
    } finally {
        if (fs.existsSync(tmpWav)) {
            try { fs.unlinkSync(tmpWav); } catch (_) { /* Aufraeumfehler egal */ }
        }
    }
}

module.exports = { detectBpm };
