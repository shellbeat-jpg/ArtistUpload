const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Audiodateien: privat, nur ueber die Anwendung zugaenglich (nicht per express.static)
const audioDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

// Track-Bilder: bewusst unter public/, damit sie direkt per <img src="/track-images/...">
// eingebunden werden koennen (unkritisch, im Gegensatz zu unveroeffentlichten Audiodateien)
const imageDir = path.join(__dirname, '..', 'public', 'track-images');
if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });

const allowedAudioExtensions = (process.env.ALLOWED_EXTENSIONS || 'flac,wav,mp3')
    .split(',')
    .map((e) => e.trim().toLowerCase());

const allowedImageExtensions = ['jpg', 'jpeg', 'png', 'webp'];

const maxFileSizeBytes = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 300) * 1024 * 1024;
const maxImageSizeBytes = 15 * 1024 * 1024; // 15 MB reicht fuer Cover-Art bei Weitem

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, file.fieldname === 'image' ? imageDir : audioDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const randomName = crypto.randomBytes(16).toString('hex');
        cb(null, `${randomName}${ext}`);
    },
});

function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    // req.t ist ab dem i18next-Middleware-Setup (siehe lib/i18n.js) auf jedem
    // Request verfuegbar, auch innerhalb dieses Multer-Callbacks.

    if (file.fieldname === 'image') {
        if (!allowedImageExtensions.includes(ext)) {
            return cb(new Error(req.t('upload.imageFormatNotAllowed', {
                ext,
                allowed: allowedImageExtensions.join(', '),
            })));
        }
        return cb(null, true);
    }

    if (!allowedAudioExtensions.includes(ext)) {
        return cb(new Error(req.t('upload.fileTypeNotAllowed', {
            ext,
            allowed: allowedAudioExtensions.join(', '),
        })));
    }
    cb(null, true);
}

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: maxFileSizeBytes },
    // Hinweis: Multer kennt kein Pro-Feld-Limit, daher gilt dieses (grosszuegige)
    // Limit technisch auch fuer Bilder. Die tatsaechliche Bildgroessenpruefung
    // erfolgt zusaetzlich manuell ueber validateImageSize() in den Routen.
});

function validateImageSize(req, file) {
    if (file && file.size > maxImageSizeBytes) {
        throw new Error(req.t('upload.imageTooLarge', { max: maxImageSizeBytes / (1024 * 1024) }));
    }
}

module.exports = { upload, audioDir, imageDir, validateImageSize };
