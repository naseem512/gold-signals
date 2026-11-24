// Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const GS = require('../indicators.js');

const H = GS.HOUR;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const fixture = require('./fixtures/paxg-1h.json').map(([t, o, h, l, c]) => ({ t, o, h, l, c }));

// ---------- indicators ----------
test('EMA seeds with SMA and follows the recursive formula', () => {
  const e = GS.ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.equal(e[0], null); assert.equal(e[1], null);
  near(e[2], 2);
  for (let i = 3; i < 10; i++) near(e[i], i); // linear series: EMA3 lags by exactly 1
});

test('RSI is 100 on a rising series and 50 on a symmetric zig-zag', () => {
  const up = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(GS.rsi(up, 14).at(-1), 100);
  const zig = Array.from({ length: 31 }, (_, i) => (i % 2 ? 1 : 0));
  near(GS.rsi(zig, 14)[14], 50); // first value: 7 gains of 1, 7 losses of 1
});

test('ATR equals the candle range when there are no gaps', () => {
  const c = Array.from({ length: 40 }, (_, i) => ({ t: i * H, o: 100, h: 102, l: 98, c: 100 }));
  near(GS.atr(c, 14).at(-1), 4);
});

// ---------- market hours ----------
test('weekend candles are marked closed, weekday candles open', () => {
  const at = s => Date.parse(s);
  assert.equal(GS.isMarketClosed(at('2026-11-06T20:00:00Z')), false); // Fri 20:00
  assert.equal(GS.isMarketClosed(at('2026-11-06T21:00:00Z')), true);  // Fri 21:00
  assert.equal(GS.isMarketClosed(at('2026-11-07T12:00:00Z')), true);  // Sat
  assert.equal(GS.isMarketClosed(at('2026-11-08T21:00:00Z')), true);  // Sun 21:00
  assert.equal(GS.isMarketClosed(at('2026-11-08T22:00:00Z')), false); // Sun 22:00 open
  assert.equal(GS.isMarketClosed(at('2026-11-10T03:00:00Z')), false); // Tue
});

test('fixture after marketCandles has no weekend candles', () => {
  const m = GS.marketCandles(fixture);
  assert.ok(m.length < fixture.length);
  assert.ok(m.every(c => !GS.isMarketClosed(c.t)));
});

// ---------- no repaint / no look-ahead ----------
test('4H trend at candle i does not change when future candles are added', () => {
  const m = GS.marketCandles(fixture);
  const full = GS.htfTrend(m);
  for (const cut of [600, 900, 1333, 1777, 2000]) {
    const part = GS.htfTrend(m.slice(0, cut + 1));
    for (let i = 0; i <= cut; i++) assert.equal(part[i], full[i], `htf differs at ${i} (cut ${cut})`);
  }
});

test('signals are identical whether computed live (data up to i) or later (full data)', () => {
  const m = GS.marketCandles(fixture);
  const fullInd = GS.computeAll(m);
  let checked = 0;
  for (let i = 400; i < m.length; i += 7) {
    const live = GS.signalAt(GS.computeAll(m.slice(0, i + 1)), m.slice(0, i + 1), i);
    const later = GS.signalAt(fullInd, m, i);
    assert.deepEqual(live && { s: live.side, p: live.passed, e: live.entry, sl: live.sl },
                     later && { s: later.side, p: later.passed, e: later.entry, sl: later.sl }, `differs at ${i}`);
    checked++;
  }
  assert.ok(checked > 200, `only ${checked} points checked`);
});

// ---------- SL / TP levels ----------
test('BUY levels: SL below, TP1 = 1R and TP2 = 3R above; SELL is mirrored', () => {
  const m = GS.marketCandles(fixture), ind = GS.computeAll(m);
  const sigs = [];
  for (let i = 1; i < m.length; i++) { const s = GS.signalAt(ind, m, i); if (s) sigs.push(s); }
  const buy = sigs.find(s => s.side === 'BUY'), sell = sigs.find(s => s.side === 'SELL');
  assert.ok(buy && sell, 'fixture should contain both sides');
  for (const s of [buy, sell]) {
    const dir = s.side === 'BUY' ? 1 : -1;
    near(s.slDist, s.atr * GS.CONFIG.SL_ATR);
    near((s.entry - s.sl) * dir, s.slDist);
    near((s.tp1 - s.entry) * dir, s.slDist * GS.CONFIG.TP1_R);
    near((s.tp2 - s.entry) * dir, s.slDist * GS.CONFIG.TARGET_R);
  }
});

