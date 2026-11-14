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
  else if (inst.binance) {
    c = await binance(inst.binance);
    if (inst.spot) { // alerts go to MT5 users: put PAXG levels onto spot gold
      try {
        const off = M.spotOffset(await getJSON(M.SPOT_URL(inst.spot), 2), c[c.length - 1].c, Date.now());
        if (off != null) { c = GS.shiftCandles(c, off); console.log(`${inst.id}: spot offset ${off.toFixed(2)}`); }
        else console.log(`${inst.id}: spot quote stale, using feed price`);
      } catch (e) { console.log(`${inst.id}: spot quote failed (${e.message}), using feed price`); }
    }
  }
  else return null; // needs a TwelveData key we don't have
  return inst.closesWeekend ? GS.marketCandles(c) : c;
}

async function notify(inst, { title, body, tags, priority }, mode = 'safe') {
  const topic = M.topicFor(inst.id, mode);
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
const tag = mode => (mode === 'active' ? ' (Active)' : '');
const MODES = ['safe', 'active'];
const stateKey = (inst, mode) => (mode === 'active' ? inst.id + '-active' : inst.id);

// Written for someone with no trading experience: what to press, where SL and TP go, what to do at TP1.
function signalMessage(inst, t, mode = 'safe') {
  const buy = t.side === 'BUY';
  const up = buy ? 'upar' : 'neeche', down = buy ? 'neeche' : 'upar';
  return {
    title: `${inst.id}: abhi ${t.side} karein${tag(mode)}`,
    tags: buy ? 'green_circle,chart_with_upwards_trend' : 'red_circle,chart_with_downwards_trend',
    priority: 5,
    body: [
      `${buy ? 'Buy' : 'Sell'} ka order kholein (price takreeban ${fmt(inst, t.entry)}).`,
      `Stop Loss: ${fmt(inst, t.sl)}`,
      `Take Profit: ${fmt(inst, t.tp2)}`,
      `Price ${fmt(inst, t.tp1)} par aaye to aadha lot band karein aur SL entry par le aayein.`,
      `Broker ki price alag ho to SL apni entry se ${fmt(inst, t.slDist)} ${down}, TP ${fmt(inst, Math.abs(t.tp2 - t.entry))} ${up}.`,
      'Lot size ke liye app kholein.',
    ].join('\n'),
  };
}

async function checkMarket(inst, st, now, candlesOverride, mode = 'safe') {
  const candles = candlesOverride || await candlesFor(inst);
  if (!candles) return { skipped: 'no TwelveData key' };
  if (candles.length < 300) throw new Error('too few candles: ' + candles.length);
  const last = candles.length - 1;
  const lastClosed = candles[last].t + H > now ? last - 1 : last;
  const ind = GS.computeAll(candles);
  const bt = GS.backtest(candles, ind, lastClosed, true, inst.cost, mode);
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
    // GitHub can start this job hours late. Announce only while the trade is still worth entering,
    // using the same rule as the app's "Abhi BUY/SELL karein" box.
    const ageH = (now - (t.time + H)) / H;
    const prog = (candles[last].c - t.entry) * (t.side === 'BUY' ? 1 : -1) / t.slDist;
    if (t.result === 'open' && !t.tp1Hit && ageH <= 12 && prog <= 0.3 && prog >= -0.5) {
      events.push(signalMessage(inst, t, mode)); st.announced = t.time;
    }
  }
  // Follow-up alerts only for trades whose signal alert was actually sent.
  if (st.announced !== t.time) return { events, first };
  if (t.tp1Hit && st.tp1 !== t.time && t.result === 'open') {
    st.tp1 = t.time;
    events.push({
      title: `${inst.id} TP1 hit${tag(mode)}`, tags: 'dart', priority: 4,
      body: `${t.side} @ ${fmt(inst, t.entry)}: TP1 ${fmt(inst, t.tp1)} aa gaya.\nAadha lot band karein aur SL entry (${fmt(inst, t.entry)}) par le aayein.`,
    });
  }
  if (t.result !== 'open' && st.closed !== t.time) {
    st.closed = t.time;
    if (t.tp1Hit) st.tp1 = t.time;
    const label = { tp: 'TP2 hit', sl: 'SL hit', time: '72 ghante poore, trade band' }[t.exit];
    events.push({
      title: `${inst.id} ${label}${tag(mode)}`, tags: t.exit === 'tp' ? 'white_check_mark,moneybag' : t.exit === 'sl' ? 'x' : 'hourglass', priority: 4,
      body: `${t.side} @ ${fmt(inst, t.entry)} ka nateeja: ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R` +
        (t.exit === 'sl' && t.tp1Hit ? '\nTP1 pehle ho chuka tha: agar SL entry par kiya tha to ye trade barabar par band hui.' : ''),
    });
  }
  return { events, first };
}

async function main() {
  const now = Date.now();
  if (process.env.TEST === '1') {
    for (const inst of M.INSTRUMENTS) for (const mode of MODES) {
      await notify(inst, {
        title: `Naseem Trader: ${inst.id}${tag(mode)} alerts ON`, tags: 'bell', priority: 3,
        body: `Test alert. ${inst.id} ${mode === 'active' ? 'Active' : 'Safe'} mode ke naye signal, TP1, TP2 aur SL ke alerts isi topic par aayenge.`,
      }, mode);
    }
    return;
  }

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  state.markets = state.markets || {};
  let failures = 0;
  for (const inst of M.INSTRUMENTS) {
    try {
      const candles = await candlesFor(inst); // fetched once, used by both modes
      for (const mode of MODES) {
        const key = stateKey(inst, mode);
        const st = state.markets[key] = state.markets[key] || {};
        const { events = [], skipped, first } = candles ? await checkMarket(inst, st, now, candles, mode) : { skipped: 'no TwelveData key' };
        console.log(`${key}: ${skipped ? 'skipped (' + skipped + ')' : (first ? 'initialised' : events.length + ' event(s)')}`);
        for (const ev of events) await notify(inst, ev, mode);
      }
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
