// Simple Icons CDN (Version gepinnt statt @latest, damit sich Icon-Dateinamen
// nicht unter uns aendern). Bandcamp/Beatport/Instagram/Mixcloud/PeerTube/
// Pixelfed/SoundCloud/YouTube sind dort gelistet. Basspistol und hearthis.at
// sind (Stand jetzt) dort nicht vertreten -- icon: null loest den
// Buchstaben-Badge-Fallback in CSS aus (siehe .artist-link-icon--fallback).
const LINK_ICON_BASE = 'https://cdn.jsdelivr.net/npm/simple-icons@13/icons/';

const LINK_PLATFORMS = {
    soundcloud: { label: 'SoundCloud', icon: 'soundcloud.svg' },
    bandcamp:   { label: 'Bandcamp',   icon: 'bandcamp.svg' },
    beatport:   { label: 'Beatport',   icon: 'beatport.svg' },
    youtube:    { label: 'YouTube',    icon: 'youtube.svg' },
    mixcloud:   { label: 'Mixcloud',   icon: 'mixcloud.svg' },
    instagram:  { label: 'Instagram',  icon: 'instagram.svg' },
    peertube:   { label: 'PeerTube',   icon: 'peertube.svg' },
    pixelfed:   { label: 'Pixelfed',   icon: 'pixelfed.svg' },
    hearthisat: { label: 'hearthis.at', icon: null },
    basspistol: { label: 'Basspistol', icon: null },
};

/**
 * Rendert bis zu drei Icon-Links fuer die im Artist-Profil hinterlegten
 * Streaming-/Social-Media-Links. customFields kommt direkt aus
 * data.now_playing.song.custom_fields (Objekt, Keys wie link_soundcloud).
 * Wird bei jedem Poll komplett neu aufgebaut, damit ein Wechsel des Tracks
 * (und damit potenziell anderer Artist-Links) sich sofort niederschlaegt.
 */
function updateArtistLinks(customFields) {
    if (!customFields) return;

    //let container = document.getElementById('artist-links-container');
    let container = document.getElementById('artist-links-container');
    if (!container) {
        //const anchor = document.getElementById('url_artist-container');
        //if (!anchor) {
            // Wird beim naechsten Poll-Zyklus erneut versucht, sobald der
            // Player/das DOM vollstaendig aufgebaut ist.
            //return;
        //}
        container = document.createElement('div');
        container.id = 'artist-links-container';
        container.className = 'card-body url_artist';
        // anchor.insertAdjacentElement('afterend', container);
       
        // const targetElement = document.querySelector('.card-title');
        // const targetElement = document.querySelector('.stations.nowplaying');
        const targetElement = document.querySelector('.card-body');
        if (targetElement) {
            targetElement.insertAdjacentElement('afterend', container);
        }       
    }

    container.innerHTML = '';

    Object.keys(LINK_PLATFORMS).forEach(function (slug) {
        const url = customFields['link_' + slug];
        if (!url) return;

        const info = LINK_PLATFORMS[slug];
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'artist-link-icon';
        link.title = info.label;

        if (info.icon) {
            const img = document.createElement('img');
            img.src = LINK_ICON_BASE + info.icon;
            img.alt = info.label;
            link.appendChild(img);
        } else {
            link.classList.add('artist-link-icon--fallback');
            link.textContent = info.label.charAt(0).toUpperCase();
        }

        container.appendChild(link);
    });
}

function syncLyricsBackground() {
    
    const container_lyrics = document.getElementById('lyrics-container');
    
    //if (!container_lyrics) return;
    if (container_lyrics) {
      const bodyStyle = getComputedStyle(document.body);
      const bodyImage = bodyStyle.backgroundImage; // liefert z.B. url("...")

      container_lyrics.style.backgroundImage = 
        `linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.85)), ${bodyImage}`;
      container_lyrics.style.backgroundSize = 'cover';
      container_lyrics.style.backgroundPosition = 'center';  
      //container_lyrics.style.mixBlendMode = 'difference';
    }  
}


let lastTrackFingerprint = null;