// ---------- trade resolution ----------
function fakeSig(side = 'BUY') {
  const dir = side === 'BUY' ? 1 : -1;
  return { index: 0, side, entry: 100, slDist: 10, sl: 100 - dir * 10, tp1: 100 + dir * 10, tp2: 100 + dir * 30 };
}
const bar = (o, h, l, c) => ({ t: 0, o, h, l, c });

test('resolve: TP2 hit, TP1 recorded on the way', () => {
  const r = GS.resolve(fakeSig(), [bar(100, 100, 100, 100), bar(100, 112, 99, 111), bar(111, 131, 110, 130)], 2);
  assert.equal(r.exit, 'tp'); assert.equal(r.r, 3); assert.equal(r.tp1Hit, true);
});

test('resolve: SL hit gives -1R', () => {
  const r = GS.resolve(fakeSig(), [bar(100, 100, 100, 100), bar(100, 101, 89, 90)], 1);
  assert.equal(r.exit, 'sl'); assert.equal(r.r, -1);
});

test('resolve: SL and TP in the same candle counts as a loss (conservative)', () => {
  const r = GS.resolve(fakeSig(), [bar(100, 100, 100, 100), bar(100, 135, 85, 120)], 1);
  assert.equal(r.exit, 'sl');
});

test('resolve: gap through SL fills at the open, worse than -1R', () => {
  const r = GS.resolve(fakeSig(), [bar(100, 100, 100, 100), bar(85, 86, 80, 82)], 1);
  assert.equal(r.exit, 'sl'); near(r.r, -1.5);
});

test('resolve: SELL mirror works', () => {
  const r = GS.resolve(fakeSig('SELL'), [bar(100, 100, 100, 100), bar(100, 101, 69, 70)], 1);
  assert.equal(r.exit, 'tp'); assert.equal(r.r, 3);
});

test('resolve: still open when neither level is reached', () => {
  const r = GS.resolve(fakeSig(), [bar(100, 100, 100, 100), bar(100, 105, 95, 101)], 1);
  assert.equal(r.result, 'open');
});

test('resolve: closes at market after MAX_HOLD candles', () => {
  const c = [bar(100, 100, 100, 100)];
  for (let i = 0; i < GS.CONFIG.MAX_HOLD + 5; i++) c.push(bar(100, 102, 98, 101));
  const r = GS.resolve(fakeSig(), c, c.length - 1);
  assert.equal(r.exit, 'time'); assert.equal(r.exitIndex, GS.CONFIG.MAX_HOLD); near(r.r, 0.1);
});

// ---------- backtest ----------
test('backtest: one trade at a time, costs applied, stats consistent', () => {
  const m = GS.marketCandles(fixture), ind = GS.computeAll(m);
  const bt = GS.backtest(m, ind, m.length - 1, true);
  const closed = bt.trades.filter(t => t.result !== 'open');
  for (let k = 1; k < bt.trades.length; k++) assert.ok(bt.trades[k].index > bt.trades[k - 1].exitIndex, 'overlapping trades');
  for (const t of closed) assert.ok(t.r < (t.exit === 'tp' ? GS.CONFIG.TARGET_R : Infinity) || t.exit !== 'tp', 'cost not applied');
  near(bt.totalR, closed.reduce((s, t) => s + t.r, 0));
  assert.ok(bt.trades.every(t => t.passed), 'filtered backtest must only contain passed signals');
  const raw = GS.backtest(m, ind, m.length - 1, false);
  assert.ok(raw.count >= bt.count);
});

// ---------- lot size ----------
test('lot size rounds down to 0.01 and never exceeds the chosen risk', () => {
  const a = GS.lotSize(10000, 1, 40);        // $100 / ($40 * 100) = 0.025 -> 0.02
  assert.equal(a.lots, 0.02); near(a.riskUsd, 80); near(a.minLotRisk, 40);
  const b = GS.lotSize(1000, 1, 40);          // below the 0.01 minimum
  assert.equal(b.lots, 0);
  const c = GS.lotSize(5000, 2, 25);          // $100 / $2500 = 0.04 exactly
  assert.equal(c.lots, 0.04);
  const d = GS.lotSize(10000, 1, 40, 10);     // broker with 10 oz contracts
  assert.equal(d.lots, 0.25);
  assert.equal(GS.lotSize(0, 1, 40).lots, 0);
  assert.equal(GS.lotSize(1000, 1, 0).lots, 0);
});

