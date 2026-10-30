/**
 * /followup "message" [-w] [file.yaml] [--limit N] [--dry-run] [--yes]
 *
 * Sends a follow-up text to leads that were already contacted (status: sent).
 * By default the leads come from the archives folder (leads/whatsapp/archives/),
 * where finished lead files are moved. A specific file can be given instead
 * (an archived file name is also looked up inside the archives folder).
 *
 * Safety is the same as /whatsapp: registration check, typing simulation,
 * gaussian delays, rest breaks and the circuit breaker. Each lead records
 * followup_sent_at / followup_count / followup_hash, so re-running the same
 * message never messages the same person twice.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import yaml from 'js-yaml';

import {
  renderProposal,
  sanitizePhone,
  loadLeadsYaml,
  updateLeadInYamlFile
} from '../../utils/helpers.js';
import { getSessionInfo } from './session.js';
import { connectWhatsApp } from './connect.js';
import {
  getHumanConfig,
  humanSendText,
  lookupGap,
  createPacer,
  isRiskSignal,
  runPreflight,
  recordSent,
  estimateSeconds
} from './human.js';

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  cy: (s) => `\x1b[36m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`
};

const USAGE = [
  `${c.y('[Usage]')} /followup "your message" [-w] [file.yaml] [--limit N] [--dry-run] [--yes]`,
  '  /followup "Assalam u Alaikum, kya aap ne hamara proposal dekha?" -w',
  '  /followup "Reminder: demo abhi bhi available hai" -w numbers_archived_2026-10-30T10-00-00.yaml',
  '  Default source: leads/whatsapp/archives/ (leads with status "sent").'
].join('\n');

// ---------- argument parsing ----------

/** Split on whitespace but keep "double", 'single' and “smart” quoted text together. */
export function tokenize(str) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
  }
  return tokens;
}

/** input: raw text after the command (interactive) or an argv token array (direct). */
export function parseFollowupArgs(input) {
  const tokens = Array.isArray(input) ? input : tokenize(String(input || ''));
  const out = { message: '', file: null, channel: 'whatsapp', dryRun: false, limit: null, yes: false, error: null };
  const words = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-w' || t === '--whatsapp') out.channel = 'whatsapp';
    else if (t === '-m' || t === '--mail' || t === '--email') out.channel = 'mail';
    else if (t === '-d' || t === '--dry-run') out.dryRun = true;
    else if (t === '-y' || t === '--yes') out.yes = true;
    else if (t === '-l' || t === '--limit') {
      if (/^\d+$/.test(tokens[i + 1] || '')) out.limit = parseInt(tokens[++i], 10);
      else out.error = '--limit needs a number, e.g. --limit 10';
    } else if (t.startsWith('--limit=')) {
      const v = t.split('=')[1];
      if (/^\d+$/.test(v)) out.limit = parseInt(v, 10);
      else out.error = '--limit needs a number, e.g. --limit=10';
    } else if (/^\S+\.ya?ml$/i.test(t)) out.file = t;
    else if (/^-{1,2}[a-z][a-z-]*$/i.test(t)) out.error = `Unknown option "${t}"`;
    else words.push(t);
  }

  out.message = words.join(' ').replace(/\\n/g, '\n').trim();
  return out;
}

