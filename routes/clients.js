const express      = require('express');
const metaApi      = require('../services/meta-api');
const { requireAuth } = require('../middleware/auth');
const router       = express.Router();

// Lista todas as contas de anúncio acessíveis
router.get('/', requireAuth, async (req, res) => {
  try {
    const accounts = await metaApi.getAdAccounts(req.token);
    res.json(accounts);
  } catch (err) {
    console.error('Erro ao buscar contas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