// ---------- cloud alerts: replay history hour by hour ----------
test('alert job: replaying history gives signal -> (TP1) -> result, in order, never duplicated', async () => {
  const { checkMarket } = require('../alerts/check.js');
  const M = require('../instruments.js');
  const inst = M.byId('XAUUSD');
  const m = GS.marketCandles(fixture);
  const st = {};
  const log = [];
  // pretend the job runs once per hour, 10 minutes after each candle closes
  for (let i = 1200; i < m.length; i++) {
    const now = m[i].t + H + 10 * 60 * 1000;
    const { events } = await checkMarket(inst, st, now, m.slice(0, i + 1));
    for (const e of events) log.push({ i, title: e.title });
  }
  assert.ok(log.length > 0, 'expected some alerts over ~1000 hours');
  // every result/TP1 must follow its own signal, and each signal produces at most one TP1 and one result
  let open = false, tp1 = false;
  for (const e of log) {
    if (/: abhi (BUY|SELL) karein \(Safe\)$/.test(e.title)) { assert.equal(open, false, 'new signal while previous still open at ' + e.i); open = true; tp1 = false; }
    else if (/TP1 hit \(Safe\)$/.test(e.title)) { assert.ok(open && !tp1, 'TP1 without open signal at ' + e.i); tp1 = true; }
    else { assert.ok(open, 'result without signal at ' + e.i); open = false; }
  }
  // the alerts must match the app's own backtest over the same window
  const bt = GS.backtest(m, GS.computeAll(m), m.length - 1, true, inst.cost);
  const signalsInWindow = bt.trades.filter(t => t.index >= 1201).length;
  assert.equal(log.filter(e => /: abhi (BUY|SELL) karein \(Safe\)$/.test(e.title)).length, signalsInWindow);
});

// ---------- trading platforms ----------
const P = require('../platforms.js');
const M = require('../instruments.js');
const gold = M.byId('XAUUSD');
const buy = { side: 'BUY', entry: 2000, sl: 1990, tp1: 2010, tp2: 2030, slDist: 10 };
const sell = { side: 'SELL', entry: 2000, sl: 2010, tp1: 1990, tp2: 1970, slDist: 10 };
const acct = { balance: 1000, riskPct: 1, usdPerPoint: 100, price: 2000 };
const field = (o, label) => o.fields.find(f => f.label.startsWith(label)).value;

test('MT5/MT4/cTrader: lots match lotSize and SL/TP are the signal prices', () => {
  for (const id of ['mt5', 'mt4', 'ctrader', 'other']) {
    const o = P.orderFor(id, gold, buy, { ...acct, balance: 10000 });
    assert.ok(o.available);
    assert.equal(o.size, GS.lotSize(10000, 1, 10, 100).lots); // $100 risk / ($10 x 100) = 0.10
    assert.equal(o.size, 0.1);
    near(o.risk.usd, 100);
    assert.equal(field(o, 'Stop Loss'), '1990.00');
    assert.equal(field(o, 'Take Profit'), '2030.00');
  }
});

test('MT5: tiny balance falls back to 0.01 lot and flags the extra risk', () => {
  const o = P.orderFor('mt5', gold, sell, acct); // $10 risk < 0.01 lot x $10 x 100 = $10? exactly equal -> 0.01
  assert.equal(o.size, 0.01); assert.equal(o.risk.tooBig, false);
  const small = P.orderFor('mt5', gold, sell, { ...acct, balance: 500 });
  assert.equal(small.size, 0.01); assert.equal(small.risk.tooBig, true);
  assert.match(field(small, 'Type'), /^Sell/);
});

test('Binance Futures: quantity in coins risks the budget, SELL allowed, gold maps to PAXGUSDT', () => {
  const o = P.orderFor('binance-futures', gold, sell, acct);
  assert.ok(o.available);
  assert.equal(field(o, 'Symbol'), 'PAXGUSDT');
  assert.equal(field(o, 'Quantity'), '1.000');         // $10 risk / $10 SL distance = 1 PAXG
  near(o.risk.usd, 10);
  assert.match(field(o, 'Side'), /Short/);
  assert.equal(field(o, 'Leverage'), '2x Isolated');   // 2000 USDT position on a 1000 balance
});

