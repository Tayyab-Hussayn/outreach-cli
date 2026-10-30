/**
 * /whatsapp scan: drop any previous session, show a fresh QR code, wait for the
 * phone to link, then save the session and exit. No messages are sent.
 *
 * Handles the post-scan "restart required" disconnect (code 515) by reconnecting,
 * which is what actually completes the pairing.
 */

import fs from 'fs';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';

import { getSessionInfo, clearSession, writeSessionMeta, formatNumber } from './session.js';

const SCAN_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_RECONNECTS = 6;

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function banner(title) {
  console.log('\n======================================================');
  console.log(`  ${title}`);
  console.log('======================================================\n');
}

export async function runWhatsAppScan(config = {}) {
  banner('WHATSAPP LINK  -  SCAN A NEW QR CODE');

  // 1. Logout of whatever was saved before
  const previous = getSessionInfo(config);
  const authDir = previous.authDir;
  if (previous.state !== 'none') {
    const who = previous.number ? ` (${previous.number})` : '';
    console.log(c.y(`Previous session found${who}. Logging it out locally...`));
  }
  const removed = clearSession(authDir);
  if (removed > 0) console.log(c.g(`✓ Removed ${removed} old session file(s)`));
  fs.mkdirSync(authDir, { recursive: true });

  // 2. Fresh auth state
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`✓ WhatsApp Web version : ${version.join('.')}${isLatest ? '' : c.y(' (could not fetch latest, using default)')}`);

  const browser = config.safety?.anti_fingerprint?.browser_preset === 'ubuntu'
    ? Browsers.ubuntu('Chrome')
    : Browsers.macOS('Desktop');
  const logger = pino({ level: 'silent' });

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let sock = null;
    let done = false;
    let qrCount = 0;
    let reconnects = 0;

    const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

    function teardown() {
      if (!sock) return;
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.end(undefined);
      } catch (_) {}
    }

    const timer = setTimeout(
      () => finish(false, `No completed scan within ${SCAN_TIMEOUT_MS / 60000} minutes.`),
      SCAN_TIMEOUT_MS
    );
    const onSigint = () => finish(false, 'Cancelled by user.');
    process.once('SIGINT', onSigint);

    function finish(ok, message = '') {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      teardown();

      if (!ok) {
        const cleaned = clearSession(authDir);
        console.log('\n' + c.r(`✗ Link failed: ${message}`));
        if (cleaned > 0) console.log(c.d(`  (cleaned up ${cleaned} incomplete session file(s))`));
        console.log(`  Run ${c.g('/whatsapp scan')} to try again. On your phone, remove any half-linked entry under Linked devices first.\n`);
      }
      resolve({ ok, message });
    }

    function drawQr(qr) {
      qrCount++;
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
      banner('WHATSAPP LINK  -  SCAN A NEW QR CODE');
      console.log(`  ${c.b('1.')} Open WhatsApp on your phone`);
      console.log(`  ${c.b('2.')} Settings -> Linked devices -> Link a device`);
      console.log(`  ${c.b('3.')} Scan the QR below ${c.d(`(QR #${qrCount}, refreshes by itself every ~20s)`)}\n`);
      qrcode.generate(qr, { small: true });
      console.log(`\n  ⏳ Waiting for scan... ${elapsed()}s elapsed ${c.d('(Ctrl+C to cancel)')}\n`);
    }

    const onUpdate = async ({ connection, lastDisconnect, qr }) => {
      if (done) return;

      if (qr) drawQr(qr);

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'Connection closed';

        if (code === DisconnectReason.loggedOut) {
          finish(false, `WhatsApp refused the link (code ${code}: ${reason}).`);
          return;
        }
        if (reconnects >= MAX_RECONNECTS) {
          finish(false, `Could not connect after ${MAX_RECONNECTS} attempts (last code ${code}: ${reason}).`);
          return;
        }

        reconnects++;
        if (code === DisconnectReason.restartRequired) {
          console.log(c.g('✓ QR scanned - finishing the link...'));
        } else {
          console.log(c.y(`Connection closed (code ${code}). Reconnecting (${reconnects}/${MAX_RECONNECTS})...`));
        }
        setTimeout(() => { if (!done) startSocket(); }, code === DisconnectReason.restartRequired ? 300 : 2000);
        return;
      }

      if (connection === 'open') {
        await saveCreds();
        const number = formatNumber(state.creds.me?.id);
        const name = state.creds.me?.name || null;
        writeSessionMeta(authDir, {
          verified: true,
          linkedAt: new Date().toISOString(),
          number,
          name
        });

        console.log('\n======================================================');
        console.log(c.g(`  ✓ WHATSAPP LINKED  ${number || ''}${name ? ` (${name})` : ''}`));
        console.log('======================================================');
        console.log(`  Session saved in ${authDir}`);
        console.log(`  Next: ${c.g('/whatsapp 1')} to test with a single lead, or ${c.g('/status')} to review.\n`);

        // Let WhatsApp finish the initial key exchange before we close the socket.
        await sleep(4000);
        finish(true);
      }
    };

    function startSocket() {
      teardown();
      sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger,
        browser,
        markOnlineOnConnect: false,
        syncFullHistory: false
      });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', onUpdate);
    }

    console.log(c.d('Connecting to WhatsApp, the QR code will appear in a moment...'));
    startSocket();
  });
}
