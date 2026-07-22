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

    let container = document.getElementById('artist-links-container');
    if (!container) {
        const anchor = document.getElementById('url_artist-container');
        if (!anchor) {
            // Wird beim naechsten Poll-Zyklus erneut versucht, sobald der
            // Player/das DOM vollstaendig aufgebaut ist.
            return;
        }
        container = document.createElement('div');
        container.id = 'artist-links-container';
        anchor.insertAdjacentElement('afterend', container);
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
        const response = await fetch(`/api/nowplaying/luziferase`);
        const data = await response.json();
        // console.log(data);
        const lyrics = data.now_playing.song.lyrics;
        const url_artist = data.now_playing.song.custom_fields.url_artist;
        const url_track = data.now_playing.song.custom_fields.url_track;
        const bpm = data.now_playing.song.custom_fields.bpm;
        const remaining = data.now_playing.remaining;

        let container_lyrics = document.getElementById('lyrics-container');
        if (!container_lyrics) {
            const player = document.getElementById('public-radio-player');
            if (!player) {
                //console.warn('#public-radio-player noch nicht vorhanden, versuche später erneut');
                setTimeout(updateLyrics, 2000); // kurzer Retry, statt lang warten
                return;
            }
            const cardBody = player.querySelector('.card-body');
            if (!cardBody) {
                //console.warn('.card-body innerhalb von #public-radio-player nicht gefunden, versuche später erneut');
                setTimeout(updateLyrics, 2000);
                return;
            }
            container_lyrics = document.createElement('div');
            container_lyrics.id = 'lyrics-container';
            container_lyrics.className = 'lyrics-text'; 
            cardBody.insertAdjacentElement('afterend', container_lyrics);
        }
        if (lyrics) {
            container_lyrics.innerHTML = lyrics.replace(/\n/g, '<br>');
            syncLyricsBackground();
        } else {
            //container_lyrics.innerText = "Für diesen Song ist kein Text hinterlegt.";
            syncLyricsBackground();
        }
      
        let container_url_artist = document.getElementById('url_artist-container');
        if (!container_url_artist) {
            container_url_artist = document.createElement('div');
            container_url_artist.id = 'url_artist-container'; 
            container_url_artist.className = 'card-body'; 
            container_url_artist.classList.add('url_artist');
            const player = document.getElementById('public-radio-player');
            const cardBody = player.querySelector('.card-body');
            cardBody.insertAdjacentElement('afterend', container_url_artist);
        }
        if (url_artist) {
             //if (lyrics)
             container_url_artist.innerHTML = '<a class="btn_artist" href="'+url_artist+'" target="_blank" rel="noopener noreferrer">' +url_artist+'</a>';
             //if (!lyrics)
             //container_lyrics.insertAdjacentHTML('beforeend', '<a class="btn_artist" href="'+url_artist+'" target="_blank" rel="noopener noreferrer">' +url_artist+'</a>');
        } 
        if(url_track){
            //if (lyrics)
            container_url_artist.insertAdjacentHTML('beforeend', `<br><a class="btn_artist" href="${url_track}" target="_blank" rel="noopener noreferrer">${url_track}</a>`);
            //if (!lyrics) 
            //container_lyrics.insertAdjacentHTML('beforeend', `<br><a class="btn_artist" href="${url_track}" target="_blank" rel="noopener noreferrer">${url_track}</a>`);
        }
        if(bpm){           
          document.querySelector('.radio-control-select-stream').innerHTML= bpm + ' BPM';
        }

        updateArtistLinks(data.now_playing.song.custom_fields);

        const nextCheckIn = Math.min(Math.max((remaining + 2) * 1000, 5000), 30000);
        setTimeout(updateLyrics, nextCheckIn);
    } catch (error) {
        console.error('Fehler beim Laden der API:', error);
        setTimeout(updateLyrics, 15000);
    }
}

window.addEventListener('load', () => {
    updateLyrics();
});