test('Binance Spot: BUY only, capped by balance; SELL and non-Binance markets are unavailable', () => {
  assert.equal(P.orderFor('binance-spot', gold, sell, acct).available, false);
  const o = P.orderFor('binance-spot', gold, buy, { ...acct, riskPct: 5 }); // wants 5 PAXG = 10000 USDT, has 1000
  assert.ok(o.available);
  assert.equal(o.size, 0.5);
  assert.ok(o.risk.usd < 50 && o.risk.usd > 0);
  for (const id of ['binance-spot', 'binance-futures']) assert.equal(P.orderFor(id, M.byId('EURUSD'), buy, acct).available, false);
});

test('Every platform produces steps for every market without throwing', () => {
  for (const p of P.PLATFORMS) for (const inst of M.INSTRUMENTS) {
    const o = P.orderFor(p.id, inst, buy, acct);
    assert.ok(o.available ? o.steps.length >= 3 : o.reason.length > 10, p.id + ' ' + inst.id);
  }
});

// ---------- spot gold calibration (PAXG -> XAUUSD) ----------
test('shifting prices onto spot keeps every signal and moves levels by exactly the offset', () => {
  const m = GS.marketCandles(fixture);
  const off = 11.37;
  const s = GS.shiftCandles(m, off);
  for (const filter of [true, false]) { // filtered (~7 trades) and unfiltered (more) runs
    const a = GS.backtest(m, GS.computeAll(m), m.length - 1, filter, 0.5);
    const b = GS.backtest(s, GS.computeAll(s), s.length - 1, filter, 0.5);
    assert.ok(a.trades.length > 5);
    assert.equal(b.trades.length, a.trades.length);
    assert.equal(b.rejected.length, a.rejected.length);
    a.trades.forEach((t, k) => {
      const u = b.trades[k];
      assert.equal(u.time, t.time); assert.equal(u.side, t.side); assert.equal(u.exit, t.exit);
      near(u.entry - t.entry, off, 1e-6); near(u.sl - t.sl, off, 1e-6); near(u.tp2 - t.tp2, off, 1e-6);
      near(u.r, t.r, 1e-6);
    });
  }
});

test('spot offset: fresh quote accepted, stale/implausible/broken replies rejected', () => {
  const now = Date.parse('2026-11-09T02:20:00Z');
  const q = (price, at) => ({ price, updatedAt: at });
  near(M.spotOffset(q(4128.4, '2026-11-09T02:18:24Z'), 4117.5, now), 10.9, 1e-6);
  assert.equal(M.spotOffset(q(4128.4, '2026-11-08T22:00:00Z'), 4117.5, now), null); // frozen (weekend)
  assert.equal(M.spotOffset(q(4500, '2026-11-09T02:18:24Z'), 4117.5, now), null);   // >3% apart
  assert.equal(M.spotOffset(q('x', '2026-11-09T02:18:24Z'), 4117.5, now), null);
  assert.equal(M.spotOffset(null, 4117.5, now), null);
  assert.equal(M.spotOffset({}, 4117.5, now), null);
});

// ---------- signal modes ----------
test('Active mode keeps every Safe signal and adds pullback entries', () => {
  const m = GS.marketCandles(fixture), ind = GS.computeAll(m);
  let safe = 0, extra = 0;
  for (let i = 1; i < m.length - 1; i++) {
    const s = GS.signalAt(ind, m, i, 'safe'), a = GS.signalAt(ind, m, i, 'active');
    if (s) {
      safe++;
      // a filtered-out cross may be replaced by a breakout that passes; a passing cross is always kept
      if (s.passed) assert.ok(a && a.side === s.side && a.kind === 'cross', 'active lost a safe signal at ' + i);
      else assert.ok(a && (a.kind === 'cross' || (a.kind === 'breakout' && a.passed)), 'unexpected at ' + i);
    }
    if (a && !s) { extra++; assert.ok(['pullback', 'breakout'].includes(a.kind), a.kind); }
  }
  assert.ok(safe > 0 && extra > safe, `safe ${safe}, extra ${extra}`);
  const bs = GS.backtest(m, ind, m.length - 2, true, 0.5, 'safe'), ba = GS.backtest(m, ind, m.length - 2, true, 0.5, 'active');
  assert.ok(ba.trades.length > bs.trades.length);
});

