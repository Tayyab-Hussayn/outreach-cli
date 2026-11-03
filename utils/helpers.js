/**
 * Smart Personalization, Safety & Shared Helpers for Outreach CLI
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Parses and resolves Spintax formatting: {Hi|Hello|Hey} or {Option 1|Option 2}
 * Recursively resolves nested spintax if present.
 *
 * @param {string} text
 * @returns {string}
 */
export function parseSpintax(text) {
  if (typeof text !== 'string') return text;
  const spintaxRegex = /\{([^{}]+)\}/;
  let matches;
  let result = text;
  while ((matches = spintaxRegex.exec(result)) !== null) {
    // If it contains pipe (|), it is spintax
    if (matches[1].includes('|')) {
      const options = matches[1].split('|');
      const choice = options[Math.floor(Math.random() * options.length)];
      result = result.replace(matches[0], choice);
    } else {
      // Not a spintax with options (could be unprocessed variable), stop loop on this to avoid infinite loop
      break;
    }
  }
  return result;
}

/**
 * Injects invisible zero-width unicode characters to make each message payload hash unique.
 * Visually identical, but defeats cryptographic hash identical-message detectors.
 *
 * @param {string} text
 * @returns {string}
 */
export function injectZeroWidthVariation(text) {
  if (typeof text !== 'string') return text;
  const zeroChars = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
  const count = Math.floor(Math.random() * 4) + 1;
  let variation = '';
  for (let i = 0; i < count; i++) {
    variation += zeroChars[Math.floor(Math.random() * zeroChars.length)];
  }
  return text + variation;
}

/**
 * Intelligently renders proposal text with personalization, spintax, and clean fallbacks.
 * If {name} or {company} is missing, it removes the placeholder and adjusts surrounding grammar/punctuation.
 *
 * @param {string} templateText
 * @param {Object} lead
 * @param {Object} [options]
 * @param {boolean} [options.enableSpintax=true]
 * @param {boolean} [options.enableZeroWidth=false]
 * @returns {string}
 */