async function updateLyrics() {
    try {
        // Stations-Shortcode ermitteln: entweder aus dem Pfad (azuracast.luziferase.de/public/<station>)
        // oder aus der Subdomain (<station>.luziferase.de) – der interne nginx-rewrite auf /public/$station_stub
        // ändert die Browser-URL NICHT, daher zusätzlich Hostname-Fallback nötig
        const pathMatch = window.location.pathname.match(/\/public\/([^\/]+)/);
        const hostMatch = window.location.hostname.match(/^(?!azuracast\.|artists\.|stream\.|www\.)([^.]+)\.luziferase\.de$/i);
        const stationStub = pathMatch?.[1] || hostMatch?.[1] || 'luziferase';
        const response = await fetch(`/api/nowplaying/${stationStub}`, { cache: 'no-store' });
        const data = await response.json();

        const song = data.now_playing?.song || {};
        const songId = song.id ?? song.text ?? null;
        
        const songFingerprint = [
          songId ?? '',
          song?.artist ?? '',
          song?.title ?? '',
          song?.text ?? '',
          data.now_playing?.duration ?? ''
        ].join('||');
        
        // Initial-Render + Change-Detection robust
        const isFirstRun = lastTrackFingerprint === null;
        const changed = isFirstRun || (songFingerprint && songFingerprint !== lastTrackFingerprint);
        
        // WICHTIG: Werte außerhalb des changed-Blocks definieren (Scope-Fix)
        const lyrics = song?.lyrics;
        const bio = song?.custom_fields?.bio;
        const url_artist = song?.custom_fields?.url_artist;
        //const url_track = song?.custom_fields?.url_track;
        const bpm = song?.custom_fields?.bpm;
        // const remaining = data.now_playing?.remaining || 15;

        if (changed) {      
            lastTrackFingerprint = songFingerprint;
            
            let container_lyrics = document.getElementById('lyrics-container');
            if (!container_lyrics) {
                const player = document.getElementById('public-radio-player');
                if (!player) {
                    setTimeout(updateLyrics, 2000);
                    return;
                }
                const cardBody = player.querySelector('.card-body');
                if (!cardBody) {
                    setTimeout(updateLyrics, 2000);
                    return;
                }
                container_lyrics = document.createElement('div');
                container_lyrics.id = 'lyrics-container';
                container_lyrics.className = 'lyrics-text';
                cardBody.insertAdjacentElement('afterend', container_lyrics);
            }

            // Songwechsel / Initial-Render
            if (lyrics) {
                container_lyrics.innerHTML = lyrics.replace(/\n/g, '<br>');
            } else if (bio) {
                container_lyrics.innerHTML = bio.replace(/\n/g, '<br>');
            } else {
                container_lyrics.innerHTML = "";
            }

            if (typeof syncLyricsBackground === "function") syncLyricsBackground();

            let container_url_artist = document.getElementById('artist-links-container');
            // bewusst unverändert belassen (wie in deinem Code)

            if (data.now_playing?.song?.custom_fields && typeof updateArtistLinks === "function") {
                updateArtistLinks(data.now_playing.song.custom_fields);
            }
        } else {
            // optional trotzdem leichte Updates (z.B. remaining/bpm phase)
            if (bpm) updateBpmSync(data);
        }

        // BPM-Anzeige unabhängig vom Trackwechsel aktuell halten
        if (bpm) {
            const streamSelect = document.querySelector('.radio-control-select-stream');
            if (streamSelect){
                streamSelect.innerHTML = bpm + ' BPM';
                document.querySelector('.card-title.mb-3')?.classList.add('player-visual');
                updateBpmSync(data);
            }
        }

        // statt remaining-basiert: konstantes kurzes Intervall
        setTimeout(updateLyrics, 2500);
    } catch (error) {
        console.error('Fehler beim Laden der API:', error);
        setTimeout(updateLyrics, 5000);
    }
}

window.addEventListener('load', () => {
    updateLyrics();
    // updateBpmSync(data);
});

function initPlayButtonColor() {
    const btn = document.querySelector('.radio-control-play-button');
    if (!btn) {
        // Button evtl. noch nicht gerendert (Vue lädt async) -> retry
        setTimeout(initPlayButtonColor, 500);
        return;
    }

    const updateState = () => {
        const isPlaying = btn.getAttribute('aria-label') !== 'Abspielen';
        btn.classList.toggle('is-playing', isPlaying);
    };

    updateState(); // initialer Zustand
    const observer = new MutationObserver(updateState);
    observer.observe(btn, { attributes: true, attributeFilter: ['aria-label', 'title'] });
}

window.addEventListener('load', initPlayButtonColor);

let lastBpmSyncTrackId = null;

