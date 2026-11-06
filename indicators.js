// Strategy core: indicators, signal rules, fake-signal filter, trade resolution, backtest, lot size.
// No DOM access, so the same file runs in the browser (window.GS) and in Node (tests + cloud alerts).
(function (root) {
  const HOUR = 3600 * 1000;
  const H4 = 4 * HOUR;

  // Settings chosen from a 2+ year test on two datasets (PAXG and gold futures),
  // weekend removed, $0.50 cost per trade. SL 2-3 ATR with a 2.5-4R target was good on both;
  // the middle of that range is used instead of the single best cell to avoid curve fitting.
  const CONFIG = {
    SL_ATR: 2.5,     // stop distance = 2.5 x ATR(14)
    TP1_R: 1,        // first target (partial close / move SL to breakeven)
    TARGET_R: 3,     // main target used by the backtest
    MAX_HOLD: 72,    // close at market after 72 candles (3 days)
    COST_USD: 0.5,   // spread + slippage per trade, in price dollars
    RSI_BUY: [50, 70],
    RSI_SELL: [30, 50],
    BODY_MIN: 0.5,   // signal candle body must be > 50% of its range
    EXT_MAX_ATR: 1,  // close must be within 1 ATR of EMA21
  };

  // Spot gold (and MT5) is closed from Friday ~21:00 UTC to Sunday ~22:00 UTC.
  // PAXG trades 24/7, so those candles are removed or the app would signal while MT5 is closed.
  function isMarketClosed(t) {
    const d = new Date(t), day = d.getUTCDay(), h = d.getUTCHours();
    return day === 6 || (day === 5 && h >= 21) || (day === 0 && h < 22);
  }
  function marketCandles(candles) { return candles.filter(c => !isMarketClosed(c.t)); }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    let prev = sum / period;
    out[period - 1] = prev;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let avgG = gain / period, avgL = loss / period;
    out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
      avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return out;
  }

  function atr(candles, period = 14) {
    const out = new Array(candles.length).fill(null);
    if (candles.length <= period) return out;
    const tr = candles.map((c, i) => i === 0 ? c.h - c.l :
      Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c)));
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    let prev = sum / period;
    out[period] = prev;
    for (let i = period + 1; i < candles.length; i++) {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
    return out;
  }

  // 4H EMA50 trend built from 1H candles. At 1H index i only 4H bars that have fully closed are used,
  // so the value never changes after the fact (no repaint).
  function htfTrend(candles) {
    const bars = [];
    for (const c of candles) {
      const b = Math.floor(c.t / H4);
      const last = bars[bars.length - 1];
      if (last && last.b === b) last.c = c.c; else bars.push({ b, c: c.c });
    }
    const e = ema(bars.map(x => x.c), 50);
    const out = new Array(candles.length).fill(null);
    let k = -1;
    for (let i = 0; i < candles.length; i++) {
      const closedAt = candles[i].t + HOUR;
      while (k + 1 < bars.length && (bars[k + 1].b + 1) * H4 <= closedAt) k++;
      if (k >= 0 && e[k] != null) out[i] = bars[k].c > e[k] ? 'up' : 'down';
    }
    return out;
  }

  function computeAll(candles) {
    const closes = candles.map(c => c.c);
    return {
      e9: ema(closes, 9), e21: ema(closes, 21), e50: ema(closes, 50), e200: ema(closes, 200),
      rsi: rsi(closes, 14), atr: atr(candles, 14), htf: htfTrend(candles),
    };
  }

  function trendAt(ind, candles, i) {
    const { e50, e200 } = ind;
    if (i < 0 || e200[i] == null) return 'unknown';
    if (e50[i] > e200[i] && candles[i].c > e200[i]) return 'up';
    if (e50[i] < e200[i] && candles[i].c < e200[i]) return 'down';
    return 'side';
  }

  function filterChecks(ind, candles, i, side) {
    const c = candles[i], dir = side === 'BUY' ? 1 : -1, range = c.h - c.l;
    return [
      { key: 'htf', label: '4H trend bhi ' + (dir === 1 ? 'up' : 'down') + ' hai',
        ok: ind.htf[i] === (dir === 1 ? 'up' : 'down') },
      { key: 'body', label: 'Signal candle mazboot hai (body > 50%)',
        ok: range > 0 && (c.c - c.o) * dir > CONFIG.BODY_MIN * range },
      { key: 'ext', label: 'Price EMA21 ke qareeb hai (< 1 ATR)',
        ok: Math.abs(c.c - ind.e21[i]) < CONFIG.EXT_MAX_ATR * ind.atr[i] },
    ];
  }

  // Signal on the CLOSE of candle i (i must be a closed candle).
  function signalAt(ind, candles, i) {
    if (i < 1) return null;
    const { e9, e21, rsi: r, atr: a } = ind;
    if ([e9[i - 1], e21[i - 1], e9[i], e21[i], r[i], a[i]].some(v => v == null)) return null;
    const trend = trendAt(ind, candles, i);
    const crossUp = e9[i - 1] <= e21[i - 1] && e9[i] > e21[i];
    const crossDn = e9[i - 1] >= e21[i - 1] && e9[i] < e21[i];
    let side = null;
    if (trend === 'up' && crossUp && r[i] > CONFIG.RSI_BUY[0] && r[i] < CONFIG.RSI_BUY[1]) side = 'BUY';
    if (trend === 'down' && crossDn && r[i] < CONFIG.RSI_SELL[1] && r[i] > CONFIG.RSI_SELL[0]) side = 'SELL';
    if (!side) return null;
    const entry = candles[i].c;
    const dist = a[i] * CONFIG.SL_ATR;
    const dir = side === 'BUY' ? 1 : -1;
    const checks = filterChecks(ind, candles, i, side);
    return {
      index: i, time: candles[i].t, side, entry, atr: a[i],
      sl: entry - dir * dist,
      tp1: entry + dir * dist * CONFIG.TP1_R,
      tp2: entry + dir * dist * CONFIG.TARGET_R,
      slDist: dist, checks, passed: checks.every(x => x.ok),
    };
  }

  // Walk forward from the signal candle.
  // - A candle that OPENS beyond SL/TP (gap) fills at its open.
  // - If SL and TP are both inside one candle, SL is assumed first (conservative).
  // - tp1Hit records whether price reached TP1 on the way.
  function resolve(sig, candles, lastClosed) {
    const dir = sig.side === 'BUY' ? 1 : -1;
    const rOf = p => (p - sig.entry) * dir / sig.slDist;
    let tp1Hit = false;
    for (let j = sig.index + 1; j <= lastClosed; j++) {
      const c = candles[j];
      if (dir === 1 ? c.o <= sig.sl : c.o >= sig.sl) return { result: 'loss', r: rOf(c.o), exitIndex: j, exit: 'sl', tp1Hit };
      if (dir === 1 ? c.o >= sig.tp2 : c.o <= sig.tp2) return { result: 'win', r: rOf(c.o), exitIndex: j, exit: 'tp', tp1Hit: true };
      if (dir === 1 ? c.l <= sig.sl : c.h >= sig.sl) return { result: 'loss', r: -1, exitIndex: j, exit: 'sl', tp1Hit };
      if (dir === 1 ? c.h >= sig.tp2 : c.l <= sig.tp2) return { result: 'win', r: CONFIG.TARGET_R, exitIndex: j, exit: 'tp', tp1Hit: true };
      if (dir === 1 ? c.h >= sig.tp1 : c.l <= sig.tp1) tp1Hit = true;
      if (j - sig.index >= CONFIG.MAX_HOLD) {
        const r = rOf(c.c);
        return { result: r >= 0 ? 'win' : 'loss', r, exitIndex: j, exit: 'time', tp1Hit };
      }
    }
    return { result: 'open', r: null, exitIndex: null, exit: null, tp1Hit };
  }

  // cost = spread + slippage per trade in price units (differs per market).
  function backtest(candles, ind, lastClosed, useFilters = true, cost = CONFIG.COST_USD) {
    const trades = [], rejected = [];
    let i = 1;
    while (i <= lastClosed) {
      const sig = signalAt(ind, candles, i);
      if (sig && useFilters && !sig.passed) { rejected.push(sig); i++; continue; }
      if (sig) {
        const res = resolve(sig, candles, lastClosed);
        const costR = res.r == null ? 0 : cost / sig.slDist;
        trades.push({ ...sig, ...res, r: res.r == null ? null : res.r - costR });
        if (res.exitIndex == null) break; // still open, nothing after it
        i = res.exitIndex + 1;           // one trade at a time
      } else i++;
    }
    const closed = trades.filter(t => t.result !== 'open');
    const wins = closed.filter(t => t.r > 0);
    const grossWin = wins.reduce((s, t) => s + t.r, 0);
    const grossLoss = closed.filter(t => t.r <= 0).reduce((s, t) => s - t.r, 0);
    let streak = 0, maxStreak = 0, eq = 0, peak = 0, maxDD = 0;
    for (const t of closed) {
      if (t.r <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
      eq += t.r; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
    }
    return {
      trades, rejected, maxDD,
      count: closed.length,
      winRate: closed.length ? wins.length / closed.length : null,
      totalR: eq,
      profitFactor: grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : null),
      maxLossStreak: maxStreak,
    };
  }

  // Lot size. contract = dollars per 1.00 price move on 1.00 lot
  // (gold 100, silver 5000, EURUSD 100000, USDJPY 100000/price, BTC 1). Rounded DOWN to the 0.01 lot step so real risk never exceeds the chosen %.
  function lotSize(balance, riskPct, slDist, contract = 100) {
    if (!(balance > 0) || !(riskPct > 0) || !(slDist > 0) || !(contract > 0)) return { lots: 0, riskUsd: 0, minLotRisk: 0 };
    const riskUsd = balance * riskPct / 100;
    const lots = Math.floor((riskUsd / (slDist * contract)) * 100 + 1e-9) / 100;
    return { lots, riskUsd: lots * slDist * contract, minLotRisk: 0.01 * slDist * contract };
  }

  const api = {
    CONFIG, HOUR, isMarketClosed, marketCandles, ema, rsi, atr, htfTrend, computeAll, trendAt,
    filterChecks, signalAt, resolve, backtest, lotSize,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GS = api;
})(this);