export function renderProposal(templateText, lead = {}, options = { enableSpintax: true, enableZeroWidth: false }) {
  let text = templateText;

  const name = typeof lead.name === 'string' ? lead.name.trim() : '';
  const company = typeof lead.company === 'string' ? lead.company.trim() : '';
  const restaurantName = company || (name && name !== 'Anonymous' ? name : '');
  const customNote = typeof lead.custom_note === 'string' ? lead.custom_note.trim() : '';

  // 1. Personalize or smartly clean {restaurant name} / {{restaurant name}}
  if (restaurantName) {
    text = text.replace(/\{\{restaurant\s*name\}\}|\{restaurant\s*name\}|\{\{restaurant\}\}|\{restaurant\}/gi, restaurantName);
  } else {
    text = text
      .replace(/(Hi|Hello|Hey|Assalam\s+[ou]\s+Alaikum|Dear)\s+(\{\{restaurant\s*name\}\}|\{restaurant\s*name\}|\{\{restaurant\}\}|\{restaurant\}),/gi, '$1,')
      .replace(/(Hi|Hello|Hey|Assalam\s+[ou]\s+Alaikum|Dear)\s+(\{\{restaurant\s*name\}\}|\{restaurant\s*name\}|\{\{restaurant\}\}|\{restaurant\})/gi, '$1')
      .replace(/\{\{restaurant\s*name\}\}|\{restaurant\s*name\}|\{\{restaurant\}\}|\{restaurant\}/gi, '');
  }

  // 2. Personalize or smartly clean {name} / {{name}}
  if (name) {
    text = text.replace(/\{\{name\}\}|\{name\}/gi, name);
  } else {
    // Smart fallbacks for common greetings when name is not available
    // "Hi {name}," -> "Hi,"
    // "Hello {name}," -> "Hello,"
    // "Assalam u Alaikum {name}," -> "Assalam u Alaikum,"
    // "Hey {name}," -> "Hey,"
    text = text
      .replace(/(Hi|Hello|Hey|Assalam\s+[ou]\s+Alaikum|Dear)\s+(\{\{name\}\}|\{name\}),/gi, '$1,')
      .replace(/(Hi|Hello|Hey|Assalam\s+[ou]\s+Alaikum|Dear)\s+(\{\{name\}\}|\{name\})/gi, '$1')
      .replace(/\{\{name\}\}|\{name\}/gi, '');
  }

  // 3. Personalize or smartly clean {company} / {{company}}
  if (company) {
    text = text.replace(/\{\{company\}\}|\{company\}/gi, company);
  } else {
    // Smart grammar adjustments for missing company
    // "for {company}" -> "for you"
    // "{company} ky lia" -> "apky lia"
    // "at {company}" -> ""
    // "{company} team" -> "your team"
    text = text
      .replace(/for\s+(\{\{company\}\}|\{company\})/gi, 'for you')
      .replace(/(\{\{company\}\}|\{company\})\s+ky\s+lia/gi, 'apky lia')
      .replace(/(\{\{company\}\}|\{company\})\s+ke\s+liye/gi, 'aap ke liye')
      .replace(/\s+at\s+(\{\{company\}\}|\{company\})/gi, '')
      .replace(/at\s+(\{\{company\}\}|\{company\})/gi, '')
      .replace(/(\{\{company\}\}|\{company\})\s+team/gi, 'your team')
      .replace(/(\{\{company\}\}|\{company\})\s*'s/gi, 'your')
      .replace(/\{\{company\}\}|\{company\}/gi, 'your company');
  }

  // 3. Custom note personalization or cleanup
  if (customNote) {
    text = text.replace(/\{\{custom_note\}\}|\{custom_note\}/gi, customNote);
  } else {
    text = text
      .replace(/noticed\s+(\{\{custom_note\}\}|\{custom_note\}),\s*and/gi, 'noticed your impressive work, and')
      .replace(/noticed\s+(\{\{custom_note\}\}|\{custom_note\})/gi, 'noticed your recent work')
      .replace(/\{\{custom_note\}\}|\{custom_note\}/gi, '');
  }

  // 4. Resolve Spintax ({Hi|Hello|Hey}, {best|warm} regards, etc.)
  if (options.enableSpintax !== false) {
    text = parseSpintax(text);
  }

  // Clean up any double spaces, empty punctuation artifacts, and line endings
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ,\s*/g, ', ')
    .replace(/\s+([!?,.])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 5. Injects subtle invisible zero-width variations to prevent identical text hash
  if (options.enableZeroWidth) {
    text = injectZeroWidthVariation(text);
  }

  return text;
}

/**
 * Flexible YAML loader for leads.
 * Handles simple string arrays, object arrays, or { leads: [...] } dictionaries.
 *
 * @param {string} filePath
 * @param {'whatsapp'|'mail'} type
 * @returns {Array<Object>}
 */
export function loadLeadsYaml(filePath, type = 'whatsapp') {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    const examplePath = path.join(path.dirname(absolutePath), path.basename(absolutePath, '.yaml') + '.example.yaml');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, absolutePath);
      console.log(`\x1b[36m[Notice]\x1b[0m Created ${path.basename(absolutePath)} from template example.`);
    } else {
      throw new Error(`Leads file not found at: ${absolutePath}`);
    }
  }

  const fileContent = fs.readFileSync(absolutePath, 'utf8');
  const parsed = yaml.load(fileContent);

  let rawList = [];
  if (Array.isArray(parsed)) {
    rawList = parsed;
  } else if (parsed && Array.isArray(parsed.leads)) {
    rawList = parsed.leads;
  } else if (parsed && typeof parsed === 'object') {
    rawList = Object.values(parsed);
  } else {
    return [];
  }

  // Normalize each lead object
  return rawList.map((item, index) => {
    let lead = {};
    if (typeof item === 'string' || typeof item === 'number') {
      const val = String(item).trim();
      if (type === 'whatsapp') {
        lead.phone = val;
      } else {
        lead.email = val;
      }
    } else if (item && typeof item === 'object') {
      lead = { ...item };
      if (lead.phone) lead.phone = String(lead.phone).trim();
      if (lead.email) lead.email = String(lead.email).trim().toLowerCase();
    }

    // Default fields
    lead.id = lead.id || `lead-${index + 1}`;
    lead.status = lead.status || 'pending';
    return lead;
  });
}

/**
 * Sanitize and format phone number for WhatsApp Baileys.
 * Strips out whitespace, dashes, parentheses, leading '+' and returns digits.
 *
 * @param {string} phone
 * @returns {{ valid: boolean, digits: string, jid: string }}
 */
