/**
 * Escapa texto dinâmico (nomes de conta/campanha) para o Markdown legado do
 * Telegram. Sem isso, um nome com `_ * [ \`` desbalanceado quebra o parsing e
 * a mensagem inteira é rejeitada com "can't parse entities".
 * @param {string} s
 */
function mdSafe(s) {
  return String(s ?? '').replace(/([_*[\]`])/g, '\\$1');
}

/**
 * Envia mensagem via Telegram Bot API
 * @param {string} token   - Token do bot gerado pelo BotFather
 * @param {string} chatId  - ID do chat/usuário destino
 * @param {string} message - Texto da mensagem (suporta Markdown)
 */
async function send(token, chatId, message) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  async function post(body) {
    const res = await globalThis.fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    return res.json();
  }

  // 1ª tentativa: com formatação Markdown
  let data = await post({ chat_id: chatId, text: message, parse_mode: 'Markdown' });

  // Fallback: se o Markdown quebrar (nome com _ * [ ` desbalanceado), reenvia
  // em texto puro para garantir a entrega — melhor sem formatação do que não enviar.
  if (!data.ok && /can'?t parse entities/i.test(data.description || '')) {
    data = await post({ chat_id: chatId, text: message });
  }

  if (!data.ok) {
    throw new Error(`Telegram API erro: ${data.description || JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Envia arquivo HTML como documento via Telegram (usa fetch nativo do Node 22)
 */
async function sendDocument(token, chatId, filename, htmlContent, caption) {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const fd  = new FormData();
  fd.set('chat_id',    String(chatId));
  fd.set('document',   new Blob([htmlContent], { type: 'text/html' }), filename);
  fd.set('parse_mode', 'Markdown');
  if (caption) fd.set('caption', caption);

  const res  = await globalThis.fetch(url, { method: 'POST', body: fd });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API erro: ${data.description || JSON.stringify(data)}`);
  return data;
}

module.exports = { send, sendDocument, mdSafe };
