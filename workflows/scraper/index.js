/**
 * Google Maps Scraper Integration Module
 * Bridges omkarcloud/google-maps-scraper with Outreach CLI
 * Automatically formats scraped business leads into leads/whatsapp/ or leads/mail/
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import yaml from 'js-yaml';

import { sanitizePhone, classifyPhone, isValidEmail, loadLeadsYaml } from '../../utils/helpers.js';

const SCRIPT_DIR = path.resolve('workflows/scraper');
const RUNNER_SCRIPT = path.join(SCRIPT_DIR, 'runner.py');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');

/**
 * Finds the preferred Python executable (root .venv or system)
 * @returns {string}
 */
function getPythonExecutable() {
  const rootVenvPython = path.resolve('.venv/bin/python3');
  if (fs.existsSync(rootVenvPython)) {
    return rootVenvPython;
  }
  const nestedVenvPython = path.resolve('workflows/scraper/venv/bin/python3');
  if (fs.existsSync(nestedVenvPython)) {
    return nestedVenvPython;
  }
  return 'python3';
}

/**
 * Runs the Google Maps Scraper runner process
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<Array<Object>>} List of scraped places
 */
async function executePythonScraper(query, maxResults = 10) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputFile = path.join(OUTPUT_DIR, `scrape_${timestamp}.json`);
  const pythonBin = getPythonExecutable();

  return new Promise((resolve, reject) => {
    console.log(`\n[Scraper] Launching engine using ${pythonBin}...`);
    console.log(`[Scraper] Query: "${query}" | Limit: ${maxResults}`);

    const proc = spawn(pythonBin, [
      RUNNER_SCRIPT,
      '--query', query,
      '--max', String(maxResults),
      '--output', outputFile
    ]);

    let stdoutData = '';
    let stderrData = '';

    proc.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
      process.stderr.write(chunk);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        if (fs.existsSync(outputFile)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
            return resolve(parsed.places || []);
          } catch (_) {}
        }

        const helpfulHint = stderrData.includes('ImportError') || stderrData.includes('No module named')
          ? '\n\x1b[33m[Hint]\x1b[0m Please run ./setup_scraper.sh to install python scraper dependencies.\n'
          : '';

        return reject(new Error(`Scraper process exited with code ${code}.${helpfulHint}`));
      }

      try {
        if (fs.existsSync(outputFile)) {
          const parsed = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
          resolve(parsed.places || []);
        } else if (stdoutData.trim()) {
          const parsed = JSON.parse(stdoutData.trim());
          resolve(parsed.places || []);
        } else {
          resolve([]);
        }
      } catch (err) {
        reject(new Error(`Failed to parse scraper output: ${err.message}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Appends new leads to target YAML without creating duplicate entries
 * @param {string} yamlPath
 * @param {Array<Object>} newLeads
 * @param {'whatsapp'|'mail'} type
 * @returns {{ added: number, duplicates: number, total: number }}
 */
function appendLeadsToYaml(yamlPath, newLeads, type = 'whatsapp') {
  const absolutePath = path.resolve(yamlPath);
  let existingLeads = [];

  if (fs.existsSync(absolutePath)) {
    try {
      existingLeads = loadLeadsYaml(absolutePath, type);
    } catch (_) {
      existingLeads = [];
    }
  } else {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  }

  // Build existing set of keys to check for duplicates
  const existingKeys = new Set(
    existingLeads
      .map((l) => (type === 'whatsapp' ? sanitizePhone(l.phone).digits : (l.email || '').toLowerCase()))
      .filter(Boolean)
  );

  let addedCount = 0;
  let duplicateCount = 0;
  const toAppend = [];

  for (const lead of newLeads) {
    const key = type === 'whatsapp' ? sanitizePhone(lead.phone).digits : (lead.email || '').toLowerCase();
    if (!key) continue;

    if (existingKeys.has(key)) {
      duplicateCount++;
    } else {
      existingKeys.add(key);
      toAppend.push(lead);
      addedCount++;
    }
  }

  if (toAppend.length > 0) {
    const combined = [...existingLeads, ...toAppend];
    const yamlContent = yaml.dump({ leads: combined }, { indent: 2, lineWidth: -1 });
    fs.writeFileSync(absolutePath, yamlContent, 'utf8');
  }

  return { added: addedCount, duplicates: duplicateCount, total: existingLeads.length + toAppend.length };
}

/**
 * Main Google Maps Scraping Orchestrator
 *
 * @param {Object} options
 * @param {string} options.query - Location / category query (e.g. "Restaurants in DHA Lahore")
 * @param {number} [options.maxResults=10]
 * @param {'whatsapp'|'mail'|'both'} [options.target='both'] - Destination platform flag
 * @param {Object} options.config - Parsed settings.yaml
 * @returns {Promise<Object>}
 */
export async function runScraperWorkflow({ query, maxResults = 10, target = 'both', config }) {
  const targetLabel = target === 'whatsapp' ? 'WhatsApp Leads Only (--whatsapp)' :
                      target === 'mail' ? 'Mail Leads Only (--mail)' :
                      'Both Platforms (WhatsApp & Mail)';

  console.log('\n======================================================');
  console.log('       GOOGLE MAPS LEAD SCRAPING WORKFLOW             ');
  console.log('======================================================');
  console.log(`Target Query    : "${query}"`);
  console.log(`Target Limit    : ${maxResults} places`);
  console.log(`Destination     : \x1b[36m${targetLabel}\x1b[0m`);
  console.log('------------------------------------------------------\n');

  let places = [];
  try {
    places = await executePythonScraper(query, maxResults);
  } catch (err) {
    console.error(`\x1b[31m[Scraper Error]\x1b[0m ${err.message}`);
    return { error: err.message, places: [], whatsappAdded: 0, mailAdded: 0 };
  }

  console.log(`\n✓ Raw Places Fetched: ${places.length}`);

  if (places.length === 0) {
    console.log('[Notice] No businesses found for this query.');
    return { places: [], whatsappAdded: 0, mailAdded: 0 };
  }

  const nowIso = new Date().toISOString();
  const waLeads = [];
  const landlineLeads = [];
  const mailLeads = [];

  for (const p of places) {
    const businessName = p.name || p.title || 'Local Business';
    const ratingStr = p.rating ? `${p.rating}★` : 'great';
    const customNote = `your ${ratingStr} rating on Google Maps`;

    // 1. WhatsApp Lead (requires valid phone)
    if (p.phone) {
      const phoneCheck = sanitizePhone(String(p.phone));
      if (phoneCheck.valid) {
        // Landlines can't receive WhatsApp: keep them in their own file instead of the WhatsApp queue.
        (classifyPhone(String(p.phone)).type === 'landline' ? landlineLeads : waLeads).push({
          phone: p.phone,
          name: businessName,
          company: businessName,
          custom_note: customNote,
          rating: p.rating || null,
          reviews: p.reviews || null,
          address: p.address || null,
          website: p.website || null,
          category: p.main_category || null,
          status: 'pending',
          scraped_from: query,
          scraped_at: nowIso
        });
      }
    }

    // 2. Email Lead (requires email or website domain)
    let emailFound = null;
    if (Array.isArray(p.emails) && p.emails.length > 0) {
      emailFound = p.emails[0];
    } else if (typeof p.email === 'string') {
      emailFound = p.email;
    }

    if (emailFound && isValidEmail(emailFound)) {
      mailLeads.push({
        email: emailFound,
        name: businessName,
        company: businessName,
        custom_note: customNote,
        website: p.website || null,
        status: 'pending',
        scraped_from: query,
        scraped_at: nowIso
      });
    }
  }

  // Target YAML paths from config
  const waYamlPath = config.paths?.leads?.whatsapp || 'leads/whatsapp/numbers.yaml';
  const mailYamlPath = config.paths?.leads?.mail || 'leads/mail/emails.yaml';
  const landlineYamlPath = config.paths?.leads?.landline || 'leads/landline/numbers.yaml';

  let waResult = { added: 0, duplicates: 0, total: 0 };
  let mailResult = { added: 0, duplicates: 0, total: 0 };
  let landlineResult = { added: 0, duplicates: 0, total: 0 };

  // Store according to the specified flag
  if (target === 'whatsapp' || target === 'both') {
    waResult = appendLeadsToYaml(waYamlPath, waLeads, 'whatsapp');
    if (landlineLeads.length > 0) {
      landlineResult = appendLeadsToYaml(landlineYamlPath, landlineLeads, 'whatsapp');
    }
  }

  if (target === 'mail' || target === 'both') {
    mailResult = appendLeadsToYaml(mailYamlPath, mailLeads, 'mail');
  }

  // Save report
  const reportsDir = path.resolve('reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const dateStr = nowIso.replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(reportsDir, `scraper_${dateStr}.yaml`);

  const reportPayload = {
    workflow: 'google-maps-scraper',
    query,
    max_requested: maxResults,
    target_destination: target,
    scraped_at: nowIso,
    summary: {
      raw_places_scraped: places.length,
      whatsapp_leads_added: waResult.added,
      whatsapp_duplicates_skipped: waResult.duplicates,
      whatsapp_total_active: waResult.total,
      landline_leads_added: landlineResult.added,
      landline_duplicates_skipped: landlineResult.duplicates,
      landline_total: landlineResult.total,
      mail_leads_added: mailResult.added,
      mail_duplicates_skipped: mailResult.duplicates,
      mail_total_active: mailResult.total
    },
    sample_scraped_places: places.slice(0, 5)
  };

  fs.writeFileSync(reportPath, yaml.dump(reportPayload, { indent: 2 }), 'utf8');

  // Print Summary
  console.log('\n======================================================');
  console.log('          SCRAPING & LEADS IMPORT SUMMARY             ');
  console.log('======================================================');
  console.log(`  Raw Businesses Found  : ${places.length}`);

  if (target === 'whatsapp' || target === 'both') {
    console.log(`  ✓ Added to WhatsApp   : \x1b[32m+${waResult.added} new lead(s)\x1b[0m (${waResult.duplicates} duplicates skipped)`);
    console.log(`    File: ${waYamlPath} (Active: ${waResult.total})`);
    console.log(`  ☎ Landlines (not WhatsApp) : \x1b[33m${landlineLeads.length} found\x1b[0m -> +${landlineResult.added} saved to ${landlineYamlPath} (${landlineResult.duplicates} duplicates skipped)`);
  } else {
    console.log(`  - WhatsApp Storage    : \x1b[33mSkipped (target set to --mail)\x1b[0m`);
  }

  if (target === 'mail' || target === 'both') {
    console.log(`  ✓ Added to Mail       : \x1b[32m+${mailResult.added} new lead(s)\x1b[0m (${mailResult.duplicates} duplicates skipped)`);
    console.log(`    File: ${mailYamlPath} (Active: ${mailResult.total})`);
  } else {
    console.log(`  - Mail Storage        : \x1b[33mSkipped (target set to --whatsapp)\x1b[0m`);
  }

  console.log('------------------------------------------------------');
  console.log(`  Detailed Report Saved : ${reportPath}`);
  console.log('======================================================\n');

  return reportPayload.summary;
}
