// Pure indicator + strategy + backtest logic. No DOM here, so it can be tested in Node too.
(function (root) {
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

  const SL_ATR = 1.5;   // stop distance in ATRs
  const TARGET_R = 2;   // backtest exit target in R
  const MAX_HOLD = 72;  // candles (3 days on 1H) before a trade is closed at market

  const H4 = 4 * 3600 * 1000;

  // 4H EMA50 trend built from 1H candles. At 1H index i only 4H bars that have fully closed are used.
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
      const closedAt = candles[i].t + 3600 * 1000; // close time of this 1H candle
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

  // Fake-signal filters. Chosen because they improved results on BOTH halves of ~11 months of data
  // (ADX and session filters were tested too and made results worse, so they are not used).
  function filterChecks(ind, candles, i, side) {
    const c = candles[i], dir = side === 'BUY' ? 1 : -1, range = c.h - c.l;
    return [
      { key: 'htf', label: '4H trend bhi ' + (dir === 1 ? 'up' : 'down') + ' hai',
        ok: ind.htf[i] === (dir === 1 ? 'up' : 'down') },
      { key: 'body', label: 'Signal candle mazboot hai (body > 50%)',
        ok: range > 0 && (c.c - c.o) * dir > 0.5 * range },
      { key: 'ext', label: 'Price EMA21 se zyada door nahi (< 1 ATR)',
        ok: Math.abs(c.c - ind.e21[i]) < ind.atr[i] },
    ];
  }

  function trendAt(ind, candles, i) {
    const { e50, e200 } = ind;
    if (e200[i] == null) return 'unknown';
    if (e50[i] > e200[i] && candles[i].c > e200[i]) return 'up';
    if (e50[i] < e200[i] && candles[i].c < e200[i]) return 'down';
    return 'side';
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
    if (trend === 'up' && crossUp && r[i] > 50 && r[i] < 70) side = 'BUY';
    if (trend === 'down' && crossDn && r[i] < 50 && r[i] > 30) side = 'SELL';
    if (!side) return null;
    const entry = candles[i].c;
    const dist = a[i] * SL_ATR;
    const dir = side === 'BUY' ? 1 : -1;
    const checks = filterChecks(ind, candles, i, side);
    return {
      index: i, time: candles[i].t, side, entry,
      sl: entry - dir * dist, tp1: entry + dir * dist, tp2: entry + dir * dist * TARGET_R,
      slDist: dist, checks, passed: checks.every(x => x.ok),
    };
  }

  // Walk forward from the signal: SL first if both are touched in the same candle (conservative).
  function resolve(sig, candles, lastClosed) {
    const dir = sig.side === 'BUY' ? 1 : -1;
    for (let j = sig.index + 1; j <= lastClosed; j++) {
      const c = candles[j];
      const hitSL = dir === 1 ? c.l <= sig.sl : c.h >= sig.sl;
      const hitTP = dir === 1 ? c.h >= sig.tp2 : c.l <= sig.tp2;
      if (hitSL) return { result: 'loss', r: -1, exitIndex: j };
      if (hitTP) return { result: 'win', r: TARGET_R, exitIndex: j };
      if (j - sig.index >= MAX_HOLD) {
        const r = (c.c - sig.entry) * dir / sig.slDist;
        return { result: r >= 0 ? 'win' : 'loss', r, exitIndex: j, timeout: true };
      }
    }
    return { result: 'open', r: null, exitIndex: null };
  }

  function backtest(candles, ind, lastClosed, useFilters = true) {
    const trades = [];
    const rejected = [];
    let i = 1;
    while (i <= lastClosed) {
      const sig = signalAt(ind, candles, i);
      if (sig && useFilters && !sig.passed) { rejected.push(sig); i++; continue; }
      if (sig) {
        const res = resolve(sig, candles, lastClosed);
        trades.push({ ...sig, ...res });
        if (res.exitIndex == null) break; // still open, nothing after it
        i = res.exitIndex + 1;           // one trade at a time
      } else i++;
    }
    const closed = trades.filter(t => t.result !== 'open');
    const wins = closed.filter(t => t.r > 0);
    const grossWin = wins.reduce((s, t) => s + t.r, 0);
    const grossLoss = closed.filter(t => t.r <= 0).reduce((s, t) => s - t.r, 0);
    let streak = 0, maxStreak = 0;
    for (const t of closed) { if (t.r <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
    let eq = 0, peak = 0, maxDD = 0;
    for (const t of closed) { eq += t.r; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
    return {
      trades,
      rejected,
      maxDD,
      count: closed.length,
      winRate: closed.length ? wins.length / closed.length : null,
      totalR: closed.reduce((s, t) => s + t.r, 0),
      profitFactor: grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : null),
      maxLossStreak: maxStreak,
    };
  }

  // Gold: 1 standard lot = 100 oz, so $1 move = $100 per lot.
  function lotSize(balance, riskPct, slDist) {
    if (!(balance > 0) || !(riskPct > 0) || !(slDist > 0)) return { lots: 0, riskUsd: 0 };
    const riskUsd = balance * riskPct / 100;
    const lots = Math.floor((riskUsd / (slDist * 100)) * 100) / 100; // round DOWN to 0.01
    return { lots, riskUsd: lots * slDist * 100 };
  }

  const api = { ema, rsi, atr, htfTrend, filterChecks, computeAll, trendAt, signalAt, resolve, backtest, lotSize, SL_ATR, TARGET_R };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GS = api;
})(this);
