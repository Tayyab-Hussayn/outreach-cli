/**
 * WhatsApp logout: remove the locally stored Baileys session (creds + keys)
 * so the next /whatsapp scan starts from a clean slate.
 */

import { getSessionInfo, clearSession } from './session.js';

export function logoutWhatsApp(config = {}) {
  const info = getSessionInfo(config);
  const removed = clearSession(info.authDir);

  if (removed === 0) {
    console.log('\x1b[33m[WhatsApp]\x1b[0m No saved session found. Nothing to remove.');
    return { removed: 0 };
  }

  const who = info.number ? ` (${info.number})` : '';
  console.log(`\x1b[32m[WhatsApp]\x1b[0m Logged out locally${who}: removed ${removed} session file(s) from ${info.authDir}`);
  console.log('Run \x1b[32m/whatsapp scan\x1b[0m to link a WhatsApp account again.');
  console.log('\x1b[2mTip: also remove this device on your phone (WhatsApp > Linked devices) to fully unlink it.\x1b[0m');
  return { removed };
}
