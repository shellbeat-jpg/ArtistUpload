function requireArtist(req, res, next) {
    if (!req.session.artistId) {
        return res.redirect('/login');
    }
    
    // Prüfung im laufenden Betrieb ob der Artist immer noch aktiv ist
     /*
    const artist = db.prepare('SELECT active FROM artists WHERE id = ?').get(req.session.artistId);
    
    if (!artist || artist.active !== 1) {
        // Session zerstören und ausloggen, falls er gesperrt wurde
        req.session.destroy(() => {
            return res.redirect('/login?err=' + encodeURIComponent('Account ist inaktiv.'));
        });
        return;
    }
     */
    
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.adminId) {
        return res.redirect('/admin/login');
    }
    next();
}

module.exports = { requireArtist, requireAdmin };