export function sanitizePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, digits: '', jid: '' };
  }

  // Remove spaces, hyphens, brackets, +, etc.
  const digits = phone.replace(/[^\d]/g, '');

  // Valid international phone number typically has 7 to 15 digits
  if (digits.length < 7 || digits.length > 15) {
    return { valid: false, digits, jid: '' };
  }

  return {
    valid: true,
    digits,
    jid: `${digits}@s.whatsapp.net`
  };
}

/**
 * Classifies a phone number as a WhatsApp-capable mobile or a landline.
 * Numbering rules exist for Pakistan (+92) and the UAE (+971). Numbers from other
 * countries (or without a country code) can't be told apart reliably without a full
 * numbering plan, so they come back as 'unknown' and are kept as WhatsApp candidates
 * (the WhatsApp workflow still pre-verifies every number before sending).
 *
 * Pakistan: mobiles are +92 3XX XXXXXXX; everything else (area codes like 42/21/51,
 *           111 shared-cost UAN lines, 0800 toll-free) is not a WhatsApp number.
 * UAE:      mobiles are +971 5X XXX XXXX; everything else is a landline/service number.
 *
 * @param {string} phone
 * @returns {{ type: 'mobile'|'landline'|'unknown', country: 'PK'|'AE'|null, digits: string }}
 */
export function classifyPhone(phone) {
  const { valid, digits } = sanitizePhone(typeof phone === 'string' ? phone : String(phone ?? ''));
  if (!valid) return { type: 'unknown', country: null, digits };

  if (digits.startsWith('92')) {
    const national = digits.slice(2);
    return { type: /^3\d{9}$/.test(national) ? 'mobile' : 'landline', country: 'PK', digits };
  }
  if (digits.startsWith('971')) {
    const national = digits.slice(3);
    return { type: /^5\d{8}$/.test(national) ? 'mobile' : 'landline', country: 'AE', digits };
  }
  return { type: 'unknown', country: null, digits };
}

/**
 * Validate email address format.
 *
 * @param {string} email
 * @returns {boolean}
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

/**
 * Pre-flight asset validator for WhatsApp and Mail workflows.
 * Verifies that proposal.txt and demo.mp4 exist in the designated assets folder.
 *
 * @param {'whatsapp'|'mail'} workflowType
 * @param {Object} config
 * @returns {{ valid: boolean, proposalPath: string, demoPath: string, error?: string }}
 */
export function verifyWorkflowAssets(workflowType, config = {}) {
  const assetsConfig = config.paths?.assets || {};
  const proposalKey = `${workflowType}_proposal`;
  const demoKey = `${workflowType}_demo`;

  const proposalRel = assetsConfig[proposalKey] || `assets/${workflowType}/proposal.txt`;
  const demoRel = assetsConfig[demoKey] || `assets/${workflowType}/demo.mp4`;

  const proposalPath = path.resolve(proposalRel);
  const demoPath = path.resolve(demoRel);

  if (!fs.existsSync(proposalPath)) {
    return {
      valid: false,
      proposalPath,
      demoPath,
      error: `Missing proposal template: ${proposalPath}`
    };
  }

  const proposalStats = fs.statSync(proposalPath);
  if (proposalStats.size === 0) {
    return {
      valid: false,
      proposalPath,
      demoPath,
      error: `Proposal template file is empty: ${proposalPath}`
    };
  }

  if (!fs.existsSync(demoPath)) {
    return {
      valid: false,
      proposalPath,
      demoPath,
      error: `Missing demo video attachment: ${demoPath}`
    };
  }

  return {
    valid: true,
    proposalPath,
    demoPath
  };
}

/**
 * Gaussian distribution random jitter delay helper.
 * Mimics organic human variance by clustering delays around a bell curve.
 *
 * @param {number} minSeconds
 * @param {number} maxSeconds
 * @returns {Promise<number>} Returns the delay waited in milliseconds
 */
export async function delayGaussian(minSeconds = 12, maxSeconds = 28) {
  const minMs = Math.max(1, minSeconds) * 1000;
  const maxMs = Math.max(minMs, maxSeconds * 1000);
  const mean = (minMs + maxMs) / 2;
  const stdDev = (maxMs - minMs) / 6;

  // Box-Muller transform for normal distribution
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random() || 0.0001;
  const randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.sin(2.0 * Math.PI * u2);
  let delay = Math.round(mean + stdDev * randStdNormal);

  // Clamp within user-configured boundaries
  delay = Math.max(minMs, Math.min(maxMs, delay));

  await new Promise((resolve) => setTimeout(resolve, delay));
  return delay;
}

