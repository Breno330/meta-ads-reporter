const fetch = require('node-fetch');

/**
 * Envia mensagem via CallMeBot WhatsApp API
 * @param {string} phone   - Número com DDI, sem + (ex: 5561999999999)
 * @param {string} apikey  - Chave gerada pelo CallMeBot
 * @param {string} message - Texto da mensagem
 */
async function send(phone, apikey, message) {
  const encoded = encodeURIComponent(message);
  const url     = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encoded}&apikey=${apikey}`;

  const res = await fetch(url);
  const body = await res.text();

  if (!res.ok) {
    throw new Error(`CallMeBot retornou status ${res.status}: ${body}`);
  }

  // CallMeBot retorna "Message queued" quando bem-sucedido
  if (body.toLowerCase().includes('error') || body.toLowerCase().includes('invalid')) {
    throw new Error(`CallMeBot erro: ${body}`);
  }

  return body;
}

module.exports = { send };
