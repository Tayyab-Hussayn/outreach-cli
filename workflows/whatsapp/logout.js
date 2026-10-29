/**
 * WhatsApp logout: remove the locally stored Baileys session (creds + keys)
 * so the next /whatsapp run asks for a fresh QR scan.
 */

import fs from 'fs';
import path from 'path';

const KEEP = new Set(['.gitignore']);

export function logoutWhatsApp(config = {}) {
  const authDir = path.resolve(config.whatsapp?.auth_state_dir || 'workflows/whatsapp/auth_info');
  const credsPath = path.join(authDir, 'creds.json');

  if (!fs.existsSync(authDir) || !fs.existsSync(credsPath)) {
    console.log('\x1b[33m[WhatsApp]\x1b[0m No active session found. Nothing to remove.');
    return { removed: 0 };
  }

  // Session files are flat; only delete regular files directly inside authDir.
  let removed = 0;
  for (const entry of fs.readdirSync(authDir, { withFileTypes: true })) {
    if (!entry.isFile() || KEEP.has(entry.name)) continue;
    fs.rmSync(path.join(authDir, entry.name), { force: true });
    removed++;
  }

  console.log(`\x1b[32m[WhatsApp]\x1b[0m Logged out locally: removed ${removed} session file(s) from ${authDir}`);
  console.log('Run \x1b[32m/whatsapp\x1b[0m to link again by scanning a new QR.');
  console.log('\x1b[2mTip: also remove this device on your phone (WhatsApp > Linked devices) to fully unlink it.\x1b[0m');
  return { removed };
}
