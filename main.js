#!/usr/bin/env node

/**
 * Outreach CLI - Multi-Platform Cold Outreach Automation
 * Interactive REPL Shell with Slash Commands:
 *  - /whatsapp [path/to/numbers.yaml] [--dry-run]
 *  - /mail [path/to/emails.yaml] [--dry-run]
 *  - /status
 *  - /help
 *  - /clear
 *  - /exit
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

import { loadLeadsYaml, parseWorkflowArgs, getLeadsSummary } from './utils/helpers.js';
import { runWhatsAppWorkflow } from './workflows/whatsapp/index.js';
import { logoutWhatsApp } from './workflows/whatsapp/logout.js';
import { runWhatsAppScan } from './workflows/whatsapp/scan.js';
import { getSessionInfo } from './workflows/whatsapp/session.js';
import { runMailWorkflow } from './workflows/mail/index.js';
import { runScraperWorkflow } from './workflows/scraper/index.js';

// Load .env if present
dotenv.config();

const CONFIG_PATH = path.resolve('config/settings.yaml');

/**
 * Ensure required directory structure exists on startup
 */
function ensureDirectories() {
  const dirs = [
    'config',
    'assets/whatsapp',
    'assets/mail',
    'leads',
    'leads/whatsapp',
    'leads/whatsapp/archives',
    'leads/mail',
    'leads/mail/archives',
    'workflows/whatsapp/auth_info',
    'workflows/mail',
    'workflows/scraper/output',
    'reports',
    'utils'
  ];

  for (const dir of dirs) {
    const fullPath = path.resolve(dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }
}

/**
 * Safely load settings.yaml
 * @returns {Object}
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.warn(`[Warning] Configuration file not found at ${CONFIG_PATH}. Using defaults.`);
    return {};
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return yaml.load(raw) || {};
  } catch (err) {
    console.error(`[Error] Failed to parse config/settings.yaml: ${err.message}`);
    return {};
  }
}

/**
 * Display help instructions
 */
function printHelp() {
  console.log(`
\x1b[1m\x1b[36mOUTREACH CLI - Available Slash Commands\x1b[0m
====================================================================
  \x1b[32m/whatsapp\x1b[0m [limit] [file.yaml] [--dry-run]
      Launch WhatsApp outreach via Baileys.
      - Specify batch count: e.g. /whatsapp 20 or /whatsapp --limit 20
      - Next run automatically resumes from remaining pending leads!
      - Updates status in-place (sent, not_on_whatsapp, invalid).
      - Needs a linked account: run /whatsapp scan first.
      - Pre-verifies numbers via sock.onWhatsApp() (skips unregistered).
      - Sends proposal message first, then demo video.
      - Default file: leads/whatsapp/numbers.yaml
      - Flag --dry-run / -d simulates run without sending.

  \x1b[32m/whatsapp scan\x1b[0m
      Link a WhatsApp account: logs out any previous session, shows a fresh QR.
      - Phone: Settings -> Linked devices -> Link a device, then scan.
      - Saves the session and exits. No messages are sent.

  \x1b[32m/whatsapp logout\x1b[0m
      Remove the saved WhatsApp session (creds) from this machine.
      - Then use /whatsapp scan to link an account again.

  \x1b[32m/mail\x1b[0m [limit] [file.yaml] [--dry-run]
      Launch Gmail outreach via Nodemailer (SMTP).
      - Specify batch count: e.g. /mail 20 or /mail --limit 20
      - Next run automatically resumes from remaining pending leads!
      - Sends personalized subject & body with demo.mp4 attached.
      - Default file: leads/mail/emails.yaml
      - Flag --dry-run / -d simulates run without sending.

  \x1b[32m/scrape\x1b[0m <"query"> [limit] [--whatsapp | --mail]
      Find businesses & companies across geolocation via Google Maps Scraper.
      - Flags:
          --whatsapp, -w  : Save all phone leads ONLY to leads/whatsapp/numbers.yaml (no split); landlines go to leads/landline/numbers.yaml
          --mail, -m      : Save all email leads ONLY to leads/mail/emails.yaml (no split)
          --both, -b      : Save to both WhatsApp & Mail (default)
      - Deduplicates entries so existing leads are never duplicated.
      - Examples:
          /scrape "Restaurants in DHA Lahore" 30 --whatsapp
          /scrape "Digital marketing agencies in Dubai" 20 --mail
          /scrape "Software companies in Lahore" 15

  \x1b[32m/status\x1b[0m
      Display health status of configs, assets, leads, and auth state.

  \x1b[32m/clear\x1b[0m
      Clear the terminal screen.

  \x1b[32m/help\x1b[0m
      Show this command reference.

  \x1b[32m/exit\x1b[0m
      Exit the interactive outreach shell.
====================================================================
`);
}

/**
 * Print detailed status overview
 * @param {Object} config
 */
function printStatus(config) {
  console.log('\n\x1b[1m\x1b[36m=== OUTREACH CLI SYSTEM STATUS ===\x1b[0m');

  // Config check
  const hasConfig = fs.existsSync(CONFIG_PATH);
  console.log(`Configuration : ${hasConfig ? '\x1b[32mFOUND\x1b[0m' : '\x1b[31mMISSING\x1b[0m'} (${CONFIG_PATH})`);

  // WhatsApp Auth Session
  const authDir = path.resolve(config.whatsapp?.auth_state_dir || 'workflows/whatsapp/auth_info');
  const wa = getSessionInfo(config);
  const waLine = wa.state === 'linked'
    ? `\x1b[32mLINKED\x1b[0m as ${wa.number || 'unknown'}${wa.name ? ` (${wa.name})` : ''}`
    : wa.state === 'unverified'
      ? `\x1b[33mUNVERIFIED session\x1b[0m (${wa.number || 'unknown'}) - run /whatsapp scan`
      : '\x1b[33mNOT LINKED\x1b[0m - run /whatsapp scan';
  console.log(`WhatsApp Auth : ${waLine}`);

  // Assets Check
  const waProp = path.resolve(config.paths?.assets?.whatsapp_proposal || 'assets/whatsapp/proposal.txt');
  const waDemo = path.resolve(config.paths?.assets?.whatsapp_demo || 'assets/whatsapp/demo.mp4');
  const mailProp = path.resolve(config.paths?.assets?.mail_proposal || 'assets/mail/proposal.txt');
  const mailDemo = path.resolve(config.paths?.assets?.mail_demo || 'assets/mail/demo.mp4');

  console.log('\nAssets:');
  console.log(`  - WhatsApp Proposal : ${fs.existsSync(waProp) ? '\x1b[32mOK\x1b[0m' : '\x1b[31mMISSING\x1b[0m'} (${waProp})`);
  console.log(`  - WhatsApp Demo     : ${fs.existsSync(waDemo) ? '\x1b[32mOK\x1b[0m' : '\x1b[31mMISSING\x1b[0m'} (${waDemo})`);
  console.log(`  - Mail Proposal     : ${fs.existsSync(mailProp) ? '\x1b[32mOK\x1b[0m' : '\x1b[31mMISSING\x1b[0m'} (${mailProp})`);
  console.log(`  - Mail Demo         : ${fs.existsSync(mailDemo) ? '\x1b[32mOK\x1b[0m' : '\x1b[31mMISSING\x1b[0m'} (${mailDemo})`);

  // Leads Check
  const waLeadsPath = path.resolve(config.paths?.leads?.whatsapp || 'leads/whatsapp/numbers.yaml');
  const mailLeadsPath = path.resolve(config.paths?.leads?.mail || 'leads/mail/emails.yaml');

  const waSum = getLeadsSummary(waLeadsPath, 'whatsapp');
  const mailSum = getLeadsSummary(mailLeadsPath, 'mail');

  const waArchivesDir = path.resolve('leads/whatsapp/archives');
  const mailArchivesDir = path.resolve('leads/mail/archives');
  const waArchivedCount = fs.existsSync(waArchivesDir) ? fs.readdirSync(waArchivesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).length : 0;
  const mailArchivedCount = fs.existsSync(mailArchivesDir) ? fs.readdirSync(mailArchivesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).length : 0;

  console.log('\nLeads Queued:');
  console.log(`  - WhatsApp Leads    : \x1b[32m${waSum.pending} pending\x1b[0m (${waSum.sent} sent, ${waSum.total} total) in ${waLeadsPath} (${waArchivedCount} archived files)`);
  console.log(`  - Mail Leads        : \x1b[32m${mailSum.pending} pending\x1b[0m (${mailSum.sent} sent, ${mailSum.total} total) in ${mailLeadsPath} (${mailArchivedCount} archived files)`);

  // Scraper Engine Check
  const scraperEngineDir = path.resolve('workflows/scraper/engine');
  const scraperVenv = path.resolve('.venv/bin/python3');
  const hasScraper = fs.existsSync(scraperEngineDir);
  const hasVenv = fs.existsSync(scraperVenv);
  console.log(`\nGoogle Maps Scraper:`);
  console.log(`  - Engine Module     : ${hasScraper ? '\x1b[32mREADY (omkarcloud/google-maps-scraper)\x1b[0m' : '\x1b[31mMISSING\x1b[0m'}`);
  console.log(`  - Python Env        : ${hasVenv ? '\x1b[32mCONFIGURED (.venv active)\x1b[0m' : '\x1b[33mRUN ./setup_scraper.sh to install python dependencies\x1b[0m'}`);

  // Reports
  const reportsDir = path.resolve('reports');
  const reports = fs.existsSync(reportsDir)
    ? fs.readdirSync(reportsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    : [];
  console.log(`\nReports History : ${reports.length} report(s) generated in reports/\n`);
}

/**
 * Tab-completion function for readline
 */
function completer(line) {
  const completions = ['/whatsapp', '/whatsapp scan', '/whatsapp logout', '/mail', '/scrape', '/status', '/help', '/clear', '/exit'];
  const hits = completions.filter((c) => c.startsWith(line.trim()));
  return [hits.length ? hits : completions, line];
}

/**
 * Main Interactive REPL Loop
 */
async function runCli() {
  ensureDirectories();
  let config = loadConfig();

  // Support direct execution via CLI args e.g. ./cli.sh /whatsapp 20
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length > 0) {
    let rawCommand = cliArgs.join(' ');
    if (!rawCommand.startsWith('/')) rawCommand = '/' + rawCommand;
    const [cmd, ...args] = rawCommand.split(/\s+/);
    const { isDryRun, limit, customFilePath } = parseWorkflowArgs(args);

    try {
      switch (cmd) {
        case '/whatsapp': {
          if (args[0]?.toLowerCase() === 'logout') {
            logoutWhatsApp(config);
            break;
          }
          if (args[0]?.toLowerCase() === 'scan') {
            await runWhatsAppScan(config);
            break;
          }
          const targetFile = customFilePath || config.paths?.leads?.whatsapp || 'leads/whatsapp/numbers.yaml';
          console.log(`\nLoading WhatsApp leads from: ${targetFile}`);
          if (limit) console.log(`\x1b[36m[Limit Specified]\x1b[0m Batch limit: \x1b[1m${limit}\x1b[0m pending lead(s) for this run.`);
          let leads = loadLeadsYaml(targetFile, 'whatsapp');
          if (isDryRun) console.log('\x1b[33m[Mode: Dry-Run / Preview]\x1b[0m');
          await runWhatsAppWorkflow({ leads, config, leadsFilePath: targetFile, dryRun: isDryRun, limit });
          break;
        }
        case '/mail': {
          const targetFile = customFilePath || config.paths?.leads?.mail || 'leads/mail/emails.yaml';
          console.log(`\nLoading Mail leads from: ${targetFile}`);
          if (limit) console.log(`\x1b[36m[Limit Specified]\x1b[0m Batch limit: \x1b[1m${limit}\x1b[0m pending lead(s) for this run.`);
          let leads = loadLeadsYaml(targetFile, 'mail');
          if (isDryRun) console.log('\x1b[33m[Mode: Dry-Run / Preview]\x1b[0m');
          await runMailWorkflow({ leads, config, leadsFilePath: targetFile, dryRun: isDryRun, limit });
          break;
        }
        case '/status': {
          printStatus(config);
          break;
        }
        default: {
          console.log(`Unknown CLI command: ${cmd}`);
        }
      }
    } catch (err) {
      console.error(`\x1b[31m[Error]\x1b[0m ${err.message}`);
    }
    process.exit(0);
  }

  console.log('\x1b[1m\x1b[34m');
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║               OUTREACH CLI - MULTI-PLATFORM AUTOMATION            ║');
  console.log('║       WhatsApp (Baileys) & Gmail Cold Outreach Engine (Node.js)   ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  console.log('\x1b[0m');
  console.log('Type \x1b[32m/help\x1b[0m for available commands or \x1b[32m/status\x1b[0m to check system status.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
    prompt: '\x1b[1m\x1b[35moutreach>\x1b[0m '
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const rawInput = line.trim();
    if (!rawInput) {
      rl.prompt();
      return;
    }

    const [cmd, ...args] = rawInput.split(/\s+/);
    const { isDryRun, limit, customFilePath } = parseWorkflowArgs(args);

    // Pause readline input while running workflows
    rl.pause();

    try {
      switch (cmd) {
        case '/whatsapp': {
          if (args[0]?.toLowerCase() === 'logout') {
            logoutWhatsApp(config);
            break;
          }
          if (args[0]?.toLowerCase() === 'scan') {
            await runWhatsAppScan(config);
            break;
          }
          config = loadConfig();
          const targetFile = customFilePath || config.paths?.leads?.whatsapp || 'leads/whatsapp/numbers.yaml';
          console.log(`\nLoading WhatsApp leads from: ${targetFile}`);
          if (limit) {
            console.log(`\x1b[36m[Limit Specified]\x1b[0m Batch limit: \x1b[1m${limit}\x1b[0m pending lead(s) for this run.`);
          }

          let leads = [];
          try {
            leads = loadLeadsYaml(targetFile, 'whatsapp');
          } catch (err) {
            console.error(`\x1b[31m[Error]\x1b[0m ${err.message}`);
            break;
          }

          if (isDryRun) {
            console.log('\x1b[33m[Mode: Dry-Run / Preview]\x1b[0m');
          }

          await runWhatsAppWorkflow({
            leads,
            config,
            leadsFilePath: targetFile,
            dryRun: isDryRun,
            limit
          });
          break;
        }

        case '/mail': {
          config = loadConfig();
          const targetFile = customFilePath || config.paths?.leads?.mail || 'leads/mail/emails.yaml';
          console.log(`\nLoading Mail leads from: ${targetFile}`);
          if (limit) {
            console.log(`\x1b[36m[Limit Specified]\x1b[0m Batch limit: \x1b[1m${limit}\x1b[0m pending lead(s) for this run.`);
          }

          let leads = [];
          try {
            leads = loadLeadsYaml(targetFile, 'mail');
          } catch (err) {
            console.error(`\x1b[31m[Error]\x1b[0m ${err.message}`);
            break;
          }

          if (isDryRun) {
            console.log('\x1b[33m[Mode: Dry-Run / Preview]\x1b[0m');
          }

          await runMailWorkflow({
            leads,
            config,
            leadsFilePath: targetFile,
            dryRun: isDryRun,
            limit
          });
          break;
        }

        case '/scrape': {
          config = loadConfig();
          const lineWithoutCmd = rawInput.replace(/^\/scrape\s*/, '').trim();
          if (!lineWithoutCmd) {
            console.log('\x1b[33m[Usage]\x1b[0m /scrape <"query"> [limit] [--whatsapp | --mail]');
            console.log('Examples:');
            console.log('  /scrape "Restaurants in DHA Lahore" 30 --whatsapp');
            console.log('  /scrape "Digital marketing agencies in Dubai" 15 --mail\n');
            break;
          }

          // Detect destination flag (--whatsapp / -w, --mail / -m, --both)
          let target = 'both';
          if (/(?:^|\s)(--whatsapp|-w)(?:\s|$)/i.test(lineWithoutCmd)) {
            target = 'whatsapp';
          } else if (/(?:^|\s)(--mail|--email|-m)(?:\s|$)/i.test(lineWithoutCmd)) {
            target = 'mail';
          } else if (/(?:^|\s)(--both|-b)(?:\s|$)/i.test(lineWithoutCmd)) {
            target = 'both';
          }

          // Strip flags to parse query and limit cleanly
          const cleanedArgs = lineWithoutCmd
            .replace(/(?:^|\s)(--whatsapp|-w|--mail|--email|-m|--both|-b)(?:\s|$)/gi, ' ')
            .trim();

          let query = '';
          let limit = 10;

          const quoteMatch = cleanedArgs.match(/^["']([^"']+)["']\s*(\d*)$/);
          if (quoteMatch) {
            query = quoteMatch[1];
            if (quoteMatch[2]) limit = parseInt(quoteMatch[2], 10);
          } else {
            const tokens = cleanedArgs.split(/\s+/);
            const lastToken = tokens[tokens.length - 1];
            if (/^\d+$/.test(lastToken) && tokens.length > 1) {
              limit = parseInt(lastToken, 10);
              query = tokens.slice(0, -1).join(' ');
            } else {
              query = cleanedArgs;
            }
          }

          await runScraperWorkflow({ query, maxResults: limit, target, config });
          break;
        }

        case '/status': {
          config = loadConfig();
          printStatus(config);
          break;
        }

        case '/clear': {
          console.clear();
          break;
        }

        case '/help': {
          printHelp();
          break;
        }

        case '/exit':
        case 'exit':
        case 'quit':
        case '/quit': {
          console.log('\nExiting Outreach CLI. Goodbye!\n');
          rl.close();
          process.exit(0);
          break;
        }

        default: {
          console.log(`\x1b[31mUnknown command:\x1b[0m "${rawInput}". Type \x1b[32m/help\x1b[0m for available commands.`);
          break;
        }
      }
    } catch (unexpectedErr) {
      console.error(`\x1b[31m[Fatal Error]\x1b[0m ${unexpectedErr.message}`);
    } finally {
      // Resume readline
      rl.resume();
      rl.prompt();
    }
  });

  rl.on('close', () => {
    console.log('\nSession closed. Goodbye!\n');
    process.exit(0);
  });
}

runCli();