/** y/N prompt. Reuses the shell's readline when given, otherwise opens a temporary one. */
export function promptYesNo(question, rl = null) {
  return new Promise((resolve) => {
    const own = !rl;
    const iface = rl || readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!own) iface.resume();
    iface.question(question, (answer) => {
      if (own) iface.close();
      else iface.pause();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

// ---------- lead sources ----------

function archivesDirOf(config) {
  const active = path.resolve(config.paths?.leads?.whatsapp || 'leads/whatsapp/numbers.yaml');
  return path.join(path.dirname(active), 'archives');
}

function resolveSourceFiles(file, config) {
  const archivesDir = archivesDirOf(config);

  if (file) {
    const candidates = [path.resolve(file), path.join(archivesDir, file), path.join(archivesDir, path.basename(file))];
    const found = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!found) {
      return { error: `Leads file not found: ${file}\n  Looked in: ${candidates.join('\n             ')}` };
    }
    return { files: [found], archivesDir };
  }

  if (!fs.existsSync(archivesDir)) return { files: [], archivesDir };
  const files = fs.readdirSync(archivesDir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => path.join(archivesDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); // newest first
  return { files, archivesDir };
}

function collectLeads(files, hash) {
  const stats = { files: files.length, total: 0, notSent: 0, invalid: 0, duplicate: 0, alreadyDone: 0 };
  const eligible = [];
  const seen = new Set();

  for (const file of files) {
    let leads = [];
    try {
      leads = loadLeadsYaml(file, 'whatsapp');
    } catch (err) {
      console.log(c.y(`⚠ Skipping ${path.basename(file)}: ${err.message}`));
      continue;
    }

    for (const lead of leads) {
      stats.total++;
      if (String(lead.status || '').toLowerCase().trim() !== 'sent') { stats.notSent++; continue; }
      const phone = sanitizePhone(String(lead.phone ?? ''));
      if (!phone.valid) { stats.invalid++; continue; }
      if (seen.has(phone.digits)) { stats.duplicate++; continue; }
      seen.add(phone.digits);
      if (lead.followup_sent_at && lead.followup_hash === hash) { stats.alreadyDone++; continue; }
      eligible.push({ lead, file, phone });
    }
  }
  return { eligible, stats };
}

// ---------- workflow ----------

function banner(title) {
  console.log('\n======================================================');
  console.log(`  ${title}`);
  console.log('======================================================\n');
}

function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  return m < 1 ? '< 1 min' : m < 90 ? `~${m} min` : `~${(m / 60).toFixed(1)} h`;
}

export async function runWhatsAppFollowup(opts = {}) {
  const {
    message = '', file = null, channel = 'whatsapp', dryRun = false, limit = null,
    yes = false, error = null, config = {}, confirm = null, connectFn = connectWhatsApp
  } = opts;

  banner('WHATSAPP FOLLOW-UP');

  if (error) { console.log(c.r(`[Error] ${error}`)); console.log(USAGE + '\n'); return { error }; }
  if (channel === 'mail') {
    console.log(c.y('Mail follow-ups are not supported yet. Only WhatsApp (-w) is available.\n'));
    return { error: 'mail_unsupported' };
  }
  if (!message) { console.log(c.r('[Error] No message given.')); console.log(USAGE + '\n'); return { error: 'no_message' }; }

  const hash = crypto.createHash('sha1').update(message).digest('hex').slice(0, 10);

  // 1. Find leads
  const source = resolveSourceFiles(file, config);
  if (source.error) { console.log(c.r(`[Error] ${source.error}\n`)); return { error: 'file_not_found' }; }
  if (source.files.length === 0) {
    console.log(c.y(`No archived lead files found in ${source.archivesDir}`));
    console.log('Finished lead files move there automatically once every lead has been contacted.');
    console.log('Or pass a file explicitly: /followup "message" -w path/to/leads.yaml\n');
    return { error: 'no_sources' };
  }

  const { eligible, stats } = collectLeads(source.files, hash);
  let batch = limit && limit > 0 ? eligible.slice(0, limit) : eligible;

  console.log(`📂 Source${source.files.length > 1 ? 's' : ''} (${source.files.length}): ${file ? c.cy(source.files[0]) : c.cy(source.archivesDir)}`);
  if (!file) source.files.slice(0, 5).forEach((f) => console.log(c.d(`   - ${path.basename(f)}`)));
  console.log(`\n📋 Leads: ${stats.total} found`);
  console.log(`   ✓ Already contacted (status sent) : ${c.g(eligible.length + stats.alreadyDone)}`);
  if (stats.alreadyDone) console.log(`   ↺ Already got THIS follow-up      : ${c.y(stats.alreadyDone)} ${c.d('(skipped)')}`);
  if (stats.notSent) console.log(`   ✗ Not sent / failed / skipped     : ${c.d(stats.notSent)} ${c.d('(ignored)')}`);
  if (stats.duplicate) console.log(`   ⧉ Duplicate numbers               : ${c.d(stats.duplicate)} ${c.d('(ignored)')}`);
  if (stats.invalid) console.log(`   ⚠ Invalid numbers                 : ${c.d(stats.invalid)} ${c.d('(ignored)')}`);

  if (batch.length === 0) {
    console.log(c.y('\nNothing to send: no eligible leads for this message.\n'));
    return { total: 0, sent: 0, completed: true };
  }

  // 2. Preview
  const spintax = config.safety?.anti_fingerprint?.spintax_enabled ?? true;
  const zeroWidth = config.safety?.anti_fingerprint?.zero_width_hash ?? true;
  const minDelay = config.rate_limits?.whatsapp?.min_delay_seconds ?? 12;
  const maxDelay = config.rate_limits?.whatsapp?.max_delay_seconds ?? 28;
  const render = (lead, zw = zeroWidth) => renderProposal(message, lead, { enableSpintax: spintax, enableZeroWidth: zw });

  console.log(`\n🚀 Will send to ${c.b(c.g(batch.length))} lead(s)${eligible.length > batch.length ? c.d(` (${eligible.length - batch.length} more stay queued)`) : ''}`);
  console.log(`⏱  Estimated time: ${fmtDuration(estimateSeconds(config, batch.length))}`);
  console.log('\n✉️  Message preview (first lead):');
  console.log('--------------------------------------------------');
  console.log(render(batch[0].lead, false));
  console.log('--------------------------------------------------');
  console.log(c.d(`Text only (the demo video is not re-sent). First recipient: ${batch[0].lead.name || batch[0].lead.phone}`));

  if (dryRun) {
    console.log('\n' + c.y('--- DRY RUN: nothing was sent ---'));
    batch.slice(0, 5).forEach((b, i) => console.log(`  ${i + 1}. ${b.lead.phone}  ${b.lead.name || ''}`));
    if (batch.length > 5) console.log(c.d(`  ... and ${batch.length - 5} more`));
    console.log('');
    return { total: batch.length, simulated: true };
  }

  // 3. Linked account required
  const session = getSessionInfo(config);
  if (session.state !== 'linked') {
    console.log('\n\x1b[41m\x1b[37m NO LINKED WHATSAPP \x1b[0m');
    console.log('→ Run ' + c.g('/whatsapp scan') + ' to link an account, then run /followup again.');
    console.log(c.d('No leads were touched.\n'));
    return { error: 'no_session', aborted: true };
  }
  console.log(`\n🔐 Sending as: ${c.g(session.number || 'linked account')}${session.name ? ` (${session.name})` : ''}`);

  // 3b. Safety preflight: active hours + daily limit / warm-up (may trim the batch)
  const preflight = runPreflight(config, batch.length);
  if (!preflight.ok) return { error: preflight.reason, aborted: true };
  if (preflight.allowed < batch.length) batch = batch.slice(0, preflight.allowed);

  // 4. Confirmation
  if (!yes) {
    if (!confirm) {
      console.log(c.y('\nNeeds confirmation: run interactively or add --yes.\n'));
      return { error: 'not_confirmed', aborted: true };
    }
    const ok = await confirm(`\nSend this follow-up to ${batch.length} lead(s)? ${c.b('[y/N]')} `);
    if (!ok) { console.log(c.y('Cancelled. Nothing was sent.\n')); return { cancelled: true }; }
  }

  // 5. Connect
  console.log('\n[WhatsApp] Connecting...');
  let handle;
  try {
    handle = await connectFn(config);
  } catch (err) {
    console.log(c.r(`\n✗ ${err.message}`));
    if (err.loggedOut) console.log('→ Run ' + c.g('/whatsapp scan') + ' to link again.');
    console.log(c.d('No leads were touched.\n'));
    return { error: err.loggedOut ? 'logged_out' : 'connect_failed', aborted: true };
  }
  console.log(c.g('✓ Connected\n'));

  // 6. Send loop
  const humanCfg = getHumanConfig(config);
  const pacer = createPacer(config);
  const circuit = config.safety?.circuit_breaker || {};
  const circuitOn = circuit.enabled !== false;
  const maxFails = circuit.max_consecutive_failures || 3;

  const summary = { total: batch.length, sent: 0, notOnWhatsApp: 0, failed: 0, circuitBreakerTripped: false, loggedOut: false };
  const records = [];
  let consecutiveFailures = 0;

  const waitConnected = async () => {
    for (let i = 0; i < 30 && !handle.connected && !handle.loggedOut && !handle.failed; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    return handle.connected;
  };

  try {
    for (let i = 0; i < batch.length; i++) {
      const { lead, file: leadFile, phone } = batch[i];
      console.log('------------------------------------------------------');
      console.log(`[${i + 1}/${batch.length}] ${lead.phone} (${lead.name || 'Anonymous'})`);

      if (handle.loggedOut) { summary.loggedOut = true; console.log(c.r('Session was logged out. Stopping.')); break; }
      if (!(await waitConnected())) { console.log(c.r('Connection lost and could not be restored. Stopping.')); summary.failed += batch.length - i; break; }

      try {
        const sock = handle.sock;
        await lookupGap(config);
        const res = await sock.onWhatsApp(phone.jid);
        if (!(Array.isArray(res) && res.length > 0 && res[0].exists)) {
          console.log(c.y('[NOT ON WHATSAPP] Skipping.'));
          summary.notOnWhatsApp++;
          records.push({ phone: lead.phone, name: lead.name || '', status: 'NOT_ON_WHATSAPP', processed_at: new Date().toISOString() });
          updateLeadInYamlFile(leadFile, lead, { followup_error: 'not_on_whatsapp' });
          continue;
        }

        const jid = res[0].jid || phone.jid;
        const text = render(lead);

        await humanSendText(sock, jid, text, config);
        const now = new Date().toISOString();
        console.log(c.g(`[SENT] Follow-up delivered to ${lead.phone}`));
        summary.sent++;
        recordSent(config, 1);
        consecutiveFailures = 0;
        records.push({ phone: lead.phone, name: lead.name || '', jid, status: 'SENT', processed_at: now });
        updateLeadInYamlFile(leadFile, lead, {
          followup_sent_at: now,
          followup_count: (Number(lead.followup_count) || 0) + 1,
          followup_hash: hash,
          followup_message: message.length > 300 ? message.slice(0, 300) + '…' : message,
          followup_error: null
        });

        await pacer.afterLead({ sock, jid, isLast: i >= batch.length - 1 });
      } catch (err) {
        console.log(c.r(`[ERROR] ${lead.phone}: ${err.message}`));
        summary.failed++;
        consecutiveFailures++;
        const riskSignal = humanCfg.limits.abort_on_risk_signals && isRiskSignal(err);
        records.push({ phone: lead.phone, name: lead.name || '', status: 'FAILED', error: err.message, processed_at: new Date().toISOString() });
        updateLeadInYamlFile(leadFile, lead, { followup_error: err.message });

        if (riskSignal) {
          console.log(c.r('\n[RISK SIGNAL] WhatsApp answered with a rate-limit / blocked style error. Stopping now: wait several hours before sending again.'));
          summary.circuitBreakerTripped = true;
          break;
        }
        if (circuitOn && consecutiveFailures >= maxFails) {
          console.log(c.r(`\n[CIRCUIT BREAKER] ${consecutiveFailures} failures in a row. Halting to protect your account.`));
          summary.circuitBreakerTripped = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  } finally {
    handle.close();
  }

  // 7. Report
  const reportsDir = path.resolve(config.paths?.reports_dir || 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(reportsDir, `whatsapp_followup_${stamp}.yaml`);
  fs.writeFileSync(reportPath, yaml.dump({
    workflow: 'whatsapp_followup',
    generated_at: new Date().toISOString(),
    message,
    circuit_breaker_tripped: summary.circuitBreakerTripped,
    summary: { targeted: summary.total, sent: summary.sent, not_on_whatsapp: summary.notOnWhatsApp, failed: summary.failed },
    leads: records
  }, { indent: 2, lineWidth: -1 }), 'utf8');

  const remaining = summary.total - (summary.sent + summary.notOnWhatsApp + summary.failed);
  console.log('\n======================================================');
  console.log('       FOLLOW-UP REPORT [WHATSAPP]');
  console.log('======================================================');
  console.log(`  Targeted            : ${summary.total}`);
  console.log(`  ✓ Sent              : ${c.g(summary.sent)}`);
  console.log(`  ⚠ Not on WhatsApp   : ${c.y(summary.notOnWhatsApp)}`);
  console.log(`  ✗ Failed            : ${c.r(summary.failed)}`);
  if (remaining > 0) console.log(`  ⏸ Not attempted     : ${c.y(remaining)} ${c.d('(run the same command again to continue)')}`);
  if (summary.circuitBreakerTripped) console.log(`  ${'\x1b[41m\x1b[37m[CIRCUIT BREAKER]\x1b[0m'} Run halted early.`);
  console.log('------------------------------------------------------');
  console.log(`  Report saved        : ${reportPath}`);
  console.log('======================================================\n');

  return summary;
}
