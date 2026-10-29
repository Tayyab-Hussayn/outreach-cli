/**
 * Isolated WhatsApp Baileys Outreach Module
 * Features:
 *  - Persistent Multi-file Auth State (workflows/whatsapp/auth_info/)
 *  - Legitimate Desktop Browser Fingerprinting (Browsers.macOS('Desktop'))
 *  - Stealth Connect (markOnlineOnConnect: false)
 *  - Dynamic Typing Simulation (composing presence with character-based duration)
 *  - Spintax & Zero-Width Invisible Character Hash Variation
 *  - Pre-send sock.onWhatsApp() verification (skips unregistered numbers without getting stuck)
 *  - Two-step message dispatch: proposal text first, then demo video attachment
 *  - Gaussian Jitter Rate Limiting & Human Rest Breaks (batch breaks)
 *  - Circuit Breaker (halts on consecutive failures to protect account)
 *  - Auto-Archiving completed lead file into archives/ subdirectory
 *  - Auto-reconnect on stream drops / network hiccups
 *  - Comprehensive reporting with saveAndPrintReport()
 */

import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';

import {
  renderProposal,
  sanitizePhone,
  verifyWorkflowAssets,
  delayGaussian,
  saveAndPrintReport,
  archiveCompletedLeadsFile,
  updateLeadInYamlFile
} from '../../utils/helpers.js';

/**
 * Runs the WhatsApp Baileys Outreach Workflow
 *
 * @param {Object} options
 * @param {Array<Object>} options.leads - List of lead objects
 * @param {Object} options.config - Parsed settings.yaml
 * @param {string} [options.leadsFilePath] - Original path of the leads file for archiving & in-place status tracking
 * @param {boolean} [options.dryRun=false] - Simulation mode without actually dispatching
 * @param {number|null} [options.limit=null] - Maximum number of pending leads to process in this run
 * @returns {Promise<Object>} Summary results
 */
