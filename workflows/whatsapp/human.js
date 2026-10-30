/**
 * Human-behaviour and account-safety helpers shared by /whatsapp and /followup.
 *
 * What it adds on top of the basic typing simulation:
 *  - lead hold: a fixed wait (default 10s, +/-20%) after every lead before the next
 *  - presence cycle: "online" while messaging a lead, "offline" while holding
 *  - think pause before typing, typing in bursts for long messages
 *  - lingering in the chat after sending, occasional distraction pauses
 *  - rest breaks after a random number of messages (not exactly every N)
 *  - active hours, daily limit and warm-up for newly linked accounts
 *  - risk-signal detection (rate-limit / forbidden / blocked style errors)
 *
 * Every knob lives under `safety:` in config/settings.yaml and has a default here,
 * so an older settings file keeps working.
 */

import fs from 'fs';
import path from 'path';

import { delayGaussian } from '../../utils/helpers.js';
import { getSessionInfo } from './session.js';

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  cy: (s) => `\x1b[36m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (range, fallback) => {
  const [a, b] = Array.isArray(range) && range.length >= 2 ? range : fallback;
  return rand(Number(a), Number(b));
};

// ---------- configuration ----------

const DEFAULTS = {
  lead_hold: { enabled: true, seconds: 10, jitter_percent: 20 },
  human_behavior: {
    enabled: true,
    presence_cycle: true,
    think_pause_seconds: [1, 4],
    typing_bursts: true,
    between_messages_seconds: [2, 5],
    linger_after_send_seconds: [2, 5],
    lookup_gap_seconds: [1.5, 4],
    randomize_rest_interval: true,
    distraction: { chance_percent: 8, min_seconds: 20, max_seconds: 60 }
  },
  limits: {
    enforce_daily_limit: true,
    warmup: { enabled: true, schedule: [15, 25, 35] },
    active_hours: { enabled: true, start: '09:00', end: '21:00' },
    abort_on_risk_signals: true
  }
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export function getHumanConfig(config = {}) {
  const s = config.safety || {};
  return {
    hold: merge(DEFAULTS.lead_hold, s.lead_hold),
    human: merge(DEFAULTS.human_behavior, s.human_behavior),
    limits: merge(DEFAULTS.limits, s.limits)
  };
}

// ---------- presence / typing ----------

async function presence(sock, type, jid) {
  try { await sock.sendPresenceUpdate(type, jid); } catch (_) {}
}

/** Open the chat, think, type (in bursts for long text), then send the text. */
export async function humanSendText(sock, jid, text, config = {}, log = console.log) {
  const h = getHumanConfig(config);
  const typing = config.safety?.typing_simulation || {};
  const typingOn = typing.enabled !== false;
  const msPerChar = typing.ms_per_char || 35;
  const minMs = (typing.min_duration_seconds || 2) * 1000;
  const maxMs = (typing.max_duration_seconds || 6) * 1000;
  const human = h.human.enabled;

  if (human && h.human.presence_cycle) await presence(sock, 'available');

  if (typingOn) {
    try {
      await sock.presenceSubscribe(jid);

      if (human) {
        const think = pick(h.human.think_pause_seconds, [1, 4]);
        log(c.d(`[Human] Opening chat, thinking for ${think.toFixed(1)}s...`));
        await sleep(think * 1000);
      }

      // typing time scales with length; humans are 20% faster or slower than average
      const base = Math.min(Math.max(text.length * msPerChar, minMs), maxMs);
      const total = human ? base * rand(0.8, 1.2) : base;
      const bursts = human && h.human.typing_bursts && total > 4000 ? randInt(2, 3) : 1;

      log(c.d(`[Safety] Typing for ${(total / 1000).toFixed(1)}s${bursts > 1 ? ` in ${bursts} bursts` : ''}...`));
      for (let b = 0; b < bursts; b++) {
        await presence(sock, 'composing', jid);
        await sleep(total / bursts);
        await presence(sock, 'paused', jid);
        if (b < bursts - 1) await sleep(rand(600, 1800)); // pause to re-read/think
      }
    } catch (_) {}
  }

  return sock.sendMessage(jid, { text });
}

/** Short random gap before checking whether a number is on WhatsApp. */
export async function lookupGap(config = {}) {
  const h = getHumanConfig(config);
  if (!h.human.enabled) return;
  await sleep(pick(h.human.lookup_gap_seconds, [1.5, 4]) * 1000);
}

/** Pause between the text and the follow-up media (attaching a file takes a person time). */
export async function betweenMessagesPause(config = {}) {
  const h = getHumanConfig(config);
  const sec = h.human.enabled ? pick(h.human.between_messages_seconds, [2, 5]) : 2;
  await sleep(sec * 1000);
}

// ---------- pacing between leads ----------

function holdMs(h) {
  const j = Math.max(0, Number(h.hold.jitter_percent) || 0) / 100;
  return Math.max(0, Number(h.hold.seconds) * 1000 * (1 + (Math.random() * 2 - 1) * j));
}

/**
 * One pacer per run. Call `afterLead` after every successfully contacted lead.
 * Total gap to the next lead = hold (linger + offline time are part of it).
 */
export function createPacer(config = {}) {
  const h = getHumanConfig(config);
  const rest = config.safety?.batch_break || {};
  const restOn = rest.enabled !== false;
  const interval = rest.interval_messages || 5;
  const minRest = rest.min_rest_seconds || 60;
  const maxRest = rest.max_rest_seconds || 120;
  const minDelay = config.rate_limits?.whatsapp?.min_delay_seconds ?? 12;
  const maxDelay = config.rate_limits?.whatsapp?.max_delay_seconds ?? 28;

  const nextTarget = () => (h.human.enabled && h.human.randomize_rest_interval
    ? randInt(Math.max(2, interval - 1), interval + 2)
    : interval);

  let sinceRest = 0;
  let target = nextTarget();

  return {
    async afterLead({ sock, jid, isLast = false, log = console.log } = {}) {
      sinceRest++;
      const hold = h.hold.enabled ? holdMs(h) : null;

      let linger = 0;
      if (h.human.enabled) {
        linger = pick(h.human.linger_after_send_seconds, [2, 5]) * 1000;
        if (hold !== null) linger = Math.min(linger, hold * 0.5);
        if (linger > 0) await sleep(linger);
        if (h.human.presence_cycle && sock) await presence(sock, 'unavailable', jid);
      }

      if (isLast) return { kind: 'last' };

      if (restOn && sinceRest >= target) {
        const sec = randInt(minRest, maxRest);
        log(c.cy(`\n[HUMAN REST BREAK] ${sinceRest} messages in a row. Resting ${sec}s like a real person...`));
        await sleep(sec * 1000);
        sinceRest = 0;
        target = nextTarget();
        return { kind: 'rest', seconds: sec };
      }

      const d = h.human.distraction || {};
      if (h.human.enabled && Math.random() * 100 < (Number(d.chance_percent) || 0)) {
        const sec = rand(Number(d.min_seconds) || 20, Number(d.max_seconds) || 60);
        log(c.d(`[Human] Got distracted, back in ${sec.toFixed(0)}s...`));
        await sleep(sec * 1000);
      }

      if (hold !== null) {
        const remain = Math.max(0, hold - linger);
        log(c.d(`[Hold] ${(hold / 1000).toFixed(1)}s hold before the next lead...`));
        await sleep(remain);
        return { kind: 'hold', ms: hold };
      }

      log(c.d('Applying Gaussian anti-ban delay...'));
      const waited = await delayGaussian(minDelay, maxDelay);
      log(c.d(`Waited ${(waited / 1000).toFixed(1)}s. Moving to next lead...`));
      return { kind: 'gaussian', ms: waited };
    }
  };
}

/** Rough run time for previews. */
export function estimateSeconds(config = {}, count = 0) {
  const h = getHumanConfig(config);
  const minDelay = config.rate_limits?.whatsapp?.min_delay_seconds ?? 12;
  const maxDelay = config.rate_limits?.whatsapp?.max_delay_seconds ?? 28;
  const rest = config.safety?.batch_break || {};
  const gap = h.hold.enabled ? Number(h.hold.seconds) : (minDelay + maxDelay) / 2;
  const perLead = gap + 4 + (h.human.enabled ? 5 : 0);
  const restTotal = rest.enabled === false ? 0 : Math.floor(count / ((rest.interval_messages || 5) + 0.5)) * (((rest.min_rest_seconds || 60) + (rest.max_rest_seconds || 120)) / 2);
  return count * perLead + restTotal;
}

// ---------- risk signals ----------

export function isRiskSignal(err) {
  const text = `${err?.message || ''} ${err?.output?.statusCode || ''} ${err?.data || ''}`;
  return /rate-overlimit|too many|\b429\b|forbidden|\b403\b|not-authorized|blocked|banned|spam|reachout|\b463\b/i.test(text);
}

// ---------- active hours, daily limit, warm-up ----------

const toMin = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

export function checkActiveHours(config = {}, now = new Date()) {
  const ah = getHumanConfig(config).limits.active_hours;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const start = toMin(ah.start, 9 * 60);
  const end = toMin(ah.end, 21 * 60);
  const inside = start <= end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return { ok: !ah.enabled || inside, enabled: !!ah.enabled, start: ah.start, end: ah.end, now: hhmm };
}

function usageFile(config) {
  return path.join(path.resolve(config.paths?.reports_dir || 'reports'), '.daily_usage.json');
}

const today = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

function readUsage(config) {
  try {
    const u = JSON.parse(fs.readFileSync(usageFile(config), 'utf8'));
    return u.date === today() ? Number(u.whatsapp) || 0 : 0;
  } catch (_) {
    return 0;
  }
}

/** Count messages sent today (shared by /whatsapp and /followup). */
export function recordSent(config = {}, n = 1) {
  try {
    const file = usageFile(config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today(), whatsapp: readUsage(config) + n }));
  } catch (_) {}
}

export function getDailyAllowance(config = {}, now = new Date()) {
  const h = getHumanConfig(config);
  const dailyLimit = Number(config.rate_limits?.whatsapp?.daily_limit) || 50;
  const used = readUsage(config);

  let limit = dailyLimit;
  let note = `daily limit ${dailyLimit}`;

  if (h.limits.warmup.enabled) {
    const linkedAt = getSessionInfo(config).linkedAt;
    const t = linkedAt ? Date.parse(linkedAt) : NaN;
    if (!Number.isNaN(t)) {
      const day = Math.max(1, Math.floor((now.getTime() - t) / 86400000) + 1);
      const cap = h.limits.warmup.schedule?.[day - 1];
      if (cap && cap < dailyLimit) {
        limit = Number(cap);
        note = `warm-up day ${day} cap ${cap}`;
      }
    }
  }

  if (!h.limits.enforce_daily_limit) return { limit: Infinity, used, remaining: Infinity, note: 'not enforced' };
  return { limit, used, remaining: Math.max(0, limit - used), note };
}

/**
 * Checks active hours + daily allowance before a live run.
 * Returns { ok, allowed, reason }. Prints why when it blocks or trims the batch.
 */
export function runPreflight(config = {}, wanted = 0, log = console.log) {
  const h = getHumanConfig(config);

  const hours = checkActiveHours(config);
  if (!hours.ok) {
    log(`\n\x1b[41m\x1b[37m OUTSIDE ACTIVE HOURS \x1b[0m`);
    log(`It is ${hours.now}; messaging is allowed ${hours.start}-${hours.end} only (people don't message cold leads at night).`);
    log(`→ Run again in the window, or change ${c.cy('safety.limits.active_hours')} in config/settings.yaml.`);
    log(c.d('No leads were touched.\n'));
    return { ok: false, allowed: 0, reason: 'outside_active_hours' };
  }

  const a = getDailyAllowance(config);
  if (a.remaining <= 0) {
    log(`\n\x1b[41m\x1b[37m DAILY LIMIT REACHED \x1b[0m`);
    log(`Already sent ${a.used} today (${a.note}). Try again tomorrow, or raise the limit in config/settings.yaml.`);
    log(c.d('No leads were touched.\n'));
    return { ok: false, allowed: 0, reason: 'daily_limit_reached' };
  }

  const allowed = Math.min(wanted, a.remaining);
  const holdTxt = h.hold.enabled
    ? `${h.hold.seconds}s hold${h.hold.jitter_percent ? ` (±${h.hold.jitter_percent}%)` : ''}`
    : 'random 12-28s delay';
  log(c.d(`🛡  Safety: ${holdTxt} | human mode ${h.human.enabled ? 'ON' : 'OFF'} | today ${a.used}/${a.limit === Infinity ? '∞' : a.limit} (${a.note})`));
  if (allowed < wanted) {
    log(c.y(`⚠ Capped to ${allowed} of ${wanted} lead(s) by the ${a.note}. The rest stay queued for the next run.`));
  }
  return { ok: true, allowed, abortOnRisk: !!h.limits.abort_on_risk_signals };
}
