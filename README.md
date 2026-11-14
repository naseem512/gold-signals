# Naseem Trader

An installable web app (PWA) that gives 1H BUY/SELL signals with SL/TP, lot size, the values to enter in an MT5 order, a backtest, and push alerts through ntfy.

**Live app:** https://naseem512.github.io/gold-signals/

## Strategy
- **Signal:** EMA9/21 crossover in the EMA50/200 trend direction, RSI 50–70 for BUY and 30–50 for SELL, on a closed 1H candle (signals never repaint).
- **Fake-signal filter:** the 4H EMA50 trend agrees, the signal candle body is more than 50% of its range, and the close is within 1 ATR of EMA21.
- **Risk:** SL = 2.5 × ATR(14), TP1 = 1R, TP2 = 3R, and the trade closes after 72 hours.
- Weekend candles are removed for markets that close on the weekend.

## Signal modes (Settings → Signal mode)
- **Safe** (default): only the EMA9/21 cross. About 2 signals a month on gold. Many weeks have none: 16 of the last 26 weeks had no signal.
- **Active**: the cross, plus a pullback entry. The trend must already be running (EMA9 on the trend side of EMA21), price dips back to EMA21, and the candle closes back with the trend beyond the previous candle's body. About 6 signals a month; 5 of the last 26 weeks had no signal. The filters, SL and targets are the same as Safe.

| Gold, 2.5y PAXG / 2.4y GC=F, $0.50 cost | Trades/month | Win | Profit factor | Max drawdown |
|---|---|---|---|---|
| Safe | 2.3 / 1.6 | 46% / 50% | 2.27 / 2.47 | 4.1R / 4.1R |
| Active | 5.8 / 5.1 | 40% / 38% | 1.61 / 1.38 | 13.8R / 8.2R |

Active was profitable in both halves of both datasets, at $1 cost, and at every SL (2–3 ATR) and target (2.5–4R) tested. It is clearly weaker than Safe per trade.

Each mode has its own ntfy topic: Safe keeps `…-xauusd` and Active uses `…-xauusd-active`. A signal the cloud job finds late is announced only while it is still worth entering: TP1 not hit, price within -0.5R to +0.3R of entry, and at most 12 hours old.

## Testing (gold, 2024–2026, filter on, $0.50 cost per trade)
| Data | Trades | Win | Profit factor | Max drawdown |
|---|---|---|---|---|
| PAXG (2.5 years) | 70 | 46% | 2.27 | 4.1R |
| Gold futures (2.4 years) | 47 | 49% | 2.36 | 4.1R |

The parameters sit in the middle of a range that worked on both datasets and both halves of the data (walk-forward). Other markets tested weaker; the app labels each one.

## Trading platforms
Settings → "Trade kahan lagate hain?" builds the order for the selected platform (`platforms.js`):
- **MT5 / MT4 / cTrader / any broker:** lots, SL/TP price, points.
- **Binance Futures (USDⓈ-M):** gold as PAXGUSDT plus BTC and ETH; quantity in coins, minimum isolated leverage, TP/SL.
- **Binance Spot:** BUY only, with an OCO exit; capped by balance.

Binance is also the default **price source** for gold (PAXG). This is only the price feed; the trade can be placed anywhere.

## Spot gold calibration
PAXG trades a few dollars away from spot gold (about $11 below spot in Nov 2026), and MT5 brokers quote spot. On each refresh the app and the alert job read a free spot quote (`api.gold-api.com/price/XAU`, no key) and shift the PAXG candles by the gap. Signals do not change, because EMA crosses, RSI, ATR and the filters are unaffected by a constant shift (a test checks this); only the price levels move onto spot. A quote that is stale (over 20 minutes old, e.g. at the weekend) or more than 3% away is ignored. The app then uses the last good gap for up to 3 days, or else shows the raw PAXG price with a warning. Binance platforms always see raw PAXG.

## Signal card for beginners
"Aapko kya karna hai" gives numbered steps: the side and size to open, the Stop Loss, the Take Profit, and what to do at TP1. When entry is no longer sensible (TP1 already hit, price moved more than 0.3R, price near SL, market closed or data stale), it says "Nayi trade na lagayein" and shows what to do only for people already in the trade.

## Alerts
`.github/workflows/alerts.yml` runs `alerts/check.js` every 20 minutes. The job uses the same strategy code as the app and posts to `ntfy.sh/<topic>` for each market (topics are in `instruments.js`). Add a `TWELVEDATA_KEY` repository secret to enable Silver and Forex alerts.

## Development
```bash
npm test                 # strategy, no-repaint and alert-replay tests
DRY_RUN=1 node alerts/check.js
```
