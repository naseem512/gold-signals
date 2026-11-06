(function () {
  const HOUR = 3600 * 1000;
  const $ = id => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };

  let settings = {
    balance: parseFloat(store.get('gs_balance', '1000')),
    risk: parseFloat(store.get('gs_risk', '1')),
    key: store.get('gs_key', ''),
    filter: store.get('gs_filter', '1') === '1',
  };
  let timer = null;
  let loading = false;

  const fmt = (n, d = 2) => n == null || !isFinite(n) ? '—' : Number(n).toFixed(d);
  const fmtTime = t => new Date(t).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  // ---------- data ----------
  // 4 pages x 1000 candles = ~5.5 months, enough for a meaningful backtest.
  async function fetchBinance() {
    let all = [], end = null;
    for (let p = 0; p < 4; p++) {
      const url = 'https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=1h&limit=1000' + (end ? '&endTime=' + end : '');
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('Binance error ' + res.status);
      const rows = await res.json();
      if (!rows.length) break;
      all = rows.concat(all);
      end = rows[0][0] - 1;
    }
    return all.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
  }

  async function fetchTwelve(key) {
    const url = 'https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1h&outputsize=5000&timezone=UTC&apikey=' + encodeURIComponent(key);
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    if (data.status !== 'ok' || !Array.isArray(data.values)) throw new Error('TwelveData: ' + (data.message || 'error'));
    return data.values.slice().reverse().map(v => ({
      t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'),
      o: +v.open, h: +v.high, l: +v.low, c: +v.close,
    }));
  }

  // ---------- render ----------
  function render(candles, sourceLabel) {
    const last = candles.length - 1;
    // Last candle is still forming if its hour has not finished yet.
    const lastClosed = candles[last].t + HOUR > Date.now() ? last - 1 : last;
    const ind = GS.computeAll(candles);
    const btF = GS.backtest(candles, ind, lastClosed, true);
    const btN = GS.backtest(candles, ind, lastClosed, false);
    const bt = settings.filter ? btF : btN;

    $('source').textContent = sourceLabel;
    $('price').textContent = '$' + fmt(candles[last].c);
    $('updated').textContent = 'Update: ' + new Date().toLocaleTimeString();

    // Market state
    const trend = GS.trendAt(ind, candles, lastClosed);
    const trendTxt = { up: 'Up ↑', down: 'Down ↓', side: 'Sideways', unknown: '—' }[trend];
    $('mTrend').textContent = trendTxt;
    $('mRsi').textContent = fmt(ind.rsi[lastClosed], 1);
    $('mAtr').textContent = fmt(ind.atr[lastClosed]);

    // Current signal / open trade
    const card = $('signalCard');
    card.classList.remove('buy', 'sell', 'wait');
    const lastTrade = bt.trades[bt.trades.length - 1];
    const active = lastTrade && lastTrade.result === 'open' ? lastTrade : null;

    if (active) {
      const isNew = active.index === lastClosed;
      card.classList.add(active.side.toLowerCase());
      $('signalText').textContent = active.side;
      $('signalNote').textContent = isNew
        ? 'Naya signal: ' + fmtTime(active.time + HOUR) + ' par candle band hui.'
        : 'Signal ' + fmtTime(active.time + HOUR) + ' par aaya tha aur trade abhi chal rahi hai. Agar entry nahi li to price entry se door ho sakti hai, dhyan se.';
      const lot = GS.lotSize(settings.balance, settings.risk, active.slDist);
      $('lvEntry').textContent = fmt(active.entry);
      $('lvSL').textContent = fmt(active.sl);
      $('lvTP1').textContent = fmt(active.tp1);
      $('lvTP2').textContent = fmt(active.tp2);
      if (lot.lots > 0) {
        $('lvLot').textContent = lot.lots.toFixed(2);
        $('lvRisk').textContent = '$' + fmt(lot.riskUsd) + ' (' + fmt(active.slDist) + ' pts)';
      } else {
        // Even the minimum 0.01 lot risks more than the chosen %.
        const minRisk = active.slDist; // 0.01 lot = 1 oz, so $1 per point
        $('lvLot').textContent = '0.01 (min)';
        $('lvRisk').innerHTML = '<span class="error">$' + fmt(minRisk) + ' = ' + fmt(minRisk / settings.balance * 100, 1) + '% risk</span>';
      }
      $('levels').hidden = false;
      renderChecks(active.checks);
      maybeNotify(active);
    } else {
      card.classList.add('wait');
      $('signalText').textContent = 'WAIT';
      const raw = GS.signalAt(ind, candles, lastClosed);
      if (raw && settings.filter && !raw.passed) {
        // A raw signal formed on the last closed candle but the filters rejected it.
        $('signalNote').textContent = raw.side + ' signal bana tha lekin filter ne reject kar diya (fake ho sakta hai). Trade na lein.';
        renderChecks(raw.checks);
      } else {
        $('signalNote').textContent = trend === 'side'
          ? 'Market sideways hai, koi setup nahi. Abhi trade na lein.'
          : 'Koi naya setup nahi. ' + (trend === 'up' ? 'Uptrend hai, sirf BUY setup ka intezar karein.' : trend === 'down' ? 'Downtrend hai, sirf SELL setup ka intezar karein.' : '');
        $('checks').hidden = true;
      }
      $('levels').hidden = true;
    }

    // Backtest: filtered vs unfiltered side by side
    $('bPeriod').textContent = Math.round((candles[lastClosed].t - candles[0].t) / (24 * HOUR)) + ' din';
    const pct = b => b.winRate == null ? '—' : Math.round(b.winRate * 100) + '%';
    const r = b => (b.totalR >= 0 ? '+' : '') + fmt(b.totalR, 1) + 'R';
    const pf = b => b.profitFactor === Infinity ? '∞' : fmt(b.profitFactor);
    const rows = [
      ['Trades', b => b.count], ['Win rate', pct], ['Total', r], ['Profit factor', pf],
      ['Max girawat', b => '-' + fmt(b.maxDD, 1) + 'R'], ['Lagatar loss', b => b.maxLossStreak],
    ];
    $('btBody').innerHTML = rows.map(([name, f]) => `<tr><td>${name}</td><td>${f(btF)}</td><td>${f(btN)}</td></tr>`).join('');

    // History (newest first)
    const hist = bt.trades.slice(-10).reverse();
    $('history').innerHTML = hist.length ? hist.map(t => {
      const res = t.result === 'open' ? '<span class="res open">Chal rahi</span>'
        : `<span class="res ${t.r > 0 ? 'win' : 'loss'}">${t.r > 0 ? '+' : ''}${fmt(t.r, 1)}R${t.timeout ? ' (time)' : ''}</span>`;
      return `<li><span><span class="tag ${t.side.toLowerCase()}">${t.side}</span> ${fmt(t.entry)} · ${fmtTime(t.time + HOUR)}</span>${res}</li>`;
    }).join('') : '<li class="muted">Is data mein koi signal nahi bana.</li>';
  }

  function renderChecks(checks) {
    const el = $('checks');
    if (!settings.filter || !checks) { el.hidden = true; return; }
    el.innerHTML = checks.map(c => `<li class="${c.ok ? '' : 'bad'}">${c.label}</li>`).join('');
    el.hidden = false;
  }

  // ---------- alerts ----------
  async function maybeNotify(sig) {
    const id = String(sig.time) + sig.side;
    if (store.get('gs_last_alert', '') === id) return;
    const firstRun = store.get('gs_last_alert', null) === null;
    store.set('gs_last_alert', id);
    if (firstRun) return; // don't alert for a trade that was already running when the app was first opened
    beep();
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const body = `Entry ${fmt(sig.entry)} | SL ${fmt(sig.sl)} | TP ${fmt(sig.tp2)}`;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification('Gold ' + sig.side + ' signal', { body, icon: 'icons/icon-192.png', tag: 'gs-signal' });
      else new Notification('Gold ' + sig.side + ' signal', { body });
    } catch { /* notifications unavailable */ }
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.15;
      o.start(); o.stop(ctx.currentTime + 0.4);
    } catch { /* audio blocked */ }
  }

  function showNotifyState() {
    const el = $('notifyState');
    if (!('Notification' in window)) { el.textContent = 'Is browser mein notifications support nahi hain.'; return; }
    el.textContent = {
      granted: 'Alerts ON hain. App khuli rahe (ya background mein) to naye signal par alert aayega.',
      denied: 'Alerts block hain. Browser settings se is site ke notifications allow karein.',
      default: 'Naye signal par alert ke liye "Alerts ON karein" dabayein.',
    }[Notification.permission];
  }

  // ---------- loop ----------
  async function refresh() {
    if (loading) return;
    loading = true;
    $('btnRefresh').classList.add('spin');
    try {
      if (settings.key) render(await fetchTwelve(settings.key), 'TwelveData · XAU/USD spot');
      else render(await fetchBinance(), 'Binance · PAXG/USDT (gold ke saath chalta hai)');
    } catch (e) {
      $('source').innerHTML = '<span class="error">Data load nahi hua: ' + String(e.message || e).replace(/</g, '&lt;') + '</span>';
    } finally {
      loading = false;
      $('btnRefresh').classList.remove('spin');
    }
  }

  function schedule() {
    clearInterval(timer);
    // TwelveData free plan = 800 calls/day, so poll every 5 min; Binance every 1 min.
    timer = setInterval(refresh, settings.key ? 5 * 60 * 1000 : 60 * 1000);
  }

  // ---------- init ----------
  $('setBalance').value = settings.balance;
  $('setRisk').value = settings.risk;
  $('setKey').value = settings.key;
  $('setFilter').checked = settings.filter;

  $('btnSave').addEventListener('click', () => {
    const b = parseFloat($('setBalance').value), r = parseFloat($('setRisk').value);
    settings.balance = b > 0 ? b : 1000;
    settings.risk = r > 0 && r <= 5 ? r : 1;
    settings.key = $('setKey').value.trim();
    settings.filter = $('setFilter').checked;
    store.set('gs_filter', settings.filter ? '1' : '0');
    store.set('gs_balance', settings.balance);
    store.set('gs_risk', settings.risk);
    store.set('gs_key', settings.key);
    $('setBalance').value = settings.balance;
    $('setRisk').value = settings.risk;
    $('btnSave').textContent = 'Saved ✓';
    setTimeout(() => ($('btnSave').textContent = 'Save'), 1500);
    schedule();
    refresh();
  });

  $('btnNotify').addEventListener('click', async () => {
    if (!('Notification' in window)) return showNotifyState();
    await Notification.requestPermission();
    showNotifyState();
  });

  $('btnRefresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  showNotifyState();
  schedule();
  refresh();
})();