test('Active pullback signals do not repaint', () => {
  const m = GS.marketCandles(fixture);
  const full = GS.computeAll(m);
  for (let i = 1500; i < m.length; i += 7) {
    const part = m.slice(0, i + 1);
    const live = GS.signalAt(GS.computeAll(part), part, i, 'active');
    const later = GS.signalAt(full, m, i, 'active');
    assert.deepEqual(live && [live.side, live.kind, live.entry], later && [later.side, later.kind, later.entry], 'at ' + i);
  }
});

test('alert job (Active): replay gives signal -> result in order and matches the backtest', async () => {
  const { checkMarket } = require('../alerts/check.js');
  const inst = M.byId('XAUUSD');
  const m = GS.marketCandles(fixture);
  const st = {}, log = [];
  for (let i = 1200; i < m.length; i++) {
    const now = m[i].t + H + 10 * 60 * 1000;
    const { events } = await checkMarket(inst, st, now, m.slice(0, i + 1), 'active');
    for (const e of events) log.push({ i, title: e.title });
  }
  assert.ok(log.length > 0 && log.every(e => !e.title.includes('(Safe)'))); // Active is the main topic: no tag
  let open = false;
  for (const e of log) {
    if (/abhi (BUY|SELL) karein/.test(e.title)) { assert.equal(open, false, 'overlap at ' + e.i); open = true; }
    else if (!/TP1 hit/.test(e.title)) { assert.ok(open, 'result without signal at ' + e.i); open = false; }
  }
  const bt = GS.backtest(m, GS.computeAll(m), m.length - 1, true, inst.cost, 'active');
  assert.equal(log.filter(e => /abhi (BUY|SELL) karein/.test(e.title)).length, bt.trades.filter(t => t.index >= 1201).length);
});

test('alert job skips a signal found too late (price already ran away), but tracks it', async () => {
  const { checkMarket } = require('../alerts/check.js');
  const inst = M.byId('XAUUSD');
  const m = GS.marketCandles(fixture), ind = GS.computeAll(m);
  const bt = GS.backtest(m, ind, m.length - 2, true, inst.cost, 'active');
  let found = null;
  for (const t of bt.trades.filter(x => x.index >= 400)) { // checkMarket needs 300+ candles of history
    const dir = t.side === 'BUY' ? 1 : -1;
    for (let j = t.index + 1; j < (t.exitIndex ?? m.length - 2); j++) {
      const r = GS.resolve(t, m, j);
      if (r.result !== 'open' || r.tp1Hit) break;
      if ((m[j].c - t.entry) * dir / t.slDist > 0.4) { found = { t, j }; break; }
    }
    if (found) break;
  }
  assert.ok(found, 'fixture should contain a trade that ran >0.4R before TP1');
  const st = { init: true, lastSignal: 0 };
  const { events } = await checkMarket(inst, st, m[found.j].t + H + 60000, m.slice(0, found.j + 1), 'active');
  assert.equal(events.length, 0);
  assert.equal(st.lastSignal, found.t.time);
  assert.equal(st.announced, undefined);
});

test('ntfy topics: Active (default) uses the main topic, Safe has its own', () => {
  assert.equal(M.topicFor('XAUUSD'), 'naseem-trader-8cb48b4cb5-xauusd');
  assert.equal(M.topicFor('XAUUSD', 'active'), 'naseem-trader-8cb48b4cb5-xauusd');
  assert.equal(M.topicFor('XAUUSD', 'safe'), 'naseem-trader-8cb48b4cb5-xauusd-safe');
});

// ---------- Scalp 15m mode ----------
const f15 = require('./fixtures/paxg-15m.json').map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const IV15 = GS.modeOf('scalp').iv;

test('Scalp 15m: 4H trend and signals do not repaint on 15-minute candles', () => {
  const m = GS.marketCandles(f15), full = GS.computeAll(m, IV15);
  let checked = 0;
  for (let i = 2000; i < m.length; i += 7) {
    const part = m.slice(0, i + 1), ind = GS.computeAll(part, IV15);
    assert.equal(ind.htf[i], full.htf[i], 'htf at ' + i);
    const a = GS.signalAt(ind, part, i, 'scalp'), b = GS.signalAt(full, m, i, 'scalp');
    assert.deepEqual(a && [a.side, a.entry], b && [b.side, b.entry], 'signal at ' + i);
    checked++;
  }
  assert.ok(checked > 200);
});

