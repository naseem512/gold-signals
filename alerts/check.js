#!/usr/bin/env node
// Cloud alert job (runs on GitHub Actions every 20 minutes).
// Uses the SAME strategy code as the app (indicators.js + instruments.js), so app and alert always agree.
// Sends ntfy push notifications for: new signal, TP1 hit, trade closed (TP2 / SL / time).
//
// Env:
//   TWELVEDATA_KEY  optional; needed for Silver/Forex, and used for Gold if present (same as the app)
//   NTFY_SERVER     optional; default https://ntfy.sh
//   TEST=1          send a test notification to every market topic and exit
//   DRY_RUN=1       print notifications instead of sending them
'use strict';
const fs = require('fs');
const path = require('path');
const GS = require('../indicators.js');
const M = require('../instruments.js');

const H = GS.HOUR;
const STATE_FILE = path.join(__dirname, 'state.json');
const NTFY = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const KEY = (process.env.TWELVEDATA_KEY || '').trim();
const DRY = process.env.DRY_RUN === '1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'naseem-trader-alerts' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

async function binance(symbol) {
  // Same endpoint and depth as the app. data-api.binance.vision is the public market-data mirror.
  let all = [], end = null;
  for (let p = 0; p < 4; p++) {
    const rows = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000` + (end ? '&endTime=' + end : ''));
    if (!rows.length) break;
    all = rows.concat(all);
    end = rows[0][0] - 1;
  }
  return all.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
}

async function twelve(symbol) {
  const d = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1h&outputsize=5000&timezone=UTC&apikey=${encodeURIComponent(KEY)}`);
  if (d.status !== 'ok' || !Array.isArray(d.values)) throw new Error('TwelveData: ' + (d.message || 'error'));
  return d.values.slice().reverse().map(v => ({ t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'), o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
}

async function candlesFor(inst) {
  let c;
  if (inst.td && KEY) c = await twelve(inst.td);
  else if (inst.binance) c = await binance(inst.binance);
  else return null; // needs a TwelveData key we don't have
  return inst.closesWeekend ? GS.marketCandles(c) : c;
}

async function notify(inst, { title, body, tags, priority }) {
  const topic = M.topicFor(inst.id);
  if (DRY) { console.log(`[DRY] -> ${topic}\n  ${title}\n  ${body.replace(/\n/g, '\n  ')}`); return; }
  const res = await fetch(`${NTFY}/${topic}`, {
    method: 'POST',
    body,
    headers: { Title: title, Tags: tags, Priority: String(priority), Click: M.APP_URL },
  });
  if (!res.ok) throw new Error(`ntfy ${res.status} for ${topic}`);
  console.log(`sent -> ${topic}: ${title}`);
}

function fmt(inst, n) { return Number(n).toFixed(inst.digits); }

function signalMessage(inst, t) {
  const d = (a, b) => fmt(inst, Math.abs(a - b));
  return {
    title: `${inst.id} ${t.side} signal`,
    tags: t.side === 'BUY' ? 'green_circle,chart_with_upwards_trend' : 'red_circle,chart_with_downwards_trend',
    priority: 5,
    body: [
      `Entry: ${fmt(inst, t.entry)}`,
      `SL: ${fmt(inst, t.sl)}  (${d(t.sl, t.entry)} door)`,
      `TP1: ${fmt(inst, t.tp1)}  (${d(t.tp1, t.entry)} door)`,
      `TP2: ${fmt(inst, t.tp2)}  (${d(t.tp2, t.entry)} door)`,
      'Broker ki price alag ho to faasla apni entry par lagayein. Lot size app mein dekhein.',
    ].join('\n'),
  };
}

async function checkMarket(inst, st, now, candlesOverride) {
  const candles = candlesOverride || await candlesFor(inst);
  if (!candles) return { skipped: 'no TwelveData key' };
  if (candles.length < 300) throw new Error('too few candles: ' + candles.length);
  const last = candles.length - 1;
  const lastClosed = candles[last].t + H > now ? last - 1 : last;
  const ind = GS.computeAll(candles);
  const bt = GS.backtest(candles, ind, lastClosed, true, inst.cost);
  const t = bt.trades[bt.trades.length - 1];
  const events = [];
  const first = !st.init;
  st.init = true;
  if (!t) return { events, first };

  if (first) { // initialise silently so a fresh setup doesn't replay old trades
    st.lastSignal = t.time; // not announced, so no follow-ups for it
    return { events, first };
  }

  if (t.time > (st.lastSignal || 0)) {
    st.lastSignal = t.time;
    const ageH = (now - (t.time + H)) / H;
    if (t.result === 'open' && ageH <= 6) { events.push(signalMessage(inst, t)); st.announced = t.time; }
  }
  // Follow-up alerts only for trades whose signal alert was actually sent.
  if (st.announced !== t.time) return { events, first };
  if (t.tp1Hit && st.tp1 !== t.time && t.result === 'open') {
    st.tp1 = t.time;
    events.push({
      title: `${inst.id} TP1 hit`, tags: 'dart', priority: 4,
      body: `${t.side} @ ${fmt(inst, t.entry)}: TP1 ${fmt(inst, t.tp1)} aa gaya.\nAadha lot band karein aur SL entry (${fmt(inst, t.entry)}) par le aayein.`,
    });
  }
  if (t.result !== 'open' && st.closed !== t.time) {
    st.closed = t.time;
    if (t.tp1Hit) st.tp1 = t.time;
    const label = { tp: 'TP2 hit', sl: 'SL hit', time: '72 ghante poore, trade band' }[t.exit];
    events.push({
      title: `${inst.id} ${label}`, tags: t.exit === 'tp' ? 'white_check_mark,moneybag' : t.exit === 'sl' ? 'x' : 'hourglass', priority: 4,
      body: `${t.side} @ ${fmt(inst, t.entry)} ka nateeja: ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R` +
        (t.exit === 'sl' && t.tp1Hit ? '\nTP1 pehle ho chuka tha: agar SL entry par kiya tha to ye trade barabar par band hui.' : ''),
    });
  }
  return { events, first };
}

async function main() {
  const now = Date.now();
  if (process.env.TEST === '1') {
    for (const inst of M.INSTRUMENTS) {
      await notify(inst, {
        title: `Naseem Trader: ${inst.id} alerts ON`, tags: 'bell', priority: 3,
        body: `Test alert. ${inst.id} ke naye signal, TP1, TP2 aur SL ke alerts isi topic par aayenge.`,
      });
    }
    return;
  }

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  state.markets = state.markets || {};
  let failures = 0;
  for (const inst of M.INSTRUMENTS) {
    const st = state.markets[inst.id] = state.markets[inst.id] || {};
    try {
      const { events = [], skipped, first } = await checkMarket(inst, st, now);
      console.log(`${inst.id}: ${skipped ? 'skipped (' + skipped + ')' : (first ? 'initialised' : events.length + ' event(s)')}`);
      for (const ev of events) await notify(inst, ev);
    } catch (e) {
      failures++;
      console.error(`${inst.id}: ERROR ${e.message}`);
    }
  }
  // Heartbeat: GitHub pauses scheduled workflows after 60 days without repo activity.
  // Updating this every ~25 days creates a small commit that keeps the schedule alive.
  if (!state.heartbeat || now - Date.parse(state.heartbeat) > 25 * 24 * H) state.heartbeat = new Date(now).toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(sortKeys(state), null, 2) + '\n');
  if (failures === M.INSTRUMENTS.length) process.exit(1);
}

// Stable key order so the state file only changes when something real changes.
function sortKeys(o) {
  if (Array.isArray(o) || o === null || typeof o !== 'object') return o;
  return Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])]));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { checkMarket, signalMessage };
