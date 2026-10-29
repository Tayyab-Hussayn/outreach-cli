/**
 * Isolated Gmail Outreach Module
 * Features:
 *  - SMTP Transport via Nodemailer
 *  - Subject & Body parsing from assets/mail/proposal.txt
 *  - Direct demo video attachment (assets/mail/demo.mp4)
 *  - Smart personalization fallback for {name} and {company}
 *  - Spintax variation support for subject and body
 *  - Pre-flight email syntax validation
 *  - Circuit Breaker for SMTP errors
 *  - Auto-Archiving completed lead file into archives/ subdirectory
 *  - Configurable rate limiting / delays
 *  - Reporting via saveAndPrintReport()
 */

import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';

import {
  renderProposal,
  isValidEmail,
  verifyWorkflowAssets,
  delayGaussian,
  saveAndPrintReport,
  archiveCompletedLeadsFile
} from '../../utils/helpers.js';

/**
 * Parses email subject and body from the proposal template file.
 * If line starts with "Subject: ", extracts the subject, otherwise uses default.
 *
 * @param {string} rawTemplate
 * @returns {{ rawSubject: string, rawBody: string }}
 */
function parseEmailTemplate(rawTemplate) {
  const lines = rawTemplate.split('\n');
  let rawSubject = 'Quick question regarding your outreach workflow';
  let bodyStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.toLowerCase().startsWith('subject:')) {
      rawSubject = line.substring(8).trim();
      bodyStartIndex = i + 1;
      break;
    }
  }

  const rawBody = lines.slice(bodyStartIndex).join('\n').trim();
  return { rawSubject, rawBody };
}

/**
 * Runs the Gmail Outreach Workflow
 *
 * @param {Object} options
 * @param {Array<Object>} options.leads - List of lead objects
 * @param {Object} options.config - Parsed settings.yaml
 * @param {string} [options.leadsFilePath] - Original path of the leads file for archiving
 * @param {boolean} [options.dryRun=false] - Simulation mode
 * @returns {Promise<Object>}
 */