test('Scalp 15m: 72h max hold in candles, many more signals than 1H Active', () => {
  const m = GS.marketCandles(f15), ind = GS.computeAll(m, IV15);
  const bt = GS.backtest(m, ind, m.length - 2, true, 0.5, 'scalp');
  assert.ok(bt.trades.length > 0);
  for (const t of bt.trades) {
    assert.equal(t.maxHold, 288);
    if (t.exit === 'time') assert.equal(t.exitIndex - t.index, 288);
  }
  const days = (m.at(-1).t - m[0].t) / (24 * H);
  assert.ok(bt.trades.length / days * 30 > 8, 'scalp should give well over 8 signals a month');
  // 1H signals must keep the 1H hold
  const h = GS.marketCandles(fixture), bh = GS.backtest(h, GS.computeAll(h), h.length - 2, true, 0.5, 'active');
  assert.ok(bh.trades.every(t => t.maxHold === 72));
});

test('alert job (Scalp): replay on 15m gives signal -> result in order and matches the backtest', async () => {
  const { checkMarket } = require('../alerts/check.js');
  const inst = M.byId('XAUUSD');
  const m = GS.marketCandles(f15);
  const st = {}, log = [];
  for (let i = 2500; i < m.length; i++) {
    const now = m[i].t + IV15 + 5 * 60 * 1000;
    const { events } = await checkMarket(inst, st, now, m.slice(0, i + 1), 'scalp');
    for (const e of events) log.push({ i, title: e.title });
  }
  assert.ok(log.length > 0 && log.every(e => e.title.endsWith('(Scalp 15m)')));
  let open = false;
  for (const e of log) {
    if (/abhi (BUY|SELL) karein/.test(e.title)) { assert.equal(open, false, 'overlap at ' + e.i); open = true; }
    else if (!/TP1 hit/.test(e.title)) { assert.ok(open, 'result without signal at ' + e.i); open = false; }
  }
  const bt = GS.backtest(m, GS.computeAll(m, IV15), m.length - 1, true, inst.cost, 'scalp');
  assert.equal(log.filter(e => /abhi (BUY|SELL) karein/.test(e.title)).length, bt.trades.filter(t => t.index >= 2501).length);
});

test('ntfy topic for Scalp mode', () => {
  assert.equal(M.topicFor('XAUUSD', 'scalp'), 'naseem-trader-8cb48b4cb5-xauusd-scalp');
});

// ---------- markets ----------
test('Only markets graded ok/strong get a pick, and grades exist for safe and active', () => {
  for (const m of M.INSTRUMENTS) {
    assert.ok(['strong', 'ok', 'weak', 'loss'].includes(M.grade(m, 'safe')), m.id);
    assert.ok(['strong', 'ok', 'weak', 'loss'].includes(M.grade(m, 'active')), m.id);
    if (m.pick) assert.ok(['strong', 'ok'].includes(M.grade(m, m.pick)), m.id + ' pick ' + m.pick);
  }
  assert.equal(M.byId('XAUUSD').pick, 'active');
  assert.equal(M.byId('USDJPY').pick, undefined);
  assert.equal(M.grade(M.byId('BTCUSD'), 'scalp'), 'untested');
  assert.equal(M.ALL_TOPIC, 'naseem-trader-8cb48b4cb5-all');
});

