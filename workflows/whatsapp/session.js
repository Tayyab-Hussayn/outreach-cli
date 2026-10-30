/**
 * WhatsApp session helpers shared by /whatsapp, /whatsapp scan, /whatsapp logout and /status.
 *
 * Baileys keeps its session as flat files in auth_info/. Whether a saved session is
 * still accepted can only be known by WhatsApp's server (401 = revoked), so we keep a
 * small marker file (session-meta.json) that is written only after a login really
 * succeeded. "linked" = marker present, "unverified" = creds without marker
 * (e.g. an interrupted/failed pairing), "none" = no creds at all.
 */

import fs from 'fs';
import path from 'path';

const META_FILE = 'session-meta.json';
const KEEP = new Set(['.gitignore']);

export function resolveAuthDir(config = {}) {
  return path.resolve(config.whatsapp?.auth_state_dir || 'workflows/whatsapp/auth_info');
}

export function formatNumber(jid) {
  const m = String(jid || '').match(/^(\d+)/);
  return m ? `+${m[1]}` : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

export function getSessionInfo(config = {}) {
  const authDir = resolveAuthDir(config);
  const credsPath = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsPath)) return { state: 'none', authDir };

  const creds = readJson(credsPath);
  const meta = readJson(path.join(authDir, META_FILE));
  return {
    state: meta?.verified ? 'linked' : 'unverified',
    authDir,
    number: formatNumber(creds?.me?.id) || meta?.number || null,
    name: creds?.me?.name || meta?.name || null,
    linkedAt: meta?.linkedAt || null
  };
}

/** Delete session files (flat files only; .gitignore is kept). Returns how many were removed. */
export function clearSession(authDir) {
  if (!fs.existsSync(authDir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(authDir, { withFileTypes: true })) {
    if (!entry.isFile() || KEEP.has(entry.name)) continue;
    fs.rmSync(path.join(authDir, entry.name), { force: true });
    removed++;
  }
  return removed;
}

/** Merge fields into the marker file. */
export function writeSessionMeta(authDir, data) {
  const file = path.join(authDir, META_FILE);
  fs.writeFileSync(file, JSON.stringify({ ...(readJson(file) || {}), ...data }, null, 2));
}

/** Forget that the session was verified (e.g. WhatsApp answered 401). */
export function invalidateSession(authDir) {
  fs.rmSync(path.join(authDir, META_FILE), { force: true });
}
