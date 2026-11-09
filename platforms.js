// Trading platforms: turns a signal into the exact order to place on the platform the user trades on.
// Shared by the web app (window.PLATFORMS) and the tests (Node).
(function (root) {
  'use strict';

  // Binance symbols per market (USDT pairs). Gold = PAXG (1 PAXG = 1 troy ounce of gold).
  // stepFut / stepSpot: smallest quantity step on Binance (rounded down to this).
  const BINANCE = {
    XAUUSD: { symbol: 'PAXGUSDT', coin: 'PAXG', stepFut: 0.001, stepSpot: 0.0001 },
    BTCUSD: { symbol: 'BTCUSDT', coin: 'BTC', stepFut: 0.001, stepSpot: 0.00001 },
    ETHUSD: { symbol: 'ETHUSDT', coin: 'ETH', stepFut: 0.001, stepSpot: 0.0001 },
  };

  const PLATFORMS = [
    { id: 'mt5', name: 'MetaTrader 5 (MT5)', kind: 'mt', short: 'MT5',
      hint: 'Exness, XM, IC Markets jaise brokers. Lot, SL aur TP seedha MT5 order mein daalein.' },
    { id: 'mt4', name: 'MetaTrader 4 (MT4)', kind: 'mt', short: 'MT4',
      hint: 'MT5 jaisa hi. Lot, SL aur TP seedha MT4 order mein daalein.' },
    { id: 'ctrader', name: 'cTrader', kind: 'ctrader', short: 'cTrader',
      hint: 'Pepperstone, IC Markets, FxPro waghera. Lot aur SL/TP ki price daalein.' },
    { id: 'binance-futures', name: 'Binance Futures (USDⓈ-M)', kind: 'binance-futures', short: 'Binance Futures',
      hint: 'Sirf Gold (PAXGUSDT), BTC aur ETH. BUY aur SELL dono ho sakte hain. Quantity coin mein hoti hai.' },
    { id: 'binance-spot', name: 'Binance Spot', kind: 'binance-spot', short: 'Binance Spot',
      hint: 'Sirf Gold (PAXG), BTC aur ETH, aur sirf BUY. Spot par SELL (short) nahi hota.' },
    { id: 'other', name: 'Koi aur broker / app', kind: 'other', short: 'Broker',
      hint: 'Kisi bhi app ke liye: direction, entry, SL, TP aur standard lot.' },
  ];

  const byId = id => PLATFORMS.find(p => p.id === id) || PLATFORMS[0];
  const floorTo = (x, step) => Math.floor(x / step + 1e-9) * step;
  const decimals = step => Math.max(0, Math.round(-Math.log10(step)));

  /**
   * Build the order for one platform.
   * @param platformId  id from PLATFORMS
   * @param inst        instrument from instruments.js
   * @param sig         open trade { side, entry, sl, tp1, tp2, slDist }
   * @param o           { balance, riskPct, usdPerPoint, price }
   * Returns { available, reason?, title, fields:[{label, value, copy}], risk:{usd, pct, tooBig}, sizeLabel, sizeValue, extra:[], steps:[] }
   */
  function orderFor(platformId, inst, sig, o) {
    const p = byId(platformId);
    const dir = sig.side === 'BUY' ? 1 : -1;
    const d = inst.digits;
    const px = n => Number(n).toFixed(d);
    const budget = o.balance * o.riskPct / 100;
    const base = { platform: p, available: true, title: p.short + ' order', extra: [] };

    if (p.kind === 'mt' || p.kind === 'ctrader' || p.kind === 'other') {
      const perLot = o.usdPerPoint;
      const lots = Math.floor((budget / (sig.slDist * perLot)) * 100 + 1e-9) / 100;
      const use = lots > 0 ? lots : 0.01;
      const usd = use * sig.slDist * perLot;
      const points = Math.round(sig.slDist / Math.pow(10, -d));
      const typeTxt = (dir > 0 ? 'Buy' : 'Sell') + ' (Market)';
      const fields = [
        { label: 'Type', value: typeTxt },
        { label: p.kind === 'ctrader' ? 'Quantity (lots)' : 'Volume (lot)', value: use.toFixed(2), copy: true },
        { label: 'Stop Loss', value: px(sig.sl), copy: true },
        { label: 'Take Profit', value: px(sig.tp2), copy: true },
      ];
      const btn = dir > 0 ? 'Buy' : 'Sell';
      const steps = {
        mt: [
          `${p.short} kholein → Quotes mein <b>${inst.id}</b> par tap karein → <b>Trade</b> / <b>New Order</b>.`,
          'Type: <b>Market Execution</b>. <b>Volume</b>, <b>Stop Loss</b> aur <b>Take Profit</b> upar se copy kar ke daalein.',
          `<b>${btn} by Market</b> dabayein.`,
          'Broker ki price app se alag ho to SL/TP ka <b>faasla</b> (upar card mein) apni entry par lagayein.',
          'TP1 par aadha lot band karein aur baqi ka SL entry par le aayein (breakeven).',
        ],
        ctrader: [
          `cTrader kholein → <b>${inst.id}</b> → <b>New Order</b> → <b>Market</b>.`,
          `Quantity mein <b>${use.toFixed(2)} lots</b> daalein (agar units dikhein to ${Math.round(use * inst.contract).toLocaleString('en-US')} units).`,
          '<b>Stop Loss</b> aur <b>Take Profit</b> ko "price" par set kar ke upar wali values daalein.',
          `<b>${btn}</b> dabayein. Broker ki price alag ho to faasla apni entry par lagayein.`,
          'TP1 par aadha band karein aur SL entry par le aayein.',
        ],
        other: [
          `Apni app mein <b>${inst.id}</b> kholein aur <b>${btn}</b> market order banayein.`,
          `Size: <b>${use.toFixed(2)} lot</b> (1 lot = ${inst.contract.toLocaleString('en-US')} ${inst.id === 'XAUUSD' ? 'ounce' : 'units'}). Aapke broker ka lot alag ho to Settings → Advanced mein contract size badlein.`,
          'Stop Loss aur Take Profit upar wali price par lagayein, ya faasla apni entry par.',
          'TP1 par aadha band karein aur SL entry par le aayein.',
        ],
      }[p.kind];
      return Object.assign(base, {
        fields, steps,
        risk: { usd, pct: usd / o.balance * 100, tooBig: lots === 0 },
        size: use, sizeText: use.toFixed(2) + ' lot',
        extra: [`SL ${points.toLocaleString('en-US')} points`],
      });
    }

    // ---------- Binance ----------
    const b = BINANCE[inst.id];
    if (!b) return Object.assign(base, { available: false, reason: `${inst.name} (${inst.id}) Binance par nahi milta. Settings mein MT5 ya koi aur broker chunein.` });
    const spot = p.kind === 'binance-spot';
    if (spot && dir < 0) {
      return Object.assign(base, { available: false,
        reason: `Binance Spot par SELL (short) nahi ho sakta. Agar aapke paas pehle se ${b.coin} hai to bech sakte hain, warna Settings mein Binance Futures chunein.` });
    }
    const step = spot ? b.stepSpot : b.stepFut;
    const dq = decimals(step);
    let qty = floorTo(budget / sig.slDist, step);           // 1 coin moves 1 USDT per 1.00 price move
    let capped = false;
    if (spot && qty * o.price > o.balance) { qty = floorTo(o.balance / o.price, step); capped = true; }
    const usd = qty * sig.slDist;
    const notional = qty * o.price;
    const fields = [
      { label: 'Symbol', value: b.symbol },
      { label: 'Side', value: spot ? 'Buy (Market)' : dir > 0 ? 'Buy / Long' : 'Sell / Short' },
      { label: `Quantity (${b.coin})`, value: qty.toFixed(dq), copy: true },
      { label: spot ? 'Kitne USDT lagenge' : 'Position value', value: notional.toFixed(2) + ' USDT' },
      { label: spot ? 'OCO: Take Profit' : 'Take Profit', value: px(sig.tp2), copy: true },
      { label: spot ? 'OCO: Stop price' : 'Stop Loss', value: px(sig.sl), copy: true },
    ];
    const extra = [];
    let steps;
    if (spot) {
      const lim = px(sig.sl - sig.slDist * 0.05);
      extra.push(capped ? `Balance kam hai, is liye poora risk nahi lag raha. Asal risk ${usd.toFixed(2)} USDT.` : '');
      steps = [
        `Binance → <b>Trade → Spot</b> → <b>${b.symbol}</b>.`,
        `<b>Market → Buy</b>, Amount mein <b>${qty.toFixed(dq)} ${b.coin}</b> daal kar Buy karein.`,
        `Phir <b>OCO → Sell</b>: Amount wahi ${qty.toFixed(dq)}, <b>Take Profit / Limit</b> = ${px(sig.tp2)}, <b>Stop</b> = ${px(sig.sl)}, Stop-limit = ${lim}.`,
        'Is tarah TP ya SL jo pehle aaye wo khud band kar dega.',
        'TP1 par aadha bech dein aur baqi ka OCO dobara lagayein jis ka Stop entry par ho.',
      ];
    } else {
      const lev = Math.min(20, Math.max(1, Math.ceil(notional / o.balance)));
      fields.splice(4, 0, { label: 'Leverage (kam se kam)', value: lev + 'x Isolated' });
      steps = [
        `Binance → <b>Futures → USDⓈ-M</b> → <b>${b.symbol} Perpetual</b>.`,
        `Margin mode <b>Isolated</b>, leverage <b>${lev}x</b> (zyada na rakhein, warna liquidation SL se pehle aa sakti hai).`,
        `<b>Market</b> order, Size mein <b>${qty.toFixed(dq)} ${b.coin}</b>.`,
        `<b>TP/SL</b> box tick karein: Take Profit ${px(sig.tp2)}, Stop Loss ${px(sig.sl)} (trigger: Mark price).`,
        `<b>${dir > 0 ? 'Buy / Long' : 'Sell / Short'}</b> dabayein. TP1 par aadha band karein aur SL entry par le aayein.`,
      ];
    }
    if (inst.id === 'XAUUSD') extra.push('Gold = PAXGUSDT. App ki price bhi PAXG se aati hai, is liye levels Binance se seedha milte hain.');
    return Object.assign(base, {
      fields, steps, extra: extra.filter(Boolean),
      risk: { usd, pct: usd / o.balance * 100, tooBig: qty <= 0 },
      size: qty, sizeText: qty.toFixed(dq) + ' ' + b.coin,
    });
  }

  const api = { PLATFORMS, BINANCE, byId, orderFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PLATFORMS = api;
})(this);
