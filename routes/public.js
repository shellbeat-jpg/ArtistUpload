const express = require('express');
const db = require('../db/connection');
const router = express.Router();

router.get('/public/ping', (req, res) => res.send('pong'));

router.get('/public/station-message', (req, res) => {
    try {
        const station = String(req.query.station || '').trim().toLowerCase();
        if (!station) return res.status(400).json({ error: 'missing station' });

        const row = db.prepare('SELECT player_content FROM stations WHERE url_stub = ?').get(station);
        return res.json({ message: row?.player_content || '' });
    } catch (e) {
        return res.status(500).json({ error: 'server error' });
    }
});

module.exports = router;