export async function runMailWorkflow({ leads, config, leadsFilePath = null, dryRun = false }) {
  console.log('\n======================================================');
  console.log('         STARTING GMAIL OUTREACH WORKFLOW             ');
  console.log('======================================================\n');

  // 1. Verify Assets
  const assetCheck = verifyWorkflowAssets('mail', config);
  if (!assetCheck.valid) {
    console.error(`\x1b[31m[Asset Error]\x1b[0m ${assetCheck.error}`);
    return { error: assetCheck.error, total: leads.length, sent: 0, failed: leads.length };
  }

  const templateContent = fs.readFileSync(assetCheck.proposalPath, 'utf8');
  const demoPath = assetCheck.demoPath;
  const { rawSubject, rawBody } = parseEmailTemplate(templateContent);

  console.log(`✓ Loaded Email Proposal    : ${assetCheck.proposalPath}`);
  console.log(`✓ Default Subject Template : ${rawSubject}`);
  console.log(`✓ Loaded Video Attachment  : ${demoPath} (${fs.statSync(demoPath).size} bytes)`);
  console.log(`✓ Total Leads Queued       : ${leads.length}\n`);

  if (leads.length === 0) {
    console.log('[Notice] No email leads to process.');
    return { total: 0, sent: 0, invalid: 0, failed: 0 };
  }

  const spintaxEnabled = config.safety?.anti_fingerprint?.spintax_enabled ?? true;

  // 2. Dry Run Simulation Mode
  if (dryRun) {
    console.log('--- DRY RUN / PREVIEW MODE ACTIVATED ---');
    const simulationRecords = [];
    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      const valid = isValidEmail(lead.email);
      const subject = renderProposal(rawSubject, lead, { enableSpintax: spintaxEnabled });
      const body = renderProposal(rawBody, lead, { enableSpintax: spintaxEnabled });

      console.log(`\n[Simulation ${i + 1}/${leads.length}] Target: ${lead.email} | Name: ${lead.name || '(skipped)'}`);
      console.log(`Valid Email Syntax: ${valid ? 'YES' : 'NO'}`);
      console.log(`Subject: ${subject}`);
      console.log('Body:');
      console.log('--------------------------------------------------');
      console.log(body);
      console.log('--------------------------------------------------');
      console.log(`Direct Attachment: ${demoPath}`);

      simulationRecords.push({
        ...lead,
        subject,
        status: valid ? 'simulated_success' : 'invalid_format'
      });
    }
    console.log('\n--- Simulation Completed Successfully ---');
    if (leadsFilePath) {
      console.log(`[Archive Info] On live run, completed file would be moved to: ${path.join(path.dirname(leadsFilePath), 'archives')}`);
    }
    console.log('');
    return { total: leads.length, simulated: true };
  }

  // 3. Initialize Nodemailer Transporter
  const smtpConfig = config.smtp || {};
  const user = process.env.SMTP_USER || smtpConfig.auth?.user;
  const pass = process.env.SMTP_PASS || smtpConfig.auth?.pass;
  const host = process.env.SMTP_HOST || smtpConfig.host || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || smtpConfig.port || '465', 10);
  const secure = smtpConfig.secure ?? (port === 465);
  const fromName = smtpConfig.from_name || 'Outreach Team';
  const fromEmail = smtpConfig.from_email || user;

  if (!user || !pass || pass === 'your-app-password') {
    const errorMsg = 'SMTP credentials are not configured! Please update config/settings.yaml or set SMTP_USER and SMTP_PASS in .env';
    console.error(`\x1b[31m[Configuration Error] ${errorMsg}\x1b[0m`);
    return { error: errorMsg, total: leads.length, sent: 0, failed: leads.length };
  }

  console.log(`[Mail] Connecting to SMTP server (${host}:${port}, User: ${user})...`);
  const transporter = nodemailer.createTransporter({
    host,
    port,
    secure,
    auth: { user, pass }
  });

  // Verify SMTP Connection before proceeding
  try {
    await transporter.verify();
    console.log('\x1b[32m✓ SMTP Connection verified successfully!\x1b[0m\n');
  } catch (err) {
    const errorMsg = `SMTP Connection failed: ${err.message}`;
    console.error(`\x1b[31m[SMTP Error] ${errorMsg}\x1b[0m`);
    return { error: errorMsg, total: leads.length, sent: 0, failed: leads.length };
  }

  const minDelay = config.rate_limits?.mail?.min_delay_seconds || 5;
  const maxDelay = config.rate_limits?.mail?.max_delay_seconds || 15;

  const circuitConfig = config.safety?.circuit_breaker || {};
  const isCircuitEnabled = circuitConfig.enabled !== false;
  const maxConsecutiveFailures = circuitConfig.max_consecutive_failures || 3;
  let consecutiveFailures = 0;

  const summary = {
    total: leads.length,
    sent: 0,
    invalid: 0,
    failed: 0,
    circuitBreakerTripped: false
  };
  const leadRecords = [];

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const currentIndex = i + 1;

    console.log(`\n------------------------------------------------------`);
    console.log(`[Lead ${currentIndex}/${leads.length}] Processing: ${lead.email} (${lead.name || 'Anonymous'})`);

    // Validation
    if (!isValidEmail(lead.email)) {
      console.log(`\x1b[33m[INVALID FORMAT] "${lead.email}" is not a valid email address. Skipping.\x1b[0m`);
      leadRecords.push({
        ...lead,
        status: 'INVALID_FORMAT',
        error: 'Invalid email syntax',
        processed_at: new Date().toISOString()
      });
      summary.invalid++;
      continue;
    }

    const personalizedSubject = renderProposal(rawSubject, lead, { enableSpintax: spintaxEnabled });
    const personalizedBody = renderProposal(rawBody, lead, { enableSpintax: spintaxEnabled });

    try {
      const hasAttachment = fs.existsSync(demoPath) && fs.statSync(demoPath).size > 0;
      const mailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        to: lead.email,
        subject: personalizedSubject,
        text: personalizedBody
      };

      if (hasAttachment) {
        mailOptions.attachments = [
          {
            filename: 'demo.mp4',
            path: demoPath
          }
        ];
        console.log(`Sending email to ${lead.email} with demo video attached...`);
      } else {
        console.log(`Sending email to ${lead.email} (text proposal)...`);
      }

      const info = await transporter.sendMail(mailOptions);

      console.log(`\x1b[32m[SUCCESS] Email sent! Message ID: ${info.messageId}\x1b[0m`);
      leadRecords.push({
        ...lead,
        subject: personalizedSubject,
        messageId: info.messageId,
        status: 'SENT',
        processed_at: new Date().toISOString()
      });
      summary.sent++;
      consecutiveFailures = 0;

      // Rate limit delay
      if (i < leads.length - 1) {
        console.log(`Applying rate-limiting delay...`);
        const delayWaited = await delayGaussian(minDelay, maxDelay);
        console.log(`Waited ${(delayWaited / 1000).toFixed(1)}s. Moving to next lead...`);
      }
    } catch (err) {
      console.error(`\x1b[31m[ERROR] Failed to send email to ${lead.email}:\x1b[0m`, err.message);
      leadRecords.push({
        ...lead,
        subject: personalizedSubject,
        status: 'FAILED',
        error: err.message,
        processed_at: new Date().toISOString()
      });
      summary.failed++;
      consecutiveFailures++;

      if (isCircuitEnabled && consecutiveFailures >= maxConsecutiveFailures) {
        console.error(`\n\x1b[41m\x1b[37m[CIRCUIT BREAKER TRIPPED]\x1b[0m ${consecutiveFailures} consecutive email dispatches failed! Halting workflow.`);
        summary.circuitBreakerTripped = true;
        break;
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Auto-archive completed file if enabled and not tripped early
  const shouldArchive = config.safety?.auto_archive_leads ?? true;
  if (shouldArchive && leadsFilePath && fs.existsSync(leadsFilePath) && !summary.circuitBreakerTripped) {
    archiveCompletedLeadsFile(leadsFilePath);
  }

  saveAndPrintReport('mail', summary, leadRecords);
  return summary;
}
