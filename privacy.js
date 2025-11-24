// privacy.js
const express = require('express');
const router = express.Router();

// ================= PRIVACY POLICY PAGE =================
router.get('/', (req, res) => {
    res.render('privacy');
});

module.exports = router;