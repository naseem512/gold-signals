// Markets the app supports. Shared by the web app (window.MARKETS) and the cloud alert job (Node).
(function (root) {
  // usdPerPoint(price): dollars gained/lost per 1.00 price move on 1.00 lot.
  const INSTRUMENTS = [
    { id: 'XAUUSD', name: 'Gold', digits: 2, cost: 0.5, contract: 100, usdPerPoint: () => 100,
      binance: 'PAXGUSDT', spot: 'XAU', td: 'XAU/USD', closesWeekend: true, tested: 'strong' },
    { id: 'XAGUSD', name: 'Silver', digits: 3, cost: 0.03, contract: 5000, usdPerPoint: () => 5000,
      td: 'XAG/USD', closesWeekend: true, tested: 'weak' },
    { id: 'EURUSD', name: 'Euro / Dollar', digits: 5, cost: 0.00012, contract: 100000, usdPerPoint: () => 100000,
      td: 'EUR/USD', closesWeekend: true, tested: 'weak' },
    { id: 'GBPUSD', name: 'Pound / Dollar', digits: 5, cost: 0.00015, contract: 100000, usdPerPoint: () => 100000,
      td: 'GBP/USD', closesWeekend: true, tested: 'weak' },
    { id: 'USDJPY', name: 'Dollar / Yen', digits: 3, cost: 0.015, contract: 100000, usdPerPoint: p => 100000 / p,
      td: 'USD/JPY', closesWeekend: true, tested: 'loss' },
    { id: 'BTCUSD', name: 'Bitcoin', digits: 2, cost: 15, contract: 1, usdPerPoint: () => 1,
      binance: 'BTCUSDT', closesWeekend: false, tested: 'weak' },
    { id: 'ETHUSD', name: 'Ethereum', digits: 2, cost: 1.2, contract: 1, usdPerPoint: () => 1,
      binance: 'ETHUSDT', closesWeekend: false, tested: 'weak' },
  ];

  // Tested on 2 years of hourly data (2024-2026), filter ON, costs included.
  const TEST_NOTE = {
    strong: 'Purane 2 saal ke data par dono hisson mein munafe mein rahi.',
    weak: 'Purane data par kamzor ya musalsal nahi. Kam risk lein.',
    loss: 'Purane data par ghaate mein rahi. Is market par is strategy se trade na karein.',
  };

  const APP_URL = 'https://naseem512.github.io/gold-signals/';
  // ntfy topic per market: <NTFY_BASE>-<id lowercase>. The random part keeps strangers from guessing it.
  const NTFY_BASE = 'naseem-trader-8cb48b4cb5';
  // Safe keeps the original topic (existing subscribers keep working); Active gets its own.
  const topicFor = (id, mode = 'safe') => NTFY_BASE + '-' + id.toLowerCase() + (mode === 'active' ? '-active' : '');
  const byId = id => INSTRUMENTS.find(m => m.id === id) || INSTRUMENTS[0];

  // PAXG (Binance) trades a few dollars away from spot gold, which is what MT5 brokers quote.
  // A free spot quote (no key) gives the current gap; candles are shifted by it so levels match MT5.
  const SPOT_URL = sym => 'https://api.gold-api.com/price/' + sym;
  const SPOT_MAX_AGE = 20 * 60 * 1000;
  /** Gap (spot - feed) from a gold-api.com reply, or null if the reply is stale or implausible. */
  function spotOffset(reply, feedPrice, now) {
    const price = reply && +reply.price, t = reply && Date.parse(reply.updatedAt);
    if (!(price > 0) || !(feedPrice > 0) || !isFinite(t)) return null;
    if (now - t > SPOT_MAX_AGE || t - now > SPOT_MAX_AGE) return null; // weekend / frozen quote
    if (Math.abs(price / feedPrice - 1) > 0.03) return null;            // more than 3% apart: bad data
    return price - feedPrice;
  }

  const api = { INSTRUMENTS, TEST_NOTE, APP_URL, NTFY_BASE, topicFor, byId, SPOT_URL, spotOffset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MARKETS = api;
})(this);