export async function runWhatsAppWorkflow({ leads, config, leadsFilePath = null, dryRun = false, limit = null }) {
  console.log('\n======================================================');
  console.log('       STARTING WHATSAPP OUTREACH WORKFLOW            ');
  console.log('======================================================\n');

  // 1. Verify Assets (proposal.txt & demo.mp4)
  const assetCheck = verifyWorkflowAssets('whatsapp', config);
  if (!assetCheck.valid) {
    console.error(`\x1b[31m[Asset Error]\x1b[0m ${assetCheck.error}`);
    return { error: assetCheck.error, total: leads.length, sent: 0, failed: leads.length };
  }

  const proposalTemplate = fs.readFileSync(assetCheck.proposalPath, 'utf8');
  const demoVideoPath = assetCheck.demoPath;
  const demoVideoBuffer = fs.readFileSync(demoVideoPath);

  console.log(`✓ Loaded Proposal Template : ${assetCheck.proposalPath}`);
  console.log(`✓ Loaded Demo Video        : ${demoVideoPath} (${demoVideoBuffer.length} bytes)`);

  // Separate pending vs already processed leads
  const allLeads = leads;
  const pendingLeads = allLeads.filter((l) => !l.status || String(l.status).toLowerCase().trim() === 'pending');
  const alreadyProcessedCount = allLeads.length - pendingLeads.length;

  console.log(`\n📋 Lead Queue Status:`);
  console.log(`  - Total Leads in File : ${allLeads.length}`);
  console.log(`  - Already Processed   : ${alreadyProcessedCount} (sent / skipped / invalid)`);
  console.log(`  - Pending Outreach    : \x1b[32m${pendingLeads.length}\x1b[0m`);

  if (pendingLeads.length === 0) {
    console.log(`\n\x1b[32m[All Completed]\x1b[0m All ${allLeads.length} leads in ${leadsFilePath || 'the list'} have already been contacted.`);
    console.log(`No pending leads left to message. Add new leads or reset status to 'pending' to run again.\n`);
    return { total: allLeads.length, pending: 0, sent: 0, completed: true };
  }

  // Determine batch count based on limit or all pending leads
  const batchLimit = (typeof limit === 'number' && limit > 0) ? limit : pendingLeads.length;
  const targetBatch = pendingLeads.slice(0, batchLimit);
  const remainingAfterBatch = pendingLeads.length - targetBatch.length;

  console.log(`\n🚀 Target Batch: Processing \x1b[1m\x1b[32m${targetBatch.length}\x1b[0m pending lead(s)`);
  if (remainingAfterBatch > 0) {
    console.log(`ℹ \x1b[33m${remainingAfterBatch}\x1b[0m pending lead(s) will remain untouched for your next run.`);
  }
  console.log('');

  const spintaxEnabled = config.safety?.anti_fingerprint?.spintax_enabled ?? true;
  const zeroWidthEnabled = config.safety?.anti_fingerprint?.zero_width_hash ?? true;

  // 2. Dry Run Simulation Mode
  if (dryRun) {
    console.log('--- DRY RUN / PREVIEW MODE ACTIVATED ---');
    console.log(`Simulating outreach to the next ${targetBatch.length} pending lead(s) (no messages sent):\n`);
    const simulationRecords = [];
    for (let i = 0; i < targetBatch.length; i++) {
      const lead = targetBatch[i];
      const phoneValidation = sanitizePhone(lead.phone);
      const renderedText = renderProposal(proposalTemplate, lead, {
        enableSpintax: spintaxEnabled,
        enableZeroWidth: zeroWidthEnabled
      });

      console.log(`\n[Simulation ${i + 1}/${targetBatch.length}] Target: ${lead.phone} | Name: ${lead.name || '(unnamed)'}`);
      console.log(`Valid Phone Format: ${phoneValidation.valid ? 'YES (' + phoneValidation.jid + ')' : 'NO'}`);
      console.log('Rendered Proposal (Preview):');
      console.log('--------------------------------------------------');
      console.log(renderedText);
      console.log('--------------------------------------------------');
      if (demoVideoBuffer.length > 0) {
        console.log(`Video Attachment: ${path.basename(demoVideoPath)} (${demoVideoBuffer.length} bytes)`);
      } else {
        console.log(`Video Attachment: [None] demo.mp4 is 0-bytes placeholder`);
      }

      simulationRecords.push({
        ...lead,
        status: phoneValidation.valid ? 'simulated_success' : 'invalid_format'
      });
    }
    console.log('\n--- Simulation Completed Successfully ---');
    console.log(`In a live run, these ${targetBatch.length} leads will be messaged and marked as 'sent' in ${leadsFilePath || 'numbers.yaml'}.`);
    if (remainingAfterBatch > 0) {
      console.log(`${remainingAfterBatch} pending leads will remain queued for future runs.\n`);
    }
    return { total: targetBatch.length, simulated: true };
  }

  // 3. Prepare Baileys Auth State Directory
  const authDir = path.resolve(config.whatsapp?.auth_state_dir || 'workflows/whatsapp/auth_info');
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  console.log('[WhatsApp] Connecting to WhatsApp via Baileys...');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[WhatsApp] Baileys Version: ${version.join('.')} (Latest: ${isLatest})`);

  // Silent logger to avoid polluting stdout
  const logger = pino({ level: 'silent' });

  // Safety Fingerprinting Configuration
  const browserPreset = config.safety?.anti_fingerprint?.browser_preset === 'ubuntu'
    ? Browsers.ubuntu('Chrome')
    : Browsers.macOS('Desktop');
  const stealthConnect = config.safety?.anti_fingerprint?.stealth_connect ?? true;

  console.log(`[Safety] Fingerprint: macOS Desktop | Stealth Connect: ${stealthConnect ? 'ON' : 'OFF'}`);

  return new Promise((resolve) => {
    let hasResolved = false;
    let sock = null;

    const leadRecords = [];
    const summary = {
      total: targetBatch.length,
      sent: 0,
      notOnWhatsApp: 0,
      invalid: 0,
      failed: 0,
      circuitBreakerTripped: false
    };

    function cleanupAndResolve() {
      if (hasResolved) return;
      hasResolved = true;
      if (sock) {
        try {
          sock.ev.removeAllListeners('connection.update');
          sock.ev.removeAllListeners('creds.update');
          sock.end(undefined);
        } catch (_) {}
      }

      // Check if all leads in file are now finished
      const shouldArchive = config.safety?.auto_archive_leads ?? true;
      if (shouldArchive && leadsFilePath && fs.existsSync(leadsFilePath) && !summary.circuitBreakerTripped && remainingAfterBatch === 0) {
        console.log(`\n\x1b[32m[All Leads Completed]\x1b[0m All leads in ${leadsFilePath} have been contacted.`);
        archiveCompletedLeadsFile(leadsFilePath);
      } else if (remainingAfterBatch > 0 && leadsFilePath) {
        console.log(`\n\x1b[36m[Progress Saved]\x1b[0m Updated statuses in ${leadsFilePath}.`);
        console.log(`\x1b[32m${remainingAfterBatch}\x1b[0m pending lead(s) remain ready for your next run!\n`);
      }

      saveAndPrintReport('whatsapp', summary, leadRecords);
      resolve(summary);
    }

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger,
      browser: browserPreset,
      markOnlineOnConnect: !stealthConnect,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Handle Terminal QR Code Display
      if (qr) {
        console.log('\n======================================================');
        console.log('  SCAN THIS QR CODE WITH WHATSAPP TO AUTHENTICATE    ');
        console.log('  (Linked Devices -> Link a Device on your phone)     ');
        console.log('======================================================\n');
        qrcode.generate(qr, { small: true });
        console.log('\nWaiting for authentication scan...\n');
      }

      // Handle Connection Closing / Reconnect logic
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'Connection closed';

        console.log(`[WhatsApp] Connection closed (code: ${statusCode}, reason: ${reason})`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.error('\x1b[31m[WhatsApp Error] Session logged out. Please remove auth_info and re-authenticate.\x1b[0m');
          summary.failed = targetBatch.length - (summary.sent + summary.notOnWhatsApp + summary.invalid);
          cleanupAndResolve();
        } else if (!hasResolved) {
          console.log('[WhatsApp] Temporary disconnect encountered. Reconnecting...');
        }
      }

      // Handle Connection Open -> Run Campaign
      if (connection === 'open') {
        console.log('\x1b[32m✓ WhatsApp Connection Opened Successfully!\x1b[0m\n');

        const minDelay = config.rate_limits?.whatsapp?.min_delay_seconds || 12;
        const maxDelay = config.rate_limits?.whatsapp?.max_delay_seconds || 28;

        // Safety Settings
        const typingConfig = config.safety?.typing_simulation || {};
        const isTypingEnabled = typingConfig.enabled !== false;
        const msPerChar = typingConfig.ms_per_char || 35;
        const minTypingSec = typingConfig.min_duration_seconds || 2;
        const maxTypingSec = typingConfig.max_duration_seconds || 6;

        const batchBreakConfig = config.safety?.batch_break || {};
        const isBatchBreakEnabled = batchBreakConfig.enabled !== false;
        const breakInterval = batchBreakConfig.interval_messages || 5;
        const minRestSec = batchBreakConfig.min_rest_seconds || 60;
        const maxRestSec = batchBreakConfig.max_rest_seconds || 120;

        const circuitConfig = config.safety?.circuit_breaker || {};
        const isCircuitEnabled = circuitConfig.enabled !== false;
        const maxConsecutiveFailures = circuitConfig.max_consecutive_failures || 3;
        let consecutiveFailures = 0;

        for (let i = 0; i < targetBatch.length; i++) {
          const lead = targetBatch[i];
          const currentIndex = i + 1;
          const phoneClean = sanitizePhone(lead.phone);

          console.log(`\n------------------------------------------------------`);
          console.log(`[Batch ${currentIndex}/${targetBatch.length}] Processing: ${lead.phone} (${lead.name || 'Anonymous'})`);

          // Step A: Phone Number Validation
          if (!phoneClean.valid) {
            console.log(`\x1b[33m[INVALID FORMAT] "${lead.phone}" is not a valid international phone number. Skipping.\x1b[0m`);
            leadRecords.push({
              ...lead,
              status: 'INVALID_FORMAT',
              error: 'Invalid phone number format',
              processed_at: new Date().toISOString()
            });
            summary.invalid++;
            if (leadsFilePath) {
              updateLeadInYamlFile(leadsFilePath, lead, {
                status: 'invalid_format',
                processed_at: new Date().toISOString()
              });
            }
            continue;
          }

          // Step B: Pre-Send Registration Verification via sock.onWhatsApp()
          try {
            console.log(`Checking WhatsApp registration for ${phoneClean.jid}...`);
            const onWaResult = await sock.onWhatsApp(phoneClean.jid);
            const isRegistered = Array.isArray(onWaResult) && onWaResult.length > 0 && onWaResult[0].exists;

            if (!isRegistered) {
              console.log(`\x1b[33m[NOT ON WHATSAPP] Phone ${lead.phone} is NOT registered on WhatsApp. Intelligently skipping...\x1b[0m`);
              leadRecords.push({
                ...lead,
                jid: phoneClean.jid,
                status: 'NOT_ON_WHATSAPP',
                processed_at: new Date().toISOString()
              });
              summary.notOnWhatsApp++;
              if (leadsFilePath) {
                updateLeadInYamlFile(leadsFilePath, lead, {
                  status: 'not_on_whatsapp',
                  processed_at: new Date().toISOString()
                });
              }
              continue;
            }

            const targetJid = onWaResult[0].jid || phoneClean.jid;
            const proposalText = renderProposal(proposalTemplate, lead, {
              enableSpintax: spintaxEnabled,
              enableZeroWidth: zeroWidthEnabled
            });

            // Step C: Human Typing Simulation
            if (isTypingEnabled) {
              try {
                await sock.presenceSubscribe(targetJid);
                await sock.sendPresenceUpdate('composing', targetJid);
                const rawMs = Math.round(proposalText.length * msPerChar);
                const typingMs = Math.min(Math.max(rawMs, minTypingSec * 1000), maxTypingSec * 1000);
                console.log(`[Safety] Simulating typing presence for ${(typingMs / 1000).toFixed(1)}s...`);
                await new Promise((r) => setTimeout(r, typingMs));
                await sock.sendPresenceUpdate('paused', targetJid);
              } catch (_) {}
            }

            // Step D: Send Proposal Text First
            console.log(`Sending proposal text to ${targetJid}...`);
            await sock.sendMessage(targetJid, { text: proposalText });
            console.log(`  ✓ Proposal text delivered.`);

            // Short human pause between text and video attachment (1.5 - 2.5s)
            await new Promise((r) => setTimeout(r, 2000));

            // Step E: Send Demo Video (if video file is populated)
            if (demoVideoBuffer.length > 0) {
              console.log(`Sending demo video (${path.basename(demoVideoPath)}) to ${targetJid}...`);
              await sock.sendMessage(targetJid, {
                video: demoVideoBuffer,
                mimetype: 'video/mp4',
                caption: 'Quick demo walkthrough 📹'
              });
              console.log(`  ✓ Demo video delivered.`);
            } else {
              console.log(`  ℹ ${path.basename(demoVideoPath)} is currently empty (0 bytes). Skipped video attachment until real video is added.`);
            }

            console.log(`\x1b[32m[SUCCESS] Outreach completed for ${lead.phone}\x1b[0m`);
            leadRecords.push({
              ...lead,
              jid: targetJid,
              status: 'SENT',
              processed_at: new Date().toISOString()
            });
            summary.sent++;
            consecutiveFailures = 0; // Reset circuit breaker counter on success

            // Immediate real-time persistence
            if (leadsFilePath) {
              updateLeadInYamlFile(leadsFilePath, lead, {
                status: 'sent',
                sent_at: new Date().toISOString()
              });
            }

            // Step F: Human Rest Break (Batch Breaks) or Gaussian Delay
            if (isBatchBreakEnabled && summary.sent > 0 && summary.sent % breakInterval === 0 && i < targetBatch.length - 1) {
              const restSec = Math.floor(Math.random() * (maxRestSec - minRestSec + 1)) + minRestSec;
              console.log(`\n\x1b[36m[HUMAN REST BREAK] Sent ${summary.sent} messages. Taking a ${restSec}s rest break to mimic real human behavior...\x1b[0m`);
              await new Promise((r) => setTimeout(r, restSec * 1000));
            } else if (i < targetBatch.length - 1) {
              console.log(`Applying Gaussian anti-ban delay...`);
              const delayWaited = await delayGaussian(minDelay, maxDelay);
              console.log(`Waited ${(delayWaited / 1000).toFixed(1)}s. Moving to next lead...`);
            }
          } catch (err) {
            console.error(`\x1b[31m[ERROR] Failed dispatch for ${lead.phone}:\x1b[0m`, err.message);
            leadRecords.push({
              ...lead,
              jid: phoneClean.jid,
              status: 'FAILED',
              error: err.message,
              processed_at: new Date().toISOString()
            });
            summary.failed++;
            consecutiveFailures++;

            if (leadsFilePath) {
              updateLeadInYamlFile(leadsFilePath, lead, {
                status: 'failed',
                error: err.message,
                processed_at: new Date().toISOString()
              });
            }

            // Circuit Breaker Check
            if (isCircuitEnabled && consecutiveFailures >= maxConsecutiveFailures) {
              console.error(`\n\x1b[41m\x1b[37m[CIRCUIT BREAKER TRIPPED]\x1b[0m ${consecutiveFailures} consecutive dispatches failed! Halting workflow immediately to protect account.`);
              summary.circuitBreakerTripped = true;
              break;
            }

            // Brief breather on error
            await new Promise((r) => setTimeout(r, 4000));
          }
        }

        console.log('\n[WhatsApp] All leads in batch have been processed.');
        cleanupAndResolve();
      }
    });
  });
}
