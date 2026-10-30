/**
 * Reusable WhatsApp connection for workflows that only need a live socket
 * (e.g. /followup). Uses the session saved by /whatsapp scan.
 *
 * Resolves with a handle once the connection is open:
 *   handle.sock       current socket (replaced transparently on reconnect)
 *   handle.connected  true while the connection is open
 *   handle.loggedOut  true if WhatsApp revoked the session
 *   handle.close()    tear everything down
 *
 * Rejects (error.loggedOut === true on 401) if it cannot connect.
 */

import pino from 'pino';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';

import { resolveAuthDir, invalidateSession, writeSessionMeta } from './session.js';
import { getMessage, attachRetryStore, muteSignalNoise } from './retry-store.js';
muteSignalNoise();

const MAX_RECONNECTS = 5;

export async function connectWhatsApp(config = {}) {
  const authDir = resolveAuthDir(config);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const browser = config.safety?.anti_fingerprint?.browser_preset === 'ubuntu'
    ? Browsers.ubuntu('Chrome')
    : Browsers.macOS('Desktop');
  const stealth = config.safety?.anti_fingerprint?.stealth_connect ?? true;
  const timeoutMs = config.whatsapp?.connection_timeout_ms || 60000;

  return new Promise((resolve, reject) => {
    let opened = false;
    let attempts = 0;

    const handle = {
      sock: null,
      connected: false,
      loggedOut: false,
      failed: false,
      closed: false,
      close() {
        handle.closed = true;
        handle.connected = false;
        clearTimeout(timer);
        detach();
      }
    };

    function detach() {
      if (!handle.sock) return;
      try {
        handle.sock.ev.removeAllListeners('connection.update');
        handle.sock.ev.removeAllListeners('creds.update');
        handle.sock.end(undefined);
      } catch (_) {}
    }

    const timer = setTimeout(() => {
      if (opened) return;
      handle.close();
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while connecting to WhatsApp.`));
    }, timeoutMs);

    const onUpdate = ({ connection, lastDisconnect }) => {
      if (handle.closed) return;

      if (connection === 'open') {
        handle.connected = true;
        attempts = 0;
        try { writeSessionMeta(authDir, { lastConnectedAt: new Date().toISOString() }); } catch (_) {}
        if (!opened) {
          opened = true;
          clearTimeout(timer);
          resolve(handle);
        }
        return;
      }

      if (connection !== 'close') return;
      handle.connected = false;

      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'Connection closed';

      if (code === DisconnectReason.loggedOut) {
        invalidateSession(authDir);
        handle.loggedOut = true;
        if (!opened) {
          handle.close();
          reject(Object.assign(new Error(`WhatsApp rejected the saved session (code ${code}: ${reason}).`), { loggedOut: true, code }));
        }
        return;
      }

      if (attempts >= MAX_RECONNECTS) {
        handle.failed = true;
        if (!opened) {
          handle.close();
          reject(Object.assign(new Error(`Could not connect after ${MAX_RECONNECTS} attempts (last code ${code}: ${reason}).`), { code }));
        }
        return;
      }

      attempts++;
      setTimeout(() => { if (!handle.closed) start(); }, code === DisconnectReason.restartRequired ? 300 : 3000);
    };

    function start() {
      detach();
      handle.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger,
        browser,
        markOnlineOnConnect: !stealth,
        syncFullHistory: false,
        getMessage
      });
      attachRetryStore(handle.sock);
      handle.sock.ev.on('creds.update', saveCreds);
      handle.sock.ev.on('connection.update', onUpdate);
    }

    start();
  });
}