function updateBpmSync(nowPlayingData) {
  const playerVisual = document.querySelector('.player-visual');
  if (!playerVisual) return; // Element existiert auf dieser Station evtl. nicht

  const song = nowPlayingData?.now_playing?.song;
  const elapsed = nowPlayingData?.now_playing?.elapsed ?? 0;

  // BPM aus Custom Fields ziehen — Feldname ggf. an eure tatsächliche
  // AzuraCast-Custom-Field-Bezeichnung anpassen (z.B. "bpm")
  const bpmRaw = song?.custom_fields?.bpm;
  const bpm = parseFloat(bpmRaw);

  // Kein gültiger BPM-Wert (leer, nicht-numerisch, oder 0) -> Animation
  // pausieren statt mit Unsinnswerten weiterlaufen zu lassen
  if (!bpm || isNaN(bpm) || bpm <= 0) {
    playerVisual.style.animationPlayState = 'paused';
    return;
  }

  const trackId = song?.id ?? song?.text; // Fallback falls keine ID vorhanden

  // Beat-Dauer in Sekunden berechnen und als CSS Custom Property setzen
  const beatDuration = 60 / bpm * 4;
  playerVisual.style.setProperty('--beat-duration', `${beatDuration}s`);
  playerVisual.style.animationPlayState = 'running';

  // Phasenkorrektur nur beim Trackwechsel neu berechnen (nicht bei
  // jedem Poll, sonst "ruckelt" die Animation bei jedem Update neu an)
  if (trackId !== lastBpmSyncTrackId) {
    lastBpmSyncTrackId = trackId;

    // Näherungslösung: wie weit sind wir "phasenmäßig" in den aktuellen
    // Beat hinein? Negativer animation-delay versetzt die Animation
    // direkt an diese Stelle, ohne von vorne zu starten.
    const phase = elapsed % beatDuration;
    playerVisual.style.animationDelay = `-${phase}s`;
  }
}

(function () {
  function detectStationStub() {
    const pathMatch = window.location.pathname.match(/\/public\/([^\/]+)/i);
    const hostMatch = window.location.hostname.match(
      /^(?!azuracast\.|artists\.|stream\.|www\.)([^.]+)\.luziferase\.de$/i
    );
    return (pathMatch?.[1] || hostMatch?.[1] || 'luziferase').toLowerCase();
  }

  // Liefert NUR den Content (String) zurück
  async function fetchStationMessage() {
    const station = detectStationStub();
        console.log('station: ', station);
    if (!station) return '';
 
    const API_BASE = 'https://azuracast.luziferase.de'; // z. B. https://upload.luziferase.de
    const url = `${API_BASE}/public/station-message?station=${encodeURIComponent(station)}`;
    //const url = `${window.location.origin}/public/station-message?station=${encodeURIComponent(station)}`; 
    // const url = `${window.location.origin}/artist-api/public/station-message?station=${encodeURIComponent(station)}`;
    console.log('url: ', url);
    
    try {
      const res = await fetch(url, { method: 'GET', credentials: 'omit' });
      if (!res.ok) return '';
      const data = await res.json();
      return (data?.message || '').trim();
    } catch (err) {
      console.warn('[station-message] fetch failed:', err.message);
      return '';
    }
  }

  // Beispiel: deine bestehende Render-Funktion kann das nutzen
  async function initHelpOverlay() {
    const card = document.querySelector('.card');
    if (!card) {
        setTimeout(initHelpOverlay, 500);
        return;
    }
    const station_content = await fetchStationMessage();
    if (!station_content) return;
    
    // Icon erzeugen
    const icon = document.createElement('div');
    icon.className = 'card-help-icon';
    icon.textContent = '?';
    icon.setAttribute('role', 'button');
    icon.setAttribute('aria-label', 'Informationen anzeigen');
    card.appendChild(icon);

    // Overlay erzeugen
    const overlay = document.createElement('div');
    overlay.className = 'card-help-overlay';
    overlay.innerHTML = `<button class="close-btn" aria-label="Schließen">&times;</button>` + station_content;
    card.appendChild(overlay);

    // Toggle-Logik
    icon.addEventListener('click', () => {
        overlay.classList.add('open');
    });
    overlay.querySelector('.close-btn').addEventListener('click', () => {
        overlay.classList.remove('open');
    });
  }

  if (document.readyState === 'loading') {
    console.log('initHelpOverlay...');
    window.addEventListener('DOMContentLoaded', initHelpOverlay);
  } else {
    initHelpOverlay();
  }

  // Optional global verfügbar machen, falls andere Funktionen extern darauf zugreifen:
  // window.fetchStationMessage = fetchStationMessage;
})();