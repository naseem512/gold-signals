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
    if (/ signal$/.test(e.title)) { assert.equal(open, false, 'new signal while previous still open at ' + e.i); open = true; tp1 = false; }
    else if (/TP1 hit$/.test(e.title)) { assert.ok(open && !tp1, 'TP1 without open signal at ' + e.i); tp1 = true; }
    else { assert.ok(open, 'result without signal at ' + e.i); open = false; }
  }
  // the alerts must match the app's own backtest over the same window
  const bt = GS.backtest(m, GS.computeAll(m), m.length - 1, true, inst.cost);
  const signalsInWindow = bt.trades.filter(t => t.index >= 1201).length;
  assert.equal(log.filter(e => / signal$/.test(e.title)).length, signalsInWindow);
});
