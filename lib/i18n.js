// Zentrale i18next-Konfiguration fuer das Artist-Upload-Portal.
//
// Erkennungsreihenfolge der Sprache: Query-Parameter (?lng=en) > Cookie
// (wird nach jeder erfolgreichen Erkennung gesetzt) > Accept-Language-Header
// des Browsers. Fallback ist Deutsch, da das die Ausgangssprache aller
// bisherigen Templates und Server-Meldungen ist.

const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const middleware = require('i18next-http-middleware');
const path = require('path');

i18next
    .use(Backend)
    .use(middleware.LanguageDetector)
    .init({
        backend: {
            loadPath: path.join(__dirname, '..', 'locales', '{{lng}}', '{{ns}}.json'),
        },
        fallbackLng: 'de',
        preload: ['de', 'en'],
        supportedLngs: ['de', 'en'],
        detection: {
            order: ['querystring', 'cookie', 'header'],
            lookupQuerystring: 'lng',
            lookupCookie: 'lng',
            caches: ['cookie'],
        },
        interpolation: {
            escapeValue: false, // EJS escaped bereits selbst (<%= %>)
        },
    });

module.exports = { i18next, middleware };
