function requireArtist(req, res, next) {
    if (!req.session.artistId) {
        return res.redirect('/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.adminId) {
        return res.redirect('/admin/login');
    }
    next();
}

module.exports = { requireArtist, requireAdmin };
