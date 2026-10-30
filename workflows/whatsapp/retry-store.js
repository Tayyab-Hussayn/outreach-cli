/**
 * Retry support for Baileys.
 *
 * When a recipient (or our own phone) fails to decrypt a message, WhatsApp asks us
 * to re-send it. Baileys answers that request through the `getMessage` callback; if it
 * is missing the chat is stuck on "Waiting for this message. This may take a while."
 * This keeps every message we send so the retry can be answered.
 */

const MAX_STORED = 1000;
const sent = new Map();

export function rememberSent(result) {
  const id = result?.key?.id;
  if (!id || !result.message) return;
  sent.set(id, result.message);
  if (sent.size > MAX_STORED) sent.delete(sent.keys().next().value);
}

export async function getMessage(key) {
  return sent.get(key?.id);
}

/** Wrap sock.sendMessage so everything we send is remembered for retries. */
export function attachRetryStore(sock) {
  const original = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const result = await original(...args);
    rememberSent(result);
    return result;
  };
  return sock;
}

// libsignal prints session internals (keys included) through console; keep them out of the log.
const NOISE = /^(Closing session|Opening session|Removing old closed session|Migrating session|Session already (closed|open)|Failed to decrypt message|Session error|Bad MAC)/;
let muted = false;

export function muteSignalNoise() {
  if (muted) return;
  muted = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      if (typeof args[0] === 'string' && NOISE.test(args[0])) return;
      original(...args);
    };
  }
}