/**
 * Standard jitter delay fallback
 *
 * @param {number} minSeconds
 * @param {number} maxSeconds
 * @returns {Promise<number>}
 */
export async function delayJitter(minSeconds = 10, maxSeconds = 25) {
  return delayGaussian(minSeconds, maxSeconds);
}

/**
 * Moves completed lead file to an archives/ subdirectory inside the same folder.
 *
 * @param {string} filePath - Path of the processed leads YAML file
 * @returns {string|null} - New archived file path or null on failure
 */
export function archiveCompletedLeadsFile(filePath) {
  try {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      console.warn(`[Archive Warning] File not found to archive: ${absolutePath}`);
      return null;
    }

    const fileDir = path.dirname(absolutePath);
    const archivesDir = path.join(fileDir, 'archives');

    if (!fs.existsSync(archivesDir)) {
      fs.mkdirSync(archivesDir, { recursive: true });
    }

    const ext = path.extname(absolutePath);
    const baseName = path.basename(absolutePath, ext);
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveFilename = `${baseName}_archived_${dateStr}${ext}`;
    const destinationPath = path.join(archivesDir, archiveFilename);

    fs.renameSync(absolutePath, destinationPath);

    console.log(`\n\x1b[32m[ARCHIVED]\x1b[0m Completed file moved to:\n  \x1b[36m${destinationPath}\x1b[0m\n`);
    return destinationPath;
  } catch (err) {
    console.error(`\x1b[31m[Archive Error]\x1b[0m Could not archive ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Saves timestamped YAML report and prints clean color-coded summary in terminal.
 *
 * @param {'whatsapp'|'mail'} workflowType
 * @param {Object} summaryData
 * @param {Array<Object>} leadRecords
 * @returns {string} Saved report file path
 */
export function saveAndPrintReport(workflowType, summaryData, leadRecords = []) {
  const reportsDir = path.resolve('./reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportFilename = `${workflowType}_outreach_${dateStr}.yaml`;
  const reportFilePath = path.join(reportsDir, reportFilename);

  const reportPayload = {
    workflow: workflowType,
    generated_at: now.toISOString(),
    circuit_breaker_tripped: summaryData.circuitBreakerTripped || false,
    summary: {
      total_leads: summaryData.total || leadRecords.length,
      sent_successfully: summaryData.sent || 0,
      not_on_whatsapp: summaryData.notOnWhatsApp || 0,
      invalid_format: summaryData.invalid || 0,
      failed: summaryData.failed || 0
    },
    leads: leadRecords
  };

  fs.writeFileSync(reportFilePath, yaml.dump(reportPayload, { indent: 2 }), 'utf8');

  // Print Terminal Summary
  console.log('\n======================================================');
  console.log(`       OUTREACH REPORT SUMMARY [${workflowType.toUpperCase()}]`);
  console.log('======================================================');
  console.log(`  Total Leads Processed : ${reportPayload.summary.total_leads}`);
  console.log(`  ✓ Sent Successfully   : \x1b[32m${reportPayload.summary.sent_successfully}\x1b[0m`);
  if (workflowType === 'whatsapp') {
    console.log(`  ⚠ Not On WhatsApp     : \x1b[33m${reportPayload.summary.not_on_whatsapp}\x1b[0m`);
  }
  console.log(`  ⚠ Invalid Contact     : \x1b[33m${reportPayload.summary.invalid_format}\x1b[0m`);
  console.log(`  ✗ Failed / Errors     : \x1b[31m${reportPayload.summary.failed}\x1b[0m`);
  if (summaryData.unconfirmed) {
    console.log(`  ? No Receipt Yet      : \x1b[33m${summaryData.unconfirmed}\x1b[0m (accepted by WhatsApp, delivery not confirmed)`);
  }
  if (summaryData.circuitBreakerTripped) {
    console.log(`  \x1b[41m\x1b[37m[CIRCUIT BREAKER]\x1b[0m Run halted early to protect your account.`);
  }
  console.log('------------------------------------------------------');
  console.log(`  Detailed Report Saved : ${reportFilePath}`);
  console.log('======================================================\n');

  return reportFilePath;
}

/**
 * Robust argument parser for workflow commands like /whatsapp and /mail.
 * Supports:
 *   /whatsapp 20
 *   /whatsapp --limit 20
 *   /whatsapp -l 20
 *   /whatsapp --limit=20
 *   /whatsapp --dry-run
 *   /whatsapp -d
 *   /whatsapp custom.yaml 20 --dry-run
 *
 * @param {Array<string>} args
 * @returns {{ isDryRun: boolean, limit: number|null, customFilePath: string|null }}
 */
export function parseWorkflowArgs(args = []) {
  let isDryRun = false;
  let limit = null;
  let customFilePath = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--dry-run' || arg === '-d') {
      isDryRun = true;
    } else if (arg === '--limit' || arg === '-l') {
      if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
        limit = parseInt(args[i + 1], 10);
        i++;
      }
    } else if (arg.startsWith('--limit=')) {
      const val = arg.split('=')[1];
      if (/^\d+$/.test(val)) {
        limit = parseInt(val, 10);
      }
    } else if (/^\d+$/.test(arg)) {
      // Bare number e.g. /whatsapp 20
      limit = parseInt(arg, 10);
    } else if (!arg.startsWith('-')) {
      // Non-flag, non-number string is treated as file path
      customFilePath = arg;
    }
  }

  return { isDryRun, limit, customFilePath };
}

/**
 * Updates a single lead's status/fields in-place inside the YAML leads file.
 * This guarantees real-time persistence after every single message.
 *
 * @param {string} filePath
 * @param {Object} targetLead
 * @param {Object} updates
 * @returns {boolean} True if updated successfully
 */
export function updateLeadInYamlFile(filePath, targetLead, updates) {
  try {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) return false;

    const fileContent = fs.readFileSync(absolutePath, 'utf8');
    const parsed = yaml.load(fileContent);

    let list = [];
    let isObjectWrapper = false;

    if (parsed && Array.isArray(parsed.leads)) {
      list = parsed.leads;
      isObjectWrapper = true;
    } else if (Array.isArray(parsed)) {
      list = parsed;
    } else {
      return false;
    }

    const targetDigits = targetLead.phone ? sanitizePhone(String(targetLead.phone)).digits : null;
    const targetEmail = targetLead.email ? String(targetLead.email).toLowerCase().trim() : null;
    const targetId = targetLead.id || null;

    let found = false;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || typeof item !== 'object') continue;

      let match = false;
      if (targetId && item.id && String(item.id) === String(targetId)) {
        match = true;
      } else if (targetDigits && item.phone) {
        const itemDigits = sanitizePhone(String(item.phone)).digits;
        if (itemDigits && itemDigits === targetDigits) {
          match = true;
        }
      } else if (targetEmail && item.email) {
        if (String(item.email).toLowerCase().trim() === targetEmail) {
          match = true;
        }
      }

      if (match) {
        list[i] = { ...item, ...updates };
        found = true;
        break;
      }
    }

    if (found) {
      const payload = isObjectWrapper ? { leads: list } : list;
      fs.writeFileSync(absolutePath, yaml.dump(payload, { indent: 2, lineWidth: -1 }), 'utf8');
      return true;
    }
  } catch (err) {
    console.warn(`[Warning] Could not update lead in ${filePath}:`, err.message);
  }
  return false;
}

/**
 * Returns summary counts (total, pending, sent, other) for a leads file.
 *
 * @param {string} filePath
 * @param {'whatsapp'|'mail'} type
 * @returns {{ total: number, pending: number, sent: number, other: number, exists: boolean }}
 */
export function getLeadsSummary(filePath, type = 'whatsapp') {
  try {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      return { total: 0, pending: 0, sent: 0, other: 0, exists: false };
    }
    const leads = loadLeadsYaml(absolutePath, type);
    let pending = 0;
    let sent = 0;
    let other = 0;

    for (const lead of leads) {
      const status = String(lead.status || 'pending').toLowerCase().trim();
      if (status === 'pending') {
        pending++;
      } else if (status === 'sent') {
        sent++;
      } else {
        other++;
      }
    }

    return { total: leads.length, pending, sent, other, exists: true };
  } catch (_) {
    return { total: 0, pending: 0, sent: 0, other: 0, exists: false };
  }
}

