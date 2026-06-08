const express         = require('express');
const storage         = require('../services/storage');
const { requireAuth } = require('../middleware/auth');
const router          = express.Router();

// Lista notas de uma conta
router.get('/', requireAuth, (req, res) => {
  const { accountId } = req.query;
  res.json(storage.getNotes(accountId || null));
});

// Cria nota
router.post('/', requireAuth, (req, res) => {
  const { accountId, text } = req.body;
  if (!accountId || !text?.trim()) return res.status(400).json({ error: 'accountId e text obrigatórios.' });
  const note = storage.saveNote(accountId, text);
  res.json(note);
});

// Edita nota
router.put('/:noteId', requireAuth, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Texto obrigatório.' });
  const notes = storage.getNotes(null);
  const note = notes.find(n => n.id === req.params.noteId);
  if (!note) return res.status(404).json({ error: 'Nota não encontrada.' });
  note.text = text.trim();
  note.updatedAt = new Date().toISOString();
  const fs = require('fs');
  const path = require('path');
  const NOTES_FILE = path.join(__dirname, '../data/notes.json');
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
  res.json(note);
});

// Deleta nota
router.delete('/:noteId', requireAuth, (req, res) => {
  storage.deleteNote(req.params.noteId);
  res.json({ ok: true });
});

module.exports = router;
