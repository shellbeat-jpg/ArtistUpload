# Artist-Upload-Portal fuer Luziferase on Air

Externes Upload-System fuer Artists, das getrennt von AzuraCast laeuft und erst nach
redaktioneller Freigabe per API mit AzuraCast synchronisiert. Loest damit die
Einschraenkung, dass AzuraCasts eigenes Rollensystem keine "nur eigene Tracks"-Sicht
und keine Pro-Nutzer-Kontingente kennt.

## Funktionsumfang

- Artist-Login (vom Admin angelegt, kein offenes Self-Signup)
- Pro-Artist-Kontingent in MB, serverseitig durchgesetzt
- Upload mit Pflicht-/Optionalfeldern: Track Name, Genre, BPM*, URL Track Page,
  URL Video*, Bio/Lyrics-Freitext*, Track Image (Pflicht)
- Artist-Profil: Artist Name, URL Artist Page, Kontakt (Telefon* oder E-Mail)
- Tracks koennen vom Artist jederzeit ersetzt werden (Audio, Bild, Angaben) --
  ist der Track bereits live in AzuraCast, wird der Status automatisch auf
  "eingereicht" zurueckgesetzt, damit der Admin die Aktualisierung bewusst bestaetigt
- Admin-Bereich: Artists anlegen/sperren, Kontingente aendern, Tracks freigeben
  (inkl. automatischem Sync zu AzuraCast: Upload, Playlist-Zuordnung, Ersetzen bei
  Wiederholung) oder ablehnen

(* = optional)

## Voraussetzungen

- Node.js 18 oder neuer
- Ein AzuraCast-API-Schluessel (AzuraCast -> Nutzermenue -> "Meine API-Schluessel")
  mit Berechtigung "Manage Station Media" fuer deine Station

## Installation auf deinem Hetzner-Server

Diese Anwendung soll **neben** AzuraCast auf demselben Server laufen, auf einem
eigenen internen Port (Standard: 3500), erreichbar ueber eine eigene Subdomain
(z.B. `uploads.luziferase.de`) per Reverse Proxy.

```bash
# 1. Node.js installieren (falls noch nicht vorhanden)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Projektverzeichnis anlegen und Dateien hierher kopieren
mkdir -p /opt/artist-upload
cd /opt/artist-upload
# (Dateien aus diesem Paket hierher kopieren, z.B. per scp)

# 3. Abhaengigkeiten installieren
npm install

# 4. Konfiguration anlegen
cp .env.example .env
nano .env
# -> SESSION_SECRET auf einen langen Zufallsstring setzen
# -> AZURACAST_API_KEY eintragen
# -> AZURACAST_STATION_ID pruefen (siehe https://azuracast.luziferase.de/api/stations)
# -> ADMIN_EMAIL / ADMIN_PASSWORD fuer den ersten Login setzen

# 5. Datenbank initialisieren (legt Schema + ersten Admin-Account an)
npm run init-db

# 6. Testweise starten
npm start
# -> sollte "Artist-Upload-Portal laeuft auf http://127.0.0.1:3500" ausgeben
```

## Dauerhaft laufen lassen (systemd)

```bash
sudo nano /etc/systemd/system/artist-upload.service
```

```ini
[Unit]
Description=Artist Upload Portal
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/artist-upload
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/opt/artist-upload/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now artist-upload
sudo systemctl status artist-upload
```

## Eigene Subdomain per Reverse Proxy (Nginx Proxy Manager oder aehnlich)

Da AzuraCast selbst schon Port 80/443 belegt (siehe eure bisherige Multi-Site-Konfiguration
mit `azuracast.luziferase.de`), braucht `uploads.luziferase.de` einen eigenen Proxy-Eintrag,
der intern auf `127.0.0.1:3500` weiterleitet. Falls ihr aktuell direkt AzuraCasts
eingebauten Reverse Proxy nutzt (ohne separaten Nginx Proxy Manager davor), ist der
einfachste Weg ein zusaetzlicher, eigener Nginx-vhost fuer diese eine Subdomain,
unabhaengig von AzuraCasts Docker-Setup:

```nginx
server {
    listen 80;
    server_name uploads.luziferase.de;
    location / {
        proxy_pass http://127.0.0.1:3500;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Danach per `certbot --nginx -d uploads.luziferase.de` ein eigenes Let's-Encrypt-Zertifikat
ziehen. Sobald HTTPS aktiv ist, in `server.js` bzw. `.env` `NODE_ENV=production` setzen,
damit Session-Cookies mit `secure: true` ausgeliefert werden.

## Wichtiger Hinweis zur AzuraCast-API-Anbindung

Die Endpunkte in `lib/azuracast.js` (`/api/station/{id}/files`, `/api/station/{id}/file/{id}`)
entsprechen dem aktuell dokumentierten Muster, koennen sich aber je nach AzuraCast-Version
leicht unterscheiden. **Vor dem produktiven Einsatz unbedingt einmal mit einer Testdatei
durchspielen** und bei Bedarf gegen die installations-eigene API-Doku abgleichen:

```
https://azuracast.luziferase.de/api/
```

BPM, Video-URL, Track-/Artist-Page-URL werden aktuell **nur in dieser Anwendung**
gespeichert, nicht automatisch nach AzuraCast uebertragen (AzuraCast hat dafuer keine
festen Standardfelder). Falls gewuenscht, lassen sich dafuer unter AzuraCast ->
Administration -> Custom Fields passende Felder anlegen; die Uebertragung koennte dann
in `lib/azuracast.js` (`setMetadata`) ergaenzt werden.

## Sicherheitshinweise

- Audiodateien liegen bewusst **nicht** unter `public/`, sondern in `uploads/` (nicht
  oeffentlich abrufbar) -- nur Track-Bilder unter `public/track-images/` sind direkt
  erreichbar.
- Passwoerter werden mit bcrypt gehasht, nie im Klartext gespeichert.
- Setzt unbedingt einen langen, zufaelligen `SESSION_SECRET` in der `.env`.
- Diese Anwendung ersetzt keine Rechteklaerung mit den Artists selbst -- die
  Bestaetigung, dass hochgeladener Content frei von Rechten Dritter ist, solltet ihr
  weiterhin ausserhalb des Systems (z.B. schriftlich) einholen.
  
  i118n
  npm install i18next i18next-http-middleware i18next-fs-backend
  /lib/i18n.js – zentrale Konfiguration
  /locales
    /de
      translation.json
    /en
      translation.json
  /lib/i18n.js