// ---------- Active breakout (gold only) ----------
test('Active breakout: close beyond the 40-candle extreme in the trend, filters except RSI/EMA21 distance', () => {
  const m = GS.marketCandles(fixture), ind = GS.computeAll(m);
  let n = 0;
  for (let i = 300; i < m.length - 1; i++) {
    const s = GS.signalAt(ind, m, i, 'active');
    if (!s || s.kind !== 'breakout') continue;
    n++;
    const dir = s.side === 'BUY' ? 1 : -1;
    const prev = m.slice(i - 40, i).map(c => dir > 0 ? c.h : c.l);
    assert.ok(dir > 0 ? m[i].c > Math.max(...prev) : m[i].c < Math.min(...prev), 'not a breakout at ' + i);
    assert.equal(GS.trendAt(ind, m, i), dir > 0 ? 'up' : 'down');
    assert.equal(ind.htf[i], dir > 0 ? 'up' : 'down');
    assert.ok(s.passed);
    // with breakout switched off this candle gives no tradable signal
    const off = GS.signalAt(ind, m, i, 'active', { breakout: false });
    assert.ok(!off || !off.passed);
  }
  assert.ok(n > 0, 'fixture should contain breakout signals');
  assert.equal(M.optsFor(M.byId('XAUUSD')).breakout, true);
  assert.equal(M.optsFor(M.byId('BTCUSD')).breakout, false);
  // Safe and Scalp never use breakout
  for (let i = 300; i < m.length - 1; i += 3) { const s = GS.signalAt(ind, m, i, 'safe'); assert.ok(!s || s.kind === 'cross'); }
});

// ---------- trend trade (always-on, gold 1H) ----------
test('Trend trade direction: needs 1H and 4H trend agreement and price on the trend side of EMA21', () => {
  const m = GS.marketCandles(fixture), ind = GS.computeAll(m);
  let n = 0;
  for (let i = 300; i < m.length; i++) {
    const p = m[i].c, d = GS.trendTradeDir(ind, m, i, p), tr = GS.trendAt(ind, m, i);
    if (d) {
      n++;
      assert.equal(tr, d > 0 ? 'up' : 'down');
      assert.equal(ind.htf[i], d > 0 ? 'up' : 'down');
      assert.ok((p - ind.e21[i]) * d >= 0);
      assert.equal(GS.trendTradeDir(ind, m, i, ind.e21[i] - d * ind.atr[i]), 0); // wrong side of EMA21
    } else if ((tr === 'up' && ind.htf[i] === 'up') || (tr === 'down' && ind.htf[i] === 'down')) {
      assert.ok((p - ind.e21[i]) * (tr === 'up' ? 1 : -1) < 0);
    }
  }
  assert.ok(n > 200);
});

// ---------- pending STOP order (gold 1H) ----------
test('Pending stop direction: trends agree and price on the WRONG side of EMA21; never overlaps a trend trade', () => {
  const m = GS.marketCandles(fixture), ind = GS.computeAll(m);
  let n = 0;
  for (let i = 300; i < m.length; i++) {
    const p = m[i].c, pd = GS.pendingStopDir(ind, m, i, p), td = GS.trendTradeDir(ind, m, i, p);
    assert.ok(!(pd && td), 'pending and trend trade at the same time at ' + i);
    if (pd) { n++; assert.ok((p - ind.e21[i]) * pd < 0); assert.equal(ind.htf[i], pd > 0 ? 'up' : 'down'); }
  }
  assert.ok(n > 50);
  assert.equal(GS.PENDING_HOURS, 12);
});

test('MT5 order for a pending stop shows the stop price and pending steps', () => {
  const sig = { side: 'SELL', entry: 2000, sl: 2010, tp1: 1990, tp2: 1970, slDist: 10, pending: true, pendingHours: 12 };
  const o = P.orderFor('mt5', gold, sig, { balance: 10000, riskPct: 1, usdPerPoint: 100, price: 2005 });
  assert.equal(field(o, 'Type'), 'Sell Stop (pending)');
  assert.equal(field(o, 'Price (stop)'), '2000.00');
  assert.ok(o.steps.some(s => s.includes('Pending Order')));
  assert.equal(P.orderFor('binance-futures', gold, sig, acct).available, false);
});

test('Setup alerts: only when the setup changes, at most 2 a day', () => {
  const { setupAlert } = require('../alerts/check.js');
  const m = GS.marketCandles(fixture), inst = M.byId('XAUUSD'), st = {};
  const perDay = {};
  for (let i = 1000; i < m.length; i++) {
    const now = m[i].t + H + 10 * 60 * 1000;
    const ev = setupAlert(inst, st, now, m.slice(0, i + 1));
    if (ev) { const d = new Date(now).toISOString().slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; assert.match(ev.body, /Stop Loss: .*\nTake Profit/); }
  }
  const counts = Object.values(perDay);
  assert.ok(counts.length > 10);
  assert.ok(counts.every(c => c <= 2));
});
