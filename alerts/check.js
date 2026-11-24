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

async function binance(symbol, tf = '1H') {
  // Same endpoint and depth as the app. data-api.binance.vision is the public market-data mirror.
  let all = [], end = null;
  for (let p = 0; p < 4; p++) {
    const rows = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf === '15m' ? '15m' : '1h'}&limit=1000` + (end ? '&endTime=' + end : ''));
    if (!rows.length) break;
    all = rows.concat(all);
    end = rows[0][0] - 1;
  }
  return all.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
}

async function twelve(symbol, tf = '1H') {
  const d = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${tf === '15m' ? '15min' : '1h'}&outputsize=5000&timezone=UTC&apikey=${encodeURIComponent(KEY)}`);
  if (d.status !== 'ok' || !Array.isArray(d.values)) throw new Error('TwelveData: ' + (d.message || 'error'));
  return d.values.slice().reverse().map(v => ({ t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'), o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
}

async function candlesFor(inst, tf = '1H') {
  let c;
  if (inst.td && KEY) c = await twelve(inst.td, tf);
  else if (inst.binance) {
    c = await binance(inst.binance, tf);
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

async function notify(inst, ev, mode = 'active') {
  // "App kholein" opens the app on the same market and mode, so the card shows this trade with its lot size.
  const url = `${M.APP_URL}?m=${inst.id}&mode=${mode}`;
  await post(M.topicFor(inst.id, mode), ev, url);
  if (inst.pick === mode) await post(M.ALL_TOPIC, ev, url); // combined "best markets" topic
}

// Risk of the smallest lot (0.01) for a stop distance, so the alert itself says what a trade costs.
function riskLine(inst, slDist, price) {
  const usd = 0.01 * inst.usdPerPoint(price) * slDist;
  return `0.01 lot par risk takreeban $${usd.toFixed(2)}. Apne balance ke hisaab se lot app mein dekhein.`;
}

async function post(topic, { title, body, tags, priority }, url = M.APP_URL) {
  if (DRY) { console.log(`[DRY] -> ${topic}\n  ${title}\n  ${body.replace(/\n/g, '\n  ')}`); return; }
  const res = await fetch(`${NTFY}/${topic}`, {
    method: 'POST',
    body,
    headers: { Title: title, Tags: tags, Priority: String(priority), Click: url, Actions: `view, App kholein, ${url}` },
  });
  if (!res.ok) throw new Error(`ntfy ${res.status} for ${topic}`);
  console.log(`sent -> ${topic}: ${title}`);
}

function fmt(inst, n) { return Number(n).toFixed(inst.digits); }
const tag = mode => (mode === 'safe' ? ' (Safe)' : mode === 'scalp' ? ' (Scalp 15m)' : '');
const MODES = ['active', 'safe', 'scalp'];
const SCALP_MARKETS = ['XAUUSD']; // 15m mode was only tested on gold
// 'XAUUSD' (no suffix) has always held Safe state; keep it so nothing re-announces.
const stateKey = (inst, mode) => (mode === 'safe' ? inst.id : inst.id + '-' + mode);

// Written for someone with no trading experience: what to press, where SL and TP go, what to do at TP1.
function signalMessage(inst, t, mode = 'safe') {
  const buy = t.side === 'BUY';
  const up = buy ? 'upar' : 'neeche', down = buy ? 'neeche' : 'upar';
  return {
    title: `${inst.id}: abhi ${t.side} karein${tag(mode)}`,
    tags: buy ? 'rotating_light,green_circle' : 'rotating_light,red_circle', // sent with priority 5 (ntfy max) so it can ring like an alarm
    priority: 5,
    body: [
      `${buy ? 'Buy' : 'Sell'} ka order kholein (price takreeban ${fmt(inst, t.entry)}).`,
      `Stop Loss: ${fmt(inst, t.sl)}`,
      `Take Profit: ${fmt(inst, t.tp2)}`,
      `Price ${fmt(inst, t.tp1)} par aaye to aadha lot band karein aur SL entry par le aayein.`,
      `Broker ki price alag ho to SL apni entry se ${fmt(inst, t.slDist)} ${down}, TP ${fmt(inst, Math.abs(t.tp2 - t.entry))} ${up}.`,
      riskLine(inst, t.slDist, t.entry),
    ].join('\n'),
  };
}

// Trend trade / pending STOP setup alert (gold 1H): at most 2 a day, only when the setup changes
// (new direction or new type). Same rules as the app card (GS.trendTradeDir / GS.pendingStopDir).
function setupAlert(inst, st, now, candles) {
  if (GS.isMarketClosed(now)) return null;
  const last = candles.length - 1, i = candles[last].t + H > now ? last - 1 : last;
  const ind = GS.computeAll(candles), price = candles[last].c;
  const td = GS.trendTradeDir(ind, candles, i, price), pd = td ? 0 : GS.pendingStopDir(ind, candles, i, price);
  const dir = td || pd;
  const key = dir ? (td ? 'trend' : 'pending') + (dir > 0 ? 'BUY' : 'SELL') : '';
  const day = new Date(now).toISOString().slice(0, 10);
  if (st.day !== day) { st.day = day; st.count = 0; }
  if (!dir || key === st.key) { if (!dir) st.key = ''; return null; }
  if (st.count >= 2) return null;
  st.key = key; st.count++;
  const side = dir > 0 ? 'BUY' : 'SELL', d = ind.atr[i] * GS.CONFIG.SL_ATR;
  const e = td ? price : ind.e21[i], sl = e - dir * d, tp = e + dir * d * GS.CONFIG.TARGET_R;
  return {
    title: td ? `${inst.id}: ${side} trend trade` : `${inst.id}: ${side} STOP order setup`,
    tags: 'bell', priority: 4,
    body: (td ? `Abhi ${side} kar sakte hain (price ${fmt(inst, e)}).` : `Pending ${side} STOP lagayein: ${fmt(inst, e)} (12 ghante valid).`) +
      `
Stop Loss: ${fmt(inst, sl)}
Take Profit: ${fmt(inst, tp)}
${riskLine(inst, d, e)}
Khaas signal nahi, trend setup hai.`,
  };
}

async function checkMarket(inst, st, now, candlesOverride, mode = 'safe') {
  const candles = candlesOverride || await candlesFor(inst);
  if (!candles) return { skipped: 'no TwelveData key' };
  if (candles.length < 300) throw new Error('too few candles: ' + candles.length);
  const last = candles.length - 1;
  const iv = GS.modeOf(mode).iv;
  const lastClosed = candles[last].t + iv > now ? last - 1 : last;
  const ind = GS.computeAll(candles, iv);
  const bt = GS.backtest(candles, ind, lastClosed, true, inst.cost, mode, M.optsFor(inst));
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
    const ageH = (now - (t.time + iv)) / H;
    const prog = (candles[last].c - t.entry) * (t.side === 'BUY' ? 1 : -1) / t.slDist;
    if (t.result === 'open' && !t.tp1Hit && ageH <= (mode === 'scalp' ? 1 : 12) && prog <= 0.3 && prog >= -0.5) {
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
    await post(M.ALL_TOPIC, { title: 'Naseem Trader: sab markets ke alerts ON', tags: 'bell,rotating_light', priority: 5,
      body: 'Test alert. Gold, BTC, ETH (aur key ho to Silver, GBPUSD) ke behtareen mode ke signal isi topic par aayenge.' });
    for (const inst of M.INSTRUMENTS) for (const mode of MODES) {
      await post(M.topicFor(inst.id, mode), { // per-mode topic only; the combined topic got its own test above
        title: `Naseem Trader: ${inst.id}${tag(mode)} alerts ON`, tags: 'bell,rotating_light', priority: 5, // max priority so the alarm setup can be tested
        body: `Test alert. ${inst.id} ${GS.modeOf(mode).name} mode ke naye signal, TP1, TP2 aur SL ke alerts isi topic par aayenge.`,
      });
    }
    return;
  }

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  state.markets = state.markets || {};
  let failures = 0;
  for (const inst of M.INSTRUMENTS) {
    try {
      const candles = await candlesFor(inst); // 1H, fetched once for Active and Safe
      const c15 = SCALP_MARKETS.includes(inst.id) ? await candlesFor(inst, '15m') : null;
      if (inst.id === 'XAUUSD' && candles) {
        const st = state.markets['XAUUSD-setup'] = state.markets['XAUUSD-setup'] || {};
        const ev = setupAlert(inst, st, now, candles);
        if (ev) await notify(inst, ev, 'active');
      }
      for (const mode of MODES) {
        if (mode === 'scalp' && !c15) continue;
        const key = stateKey(inst, mode);
        const st = state.markets[key] = state.markets[key] || {};
        const data = mode === 'scalp' ? c15 : candles;
        const { events = [], skipped, first } = data ? await checkMarket(inst, st, now, data, mode) : { skipped: 'no TwelveData key' };
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
module.exports = { setupAlert, checkMarket, signalMessage };
