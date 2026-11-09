(function () {
  'use strict';
  const H = GS.HOUR;
  const $ = id => document.getElementById(id);

  // ---------- storage (wrapped: private mode / blocked storage must not break the app) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } },
  };

  const settings = {
    market: store.get('nt_market', 'XAUUSD'),
    platform: store.get('nt_platform', 'mt5'),
    balance: parseFloat(store.get('nt_balance', store.get('gs_balance', '1000'))) || 1000,
    risk: parseFloat(store.get('nt_risk', store.get('gs_risk', '1'))) || 1,
    contract: store.get('nt_contract', ''),
    key: store.get('nt_key', store.get('gs_key', '')),
    filter: store.get('nt_filter', store.get('gs_filter', '1')) === '1',
  };
  let inst = MARKETS.byId(settings.market);
  let timer = null, loading = false, lastView = null, loadSeq = 0, lastSource = '', lastData = null;

  // ---------- formatting ----------
  const fmtP = (n, d = inst.digits) => n == null || !isFinite(n) ? '—' : Number(n).toFixed(d);
  const fmt = (n, d = 2) => n == null || !isFinite(n) ? '—' : Number(n).toFixed(d);
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  const fmtTime = t => new Date(t).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const usdPerPoint = price => {
    const c = parseFloat(settings.contract);
    return c > 0 ? c * (inst.usdPerPoint(price) / inst.contract) : inst.usdPerPoint(price);
  };

  // ---------- data ----------
  async function fetchBinance(symbol) {
    let all = [], end = null;
    for (let p = 0; p < 4; p++) { // 4000 candles ~ 5.5 months
      const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000` + (end ? '&endTime=' + end : '');
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('Binance ' + res.status);
      const rows = await res.json();
      if (!rows.length) break;
      all = rows.concat(all);
      end = rows[0][0] - 1;
    }
    return all.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
  }

  async function fetchTwelve(symbol, key) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1h&outputsize=5000&timezone=UTC&apikey=${encodeURIComponent(key)}`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    if (data.status !== 'ok' || !Array.isArray(data.values)) throw new Error('TwelveData: ' + (data.message || 'error'));
    return data.values.slice().reverse().map(v => ({
      t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'), o: +v.open, h: +v.high, l: +v.low, c: +v.close,
    }));
  }

  async function loadCandles() {
    let candles, source;
    if (inst.td && settings.key) { candles = await fetchTwelve(inst.td, settings.key); source = 'TwelveData ' + inst.td; }
    else if (inst.binance) { candles = await fetchBinance(inst.binance); source = 'Binance ' + inst.binance; }
    else throw Object.assign(new Error(`${inst.name} ke liye TwelveData API key chahiye (Settings).`), { needKey: true });
    if (inst.closesWeekend) candles = GS.marketCandles(candles);
    if (candles.length < 300) throw new Error('Data kam hai (' + candles.length + ' candles)');
    return { candles, source };
  }

  // ---------- render ----------
  function render(candles, source) {
    const now = Date.now();
    const last = candles.length - 1;
    const lastClosed = candles[last].t + H > now ? last - 1 : last;
    const ind = GS.computeAll(candles);
    const btF = GS.backtest(candles, ind, lastClosed, true, inst.cost);
    const btN = GS.backtest(candles, ind, lastClosed, false, inst.cost);
    const bt = settings.filter ? btF : btN;
    const price = candles[last].c;
    lastView = { candles, ind, bt, lastClosed };

    // status + banner
    const closed = inst.closesWeekend && GS.isMarketClosed(now);
    const stale = !closed && now - (candles[last].t + H) > 2 * H;
    setStatus(closed ? 'closed' : stale ? 'err' : 'live', closed ? 'Market band' : stale ? 'Data purana' : 'Live');
    showBanner(closed ? 'Market abhi band hai (weekend). Naye signal market khulne par aayenge.'
      : stale ? 'Data ' + Math.round((now - candles[last].t) / H) + ' ghante purana hai. Internet ya data source check karein.' : '', stale);

    // hero
    $('price').textContent = fmtP(price);
    const ref = candles[Math.max(0, last - 24)].c;
    const ch = (price - ref) / ref * 100;
    $('change').innerHTML = `<span class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '▲' : '▼'} ${fmt(Math.abs(ch))}%</span> 24h`;
    lastSource = source;
    // Price label follows the chosen platform. Binance is only the price feed; MT5 users see the market name, not "Binance".
    const plat = PLATFORMS.byId(settings.platform);
    const onBinance = plat.kind.startsWith('binance');
    const proxy = source.startsWith('Binance') && !onBinance; // feed is not the broker's own price
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('source').textContent = (onBinance && source.startsWith('Binance') ? source : inst.id + ' live') + ' · ' + time;
    $('priceNote').textContent = proxy
      ? (inst.id === 'XAUUSD' ? plat.short + ' ki price is se 1-3$ alag ho sakti hai. SL/TP ka faasla apni entry par lagayein.'
        : plat.short + ' ki price is se thori alag ho sakti hai. SL/TP ka faasla apni entry par lagayein.')
      : '';
    $('priceNote').hidden = !proxy;

    // market stats
    const trend = GS.trendAt(ind, candles, lastClosed);
    $('mTrend').textContent = { up: 'Up ↑', down: 'Down ↓', side: 'Sideways', unknown: '—' }[trend];
    $('mHtf').textContent = { up: 'Up ↑', down: 'Down ↓' }[ind.htf[lastClosed]] || '—';
    $('mRsi').textContent = fmt(ind.rsi[lastClosed], 1);
    $('mAtr').textContent = fmtP(ind.atr[lastClosed]);

    renderSignal(candles, ind, bt, lastClosed, price, trend);
    drawChart();
    renderReport(candles, btF, btN, lastClosed);
  }

  function renderSignal(candles, ind, bt, lastClosed, price, trend) {
    const card = $('signalCard');
    card.classList.remove('buy', 'sell', 'wait');
    const lastTrade = bt.trades[bt.trades.length - 1];
    const active = lastTrade && lastTrade.result === 'open' ? lastTrade : null;
    $('lateWarn').hidden = true;

    if (!active) {
      card.classList.add('wait');
      $('signalText').textContent = 'WAIT';
      $('signalChip').textContent = 'Koi trade nahi';
      $('tradeBox').hidden = true;
      $('mt5Card').hidden = true;
      const raw = GS.signalAt(ind, candles, lastClosed);
      if (raw && settings.filter && !raw.passed) {
        $('signalNote').textContent = `${raw.side} signal bana lekin filter ne reject kar diya (fake ho sakta hai). Trade na lein.`;
        renderChecks(raw.checks);
      } else {
        $('signalNote').textContent = trend === 'side' ? 'Market sideways hai. Abhi trade na lein.'
          : trend === 'up' ? 'Uptrend hai. BUY setup ka intezar karein.'
          : trend === 'down' ? 'Downtrend hai. SELL setup ka intezar karein.' : 'Setup ka intezar karein.';
        $('checks').hidden = true;
      }
      return;
    }

    const dir = active.side === 'BUY' ? 1 : -1;
    const isNew = active.index === lastClosed;
    const progR = (price - active.entry) * dir / active.slDist;
    card.classList.add(active.side.toLowerCase());
    $('signalText').textContent = active.side;
    $('signalChip').textContent = isNew ? 'NAYA SIGNAL' : active.tp1Hit ? 'TP1 HIT' : 'TRADE CHAL RAHI';
    $('signalNote').textContent = 'Signal: ' + fmtTime(active.time + H) + ' (1H candle close)';

    // late entry / progress warnings
    let warn = '';
    if (active.tp1Hit) warn = 'TP1 ho chuka hai. Ab nayi entry na lein. Jinhon ne trade li hai wo SL entry par le aayein.';
    else if (!isNew && progR > 0.3) warn = `Price entry se ${fmt(progR, 1)}R aage ja chuki hai. Ab entry lene ka faida kam aur risk zyada hai.`;
    else if (progR < -0.5) warn = `Price SL ki taraf ja rahi hai (${fmt(progR, 1)}R). Nayi entry soch samajh kar lein.`;
    if (warn) { $('lateWarn').textContent = warn; $('lateWarn').hidden = false; }

    const order = PLATFORMS.orderFor(settings.platform, inst, active, {
      balance: settings.balance, riskPct: settings.risk, usdPerPoint: usdPerPoint(price), price,
    });
    // P/L uses the platform's size; if the market isn't on this platform, fall back to MT5 lots for the estimate.
    const sized = order.available ? order : PLATFORMS.orderFor('mt5', inst, active, { balance: settings.balance, riskPct: settings.risk, usdPerPoint: usdPerPoint(price), price });
    const riskUsd = sized.risk.usd;
    $('pnl').innerHTML = `Abhi: <b class="${progR >= 0 ? 'up' : 'down'}">${progR >= 0 ? '+' : ''}${fmt(progR, 2)}R</b> · ${money(progR * riskUsd)} (${esc(sized.sizeText)})`;

    const dist = (lvl, above) => `${fmtP(lvl)}<small>Entry se ${fmtP(Math.abs(lvl - active.entry))} ${above ? 'upar' : 'neeche'}</small>`;
    $('lvEntry').innerHTML = `${fmtP(active.entry)}<small>Broker par jo price mile</small>`;
    $('lvSL').innerHTML = dist(active.sl, dir < 0);
    $('lvTP1').innerHTML = dist(active.tp1, dir > 0);
    $('lvTP2').innerHTML = dist(active.tp2, dir > 0);
    $('tradeBox').hidden = false;
    renderChecks(settings.filter ? active.checks : null);

    renderOrder(order);
    maybeNotify(active);
  }

  function renderOrder(order) {
    $('mt5Card').hidden = false;
    $('orderTitle').textContent = order.title;
    $('mt5Symbol').textContent = inst.id;
    $('orderNA').hidden = order.available;
    $('orderGrid').hidden = $('mtRisk').hidden = $('orderHow').hidden = !order.available;
    if (!order.available) { $('orderNA').textContent = order.reason; return; }
    $('orderGrid').innerHTML = order.fields.map((f, i) =>
      `<div><span>${esc(f.label)}</span><b id="of${i}">${esc(f.value)}</b>${f.copy ? `<button class="copy" data-copy="of${i}" type="button">Copy</button>` : ''}</div>`).join('');
    const r = order.risk;
    const extra = order.extra.filter(x => !(x.startsWith('Gold = PAXGUSDT') && !lastSource.startsWith('Binance')));
    $('mtRisk').innerHTML = `Risk: <span class="${r.tooBig ? 'bad' : ''}">${money(r.usd)} (${fmt(r.pct, 1)}%)</span>`
      + extra.map(x => ' · ' + esc(x)).join('')
      + (r.tooBig ? `<br><span class="bad">Balance ke hisaab se sab se chhota order bhi ${fmt(settings.risk, 1)}% se zyada risk hai.</span>` : '');
    $('orderHowTitle').textContent = order.platform.short + ' mein kaise lagayein';
    $('orderSteps').innerHTML = order.steps.map(x => `<li>${x}</li>`).join(''); // steps are built by platforms.js from numbers only
  }

  function renderChecks(checks) {
    const el = $('checks');
    if (!checks) { el.hidden = true; return; }
    el.innerHTML = checks.map(c => `<li class="${c.ok ? '' : 'bad'}">${esc(c.label)}</li>`).join('');
    el.hidden = false;
  }

  function renderReport(candles, btF, btN, lastClosed) {
    const v = inst.tested;
    $('verdictCard').className = 'card verdict ' + v;
    $('verdictText').textContent = { strong: 'Mazboot ✓', weak: 'Kamzor ⚠', loss: 'Ghaata ✗' }[v] + ' · ' + inst.id;
    const pfTxt = btF.profitFactor == null ? '—' : btF.profitFactor === Infinity ? '∞' : fmt(btF.profitFactor);
    $('verdictNote').textContent = MARKETS.TEST_NOTE[v] + ` Pichle ${Math.round((candles[lastClosed].t - candles[0].t) / (24 * H))} din: profit factor ${pfTxt}.`;

    $('bPeriod').textContent = Math.round((candles[lastClosed].t - candles[0].t) / (24 * H)) + ' din';
    const days = (candles[lastClosed].t - candles[0].t) / (24 * H);
    const pct = b => b.winRate == null ? '—' : Math.round(b.winRate * 100) + '%';
    const r = b => (b.totalR >= 0 ? '+' : '') + fmt(b.totalR, 1) + 'R';
    const pf = b => b.profitFactor == null ? '—' : b.profitFactor === Infinity ? '∞' : fmt(b.profitFactor);
    const rows = [
      ['Trades', b => b.count], ['Har mahine', b => fmt(b.count / days * 30, 1)], ['Win rate', pct], ['Total', r],
      ['Profit factor', pf], ['Max girawat', b => '-' + fmt(b.maxDD, 1) + 'R'], ['Lagatar loss', b => b.maxLossStreak],
    ];
    $('btBody').innerHTML = rows.map(([n, f]) => `<tr><td>${n}</td><td>${f(btF)}</td><td>${f(btN)}</td></tr>`).join('');

    const bt = settings.filter ? btF : btN;
    const hist = bt.trades.slice(-12).reverse();
    $('history').innerHTML = hist.length ? hist.map(t => {
      const label = t.result === 'open' ? (t.tp1Hit ? 'TP1 hit, chal rahi' : 'Chal rahi')
        : { tp: 'TP2', sl: t.tp1Hit ? 'SL (TP1 ke baad)' : 'SL', time: 'Time' }[t.exit] + ' ' + (t.r > 0 ? '+' : '') + fmt(t.r, 1) + 'R';
      const cls = t.result === 'open' ? 'open' : t.r > 0 ? 'win' : 'loss';
      return `<li><span><span class="tag ${t.side.toLowerCase()}">${t.side}</span> ${fmtP(t.entry)} · ${fmtTime(t.time + H)}</span><span class="res ${cls}">${label}</span></li>`;
    }).join('') : '<li class="muted">Is data mein koi signal nahi bana.</li>';
  }

  // ---------- chart ----------
  function drawChart() {
    if (!lastView) return;
    const cv = $('chart'), ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, Hh = cv.clientHeight;
    if (!W) return; // tab hidden
    cv.width = W * dpr; cv.height = Hh * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, Hh);
    const { candles, ind, bt } = lastView;
    const N = Math.min(72, candles.length), s = candles.length - N;
    const vis = candles.slice(s);
    const active = bt.trades.length && bt.trades[bt.trades.length - 1].result === 'open' ? bt.trades[bt.trades.length - 1] : null;
    let lo = Math.min(...vis.map(c => c.l)), hi = Math.max(...vis.map(c => c.h));
    if (active) { lo = Math.min(lo, active.sl, active.tp2); hi = Math.max(hi, active.sl, active.tp2); }
    const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    const right = 54, plotW = W - right, cw = plotW / N;
    const y = p => (hi - p) / (hi - lo) * Hh;
    const css = getComputedStyle(document.documentElement);
    const col = n => css.getPropertyValue(n).trim();

    // label positions of trade levels, used to keep the right-hand labels from overlapping
    const levelYs = active ? [active.tp2, active.tp1, active.entry, active.sl].map(p => y(p)) : [];
    const lastY = y(candles[candles.length - 1].c);
    const busy = yy => levelYs.concat([lastY]).some(v => Math.abs(v - yy) < 13);

    // grid + price labels
    ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = col('--muted'); ctx.strokeStyle = col('--line'); ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const p = lo + (hi - lo) * k / 4, yy = Math.round(y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      if (!busy(yy)) ctx.fillText(fmtP(p), plotW + 4, Math.min(Hh - 2, Math.max(10, yy + 3)));
    }
    // candles
    vis.forEach((c, k) => {
      const x = k * cw + cw / 2, upC = c.c >= c.o;
      ctx.strokeStyle = ctx.fillStyle = upC ? col('--buy') : col('--sell');
      ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
      const bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
      ctx.fillRect(x - Math.max(1, cw * 0.32), Math.min(y(c.o), y(c.c)), Math.max(2, cw * 0.64), bh);
    });
    // EMAs
    const line = (arr, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath(); let started = false;
      for (let k = 0; k < N; k++) { const v = arr[s + k]; if (v == null) continue; const x = k * cw + cw / 2;
        if (!started) { ctx.moveTo(x, y(v)); started = true; } else ctx.lineTo(x, y(v)); }
      ctx.stroke(); ctx.lineWidth = 1;
    };
    line(ind.e21, '#5aa9ff'); line(ind.e50, '#c084fc');
    // trade markers
    for (const t of bt.trades) {
      if (t.index < s) continue;
      const x = (t.index - s) * cw + cw / 2, c = candles[t.index], buy = t.side === 'BUY';
      ctx.fillStyle = buy ? col('--buy') : col('--sell');
      const yy = buy ? y(c.l) + 10 : y(c.h) - 10;
      ctx.beginPath();
      if (buy) { ctx.moveTo(x, yy - 6); ctx.lineTo(x - 5, yy + 3); ctx.lineTo(x + 5, yy + 3); }
      else { ctx.moveTo(x, yy + 6); ctx.lineTo(x - 5, yy - 3); ctx.lineTo(x + 5, yy - 3); }
      ctx.fill();
    }
    // active levels
    if (active) {
      const lvl = (p, color, text) => {
        const yy = Math.round(y(p)) + 0.5;
        ctx.setLineDash([4, 3]); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = color; ctx.fillRect(plotW, yy - 7, right, 14);
        ctx.fillStyle = '#0b0d12'; ctx.font = 'bold 9px system-ui, sans-serif'; ctx.fillText(text, plotW + 3, yy + 3);
      };
      lvl(active.tp2, col('--buy'), 'TP2'); lvl(active.tp1, col('--buy'), 'TP1');
      lvl(active.entry, col('--gold'), 'ENTRY'); lvl(active.sl, col('--sell'), 'SL');
    }
    // last price: line across the plot, label nudged off any level label it would cover
    const lp = candles[candles.length - 1].c;
    let ly = Math.round(lastY) + 0.5;
    ctx.strokeStyle = col('--text'); ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke(); ctx.globalAlpha = 1;
    for (let tries = 0; tries < 4; tries++) {
      const hit = levelYs.find(v => Math.abs(v - ly) < 14);
      if (hit == null) break;
      ly = hit + (ly >= hit ? 14 : -14);
    }
    ly = Math.min(Hh - 7, Math.max(7, ly));
    ctx.fillStyle = col('--text'); ctx.fillRect(plotW, ly - 7, right, 14);
    ctx.fillStyle = '#0b0d12'; ctx.font = 'bold 9px system-ui, sans-serif'; ctx.fillText(fmtP(lp), plotW + 3, ly + 3);
  }

  // ---------- notifications (in-app; cloud ntfy handles the app-closed case) ----------
  async function showNotification(title, body) {
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) { await reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'nt-signal', renotify: true, vibrate: [200, 100, 200] }); return true; }
      new Notification(title, { body, icon: 'icons/icon-192.png' });
      return true;
    } catch { return false; }
  }

  async function maybeNotify(sig) {
    const key = 'nt_alert_' + inst.id, id = sig.time + sig.side;
    const prev = store.get(key, null);
    if (prev === String(id)) return;
    store.set(key, id);
    if (prev === null) return; // first time this market is opened: don't alert for an old running trade
    beep();
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    showNotification(`${inst.id} ${sig.side} signal`,
      `Entry ${fmtP(sig.entry)} | SL ${fmtP(sig.sl)} | TP1 ${fmtP(sig.tp1)} | TP2 ${fmtP(sig.tp2)}`);
  }

  function beep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach(d => { const o = ac.createOscillator(), g = ac.createGain(); o.connect(g); g.connect(ac.destination);
        o.frequency.value = 880; g.gain.value = 0.12; o.start(ac.currentTime + d); o.stop(ac.currentTime + d + 0.18); });
    } catch { /* blocked */ }
  }

  function showNotifyState() {
    const el = $('notifyState');
    if (!('Notification' in window)) { el.textContent = 'Is browser mein notifications nahi hain. Mobile alerts ke liye ntfy use karein.'; return; }
    el.textContent = {
      granted: 'ON hain. App khuli ya background mein ho to naye signal par alert aayega.',
      denied: 'Block hain. Phone settings → Apps → Chrome/Naseem Trader → Notifications allow karein.',
      default: 'Abhi OFF hain.',
    }[Notification.permission];
  }

  // Wipe everything that belongs to the previous market so no stale numbers are ever shown.
  function clearView(note) {
    lastView = null;
    ['price', 'change', 'source', 'signalText', 'signalChip', 'mTrend', 'mHtf', 'mRsi', 'mAtr', 'bPeriod', 'verdictText']
      .forEach(id => ($(id).textContent = '—'));
    $('signalNote').textContent = note || '';
    $('verdictNote').textContent = '';
    $('signalCard').classList.remove('buy', 'sell', 'wait');
    ['tradeBox', 'mt5Card', 'checks', 'lateWarn', 'priceNote'].forEach(id => ($(id).hidden = true));
    $('btBody').innerHTML = '<tr><td colspan="3" class="muted">—</td></tr>';
    $('history').innerHTML = '<li class="muted">—</li>';
    const cv = $('chart'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  }

  // ---------- UI helpers ----------
  function setStatus(kind, text) { $('statusDot').className = 'dot ' + kind; $('statusText').textContent = text; }
  function showBanner(text, isErr) { const b = $('banner'); b.textContent = text; b.hidden = !text; b.classList.toggle('err', !!isErr); }
  let toastT;
  function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 1800); }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
    }
    toast('Copy ho gaya: ' + text);
  }

  function showTab(name) {
    document.querySelectorAll('.tab').forEach(t => (t.hidden = t.id !== 'tab-' + name));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    store.set('nt_tab', name);
    window.scrollTo(0, 0);
    if (name === 'signal') requestAnimationFrame(drawChart);
  }

  function applyMarketUI() {
    $('marketPill').textContent = inst.id + ' · 1H · ' + PLATFORMS.byId(settings.platform).short;
    const topic = MARKETS.topicFor(inst.id);
    $('topic').textContent = topic;
    $('ntfyLink').href = 'https://ntfy.sh/' + topic;
    $('setContract').placeholder = 'Default: ' + inst.contract;
    const needKey = inst.td && !inst.binance;
    $('marketHint').textContent = MARKETS.TEST_NOTE[inst.tested] + (needKey ? ' Is market ke liye TwelveData key zaroori hai.' : '');
  }

  // ---------- loop ----------
  let pending = false;
  async function refresh() {
    if (loading) { pending = true; return; } // run again once the current load finishes
    loading = true; pending = false;
    const seq = ++loadSeq, forInst = inst.id;
    $('btnRefresh').classList.add('spin');
    try {
      const { candles, source } = await loadCandles();
      if (seq !== loadSeq || forInst !== inst.id) return; // market changed meanwhile
      lastData = { candles, source };
      render(candles, source);
    } catch (e) {
      setStatus('err', 'Error');
      showBanner((e.needKey ? '' : 'Data load nahi hua: ') + e.message, true);
      if (e.needKey) clearView('Settings mein TwelveData key daalein.');
    } finally {
      loading = false;
      $('btnRefresh').classList.remove('spin');
      if (pending) refresh();
    }
  }

  function schedule() {
    clearInterval(timer);
    const usingTD = inst.td && settings.key;
    timer = setInterval(refresh, usingTD ? 5 * 60 * 1000 : 60 * 1000); // TwelveData free: 800 calls/day
  }

  // ---------- init ----------
  $('setMarket').innerHTML = MARKETS.INSTRUMENTS.map(m =>
    `<option value="${m.id}">${m.name} (${m.id})${m.tested === 'strong' ? ' ✓ Mazboot' : m.tested === 'loss' ? ' ✗ Ghaata' : ' ⚠ Kamzor'}</option>`).join('');
  $('setMarket').value = inst.id;
  $('setPlatform').innerHTML = PLATFORMS.PLATFORMS.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  $('setPlatform').value = PLATFORMS.byId(settings.platform).id;
  const platformHint = () => {
    const p = PLATFORMS.byId($('setPlatform').value);
    const m = MARKETS.byId($('setMarket').value);
    const na = p.kind.startsWith('binance') && !PLATFORMS.BINANCE[m.id];
    $('platformHint').innerHTML = esc(p.hint) + (na ? `<br><span class="bad">${esc(m.name)} Binance par nahi milta. Is market ke liye MT5 chunein.</span>` : '');
  };
  platformHint();
  $('setPlatform').addEventListener('change', platformHint);
  $('setBalance').value = settings.balance;
  $('setRisk').value = settings.risk;
  $('setContract').value = settings.contract;
  $('setKey').value = settings.key;
  $('setFilter').checked = settings.filter;
  applyMarketUI();

  $('setMarket').addEventListener('change', () => {
    const m = MARKETS.byId($('setMarket').value);
    $('marketHint').textContent = MARKETS.TEST_NOTE[m.tested] + (m.td && !m.binance ? ' Is market ke liye TwelveData key zaroori hai.' : '');
    platformHint();
  });

  $('btnSave').addEventListener('click', () => {
    const b = parseFloat($('setBalance').value), r = parseFloat($('setRisk').value), c = $('setContract').value.trim();
    const changedMarket = settings.market !== $('setMarket').value;
    settings.market = $('setMarket').value;
    settings.platform = $('setPlatform').value;
    settings.balance = b > 0 ? b : 1000;
    settings.risk = r > 0 && r <= 5 ? r : 1;
    settings.contract = parseFloat(c) > 0 ? c : '';
    settings.key = $('setKey').value.trim();
    settings.filter = $('setFilter').checked;
    store.set('nt_market', settings.market); store.set('nt_balance', settings.balance); store.set('nt_risk', settings.risk);
    store.set('nt_contract', settings.contract); store.set('nt_key', settings.key); store.set('nt_filter', settings.filter ? '1' : '0'); store.set('nt_platform', settings.platform);
    $('setBalance').value = settings.balance; $('setRisk').value = settings.risk; $('setContract').value = settings.contract;
    inst = MARKETS.byId(settings.market);
    if (changedMarket) { clearView('Loading…'); lastData = null; }
    else if (lastData) render(lastData.candles, lastData.source); // platform/risk change shows instantly
    applyMarketUI();
    toast('Save ho gaya' + (changedMarket ? ': ab ' + inst.id + ' ke signal' : ''));
    schedule();
    refresh();
    if (changedMarket) showTab('signal');
  });

  $('orderGrid').addEventListener('click', e => {
    const btn = e.target.closest('.copy[data-copy]');
    if (btn) copyText($(btn.dataset.copy).textContent);
  });
  $('copyTopic').addEventListener('click', () => copyText($('topic').textContent));

  $('btnNotify').addEventListener('click', async () => {
    if (!('Notification' in window)) return showNotifyState();
    await Notification.requestPermission();
    showNotifyState();
  });
  $('btnTestNotify').addEventListener('click', async () => {
    if (!('Notification' in window) || Notification.permission !== 'granted') { toast('Pehle Notifications ON karein'); return; }
    beep();
    const ok = await showNotification('Naseem Trader test', inst.id + ' alerts theek kaam kar rahe hain.');
    toast(ok ? 'Test alert bhej diya' : 'Notification nahi ja saka');
  });

  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('marketPill').addEventListener('click', () => showTab('settings'));
  $('btnRefresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('resize', () => requestAnimationFrame(drawChart));

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  showTab(store.get('nt_tab', 'signal'));
  showNotifyState();
  schedule();
  refresh();
})();
