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

async function updateLyrics() {
    try {
        // Stations-Shortcode ermitteln: entweder aus dem Pfad (azuracast.luziferase.de/public/<station>)
        // oder aus der Subdomain (<station>.luziferase.de) – der interne nginx-rewrite auf /public/$station_stub
        // ändert die Browser-URL NICHT, daher zusätzlich Hostname-Fallback nötig
        const pathMatch = window.location.pathname.match(/\/public\/([^\/]+)/);
        const hostMatch = window.location.hostname.match(/^(?!azuracast\.|artists\.|stream\.|www\.)([^.]+)\.luziferase\.de$/i);
        const stationStub = pathMatch?.[1] || hostMatch?.[1] || 'luziferase';
        // REPARIERT: Ermittelt den Stations-Shortcode dynamisch aus der Browser-URL
        // const stationStub = window.location.pathname.split('/public/')[1]?.split('/')[0] || 'luziferase';
        const response = await fetch(`/api/nowplaying/${stationStub}`);
        const data = await response.json();
        
        // REPARIERT: Optionale Verkettung (?.) fängt leere Felder oder Werbe-Jingles fehlerfrei ab
        const lyrics = data.now_playing?.song?.lyrics;
        const bio = data.now_playing?.song?.custom_fields?.bio;
        const url_artist = data.now_playing?.song?.custom_fields?.url_artist;
        const url_track = data.now_playing?.song?.custom_fields?.url_track;
        const bpm = data.now_playing?.song?.custom_fields?.bpm;
        const remaining = data.now_playing?.remaining || 15;

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
      
        // Songwechsel
        if (lyrics) {
            container_lyrics.innerHTML = lyrics.replace(/\n/g, '<br>');
        } else if (bio) { 
            container_lyrics.innerHTML = bio.replace(/\n/g, '<br>'); 
        } else { 
            container_lyrics.innerHTML = ""; 
        }
        if (typeof syncLyricsBackground === "function") syncLyricsBackground();
      
        let container_url_artist = document.getElementById('artist-links-container');
        if (!container_url_artist) {

        }
       /*
        let container_url_artist = document.getElementById('url_artist-container');
        if (!container_url_artist) {
            container_url_artist = document.createElement('div');
            container_url_artist.id = 'url_artist-container'; 
            container_url_artist.className = 'card-body url_artist'; 
            const player = document.getElementById('public-radio-player');
            const cardBody = player?.querySelector('.card-body');
            if (cardBody) cardBody.insertAdjacentElement('afterend', container_url_artist);
        }
      
        // REPARIERT: Setzt den Container-Inhalt standardmäßig zurück
        if (container_url_artist) container_url_artist.innerHTML = "";

        if (url_track && container_url_artist) {
            container_url_artist.innerHTML = '<a class="btn_artist" href="'+url_track+'" target="_blank" rel="noopener noreferrer">' +url_track+'</a>';
        }
         */ 
        if (bpm) {           
            const streamSelect = document.querySelector('.radio-control-select-stream');
            console.log('BPM:', bpm);
            if (streamSelect){
              streamSelect.innerHTML = bpm + ' BPM';
              //streamSelect.classList.add('player-visual');
              document.querySelector('.card-title.mb-3').classList.add('player-visual');   
              updateBpmSync(data); 
            } 
        }

        if (data.now_playing?.song?.custom_fields && typeof updateArtistLinks === "function") {
            updateArtistLinks(data.now_playing.song.custom_fields);
        }

        const nextCheckIn = Math.min(Math.max((remaining + 2) * 1000, 5000), 30000);
        setTimeout(updateLyrics, nextCheckIn);
    } catch (error) {
        console.error('Fehler beim Laden der API:', error);
        setTimeout(updateLyrics, 15000);
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
  const beatDuration = 60 / bpm;
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

function initHelpOverlay() {
    const card = document.querySelector('.card');
    if (!card) {
        setTimeout(initHelpOverlay, 500);
        return;
    }

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
    overlay.innerHTML = `
        <button class="close-btn" aria-label="Schließen">&times;</button>
<h5>Über 030 Your local Basstation</h5>
<p>24/7-Radio aus der Berliner Bass-Music-Szene: 15 Minuten Sendezeit pro Producer, selbst kuratiert, direkt verlinkt zu Bandcamp, SoundCloud & Co.</p>
<p>24/7 radio from Berlin's bass music scene: 15 minutes of airtime per artist, self-curated, linking straight to Bandcamp, SoundCloud & more.</p>
<p><a class="footer-link" href="/artist/register" target='_blank' style="text-decoration: none; display: inline-block;">Registrierung ?</a></p>
<p><a class="footer-link" href="/artist/login" target='_blank' style="text-decoration: none; display: inline-block;">Login ?</a></p>
    `;
    card.appendChild(overlay);

    // Toggle-Logik
    icon.addEventListener('click', () => {
        overlay.classList.add('open');
    });
    overlay.querySelector('.close-btn').addEventListener('click', () => {
        overlay.classList.remove('open');
    });
}

window.addEventListener('load', initHelpOverlay);