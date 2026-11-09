# Naseem Trader

An installable web app (PWA) that gives 1H BUY/SELL signals with SL/TP, lot size, the values to enter in an MT5 order, a backtest, and push alerts through ntfy.

**Live app:** https://naseem512.github.io/gold-signals/

## Strategy
- **Signal:** EMA9/21 crossover in the EMA50/200 trend direction, RSI 50–70 for BUY and 30–50 for SELL, on a closed 1H candle (signals never repaint).
- **Fake-signal filter:** the 4H EMA50 trend agrees, the signal candle body is more than 50% of its range, and the close is within 1 ATR of EMA21.
- **Risk:** SL = 2.5 × ATR(14), TP1 = 1R, TP2 = 3R, and the trade closes after 72 hours.
- Weekend candles are removed for markets that close on the weekend.

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

## Alerts
`.github/workflows/alerts.yml` runs `alerts/check.js` every 20 minutes. The job uses the same strategy code as the app and posts to `ntfy.sh/<topic>` for each market (topics are in `instruments.js`). Add a `TWELVEDATA_KEY` repository secret to enable Silver and Forex alerts.

## Development
```bash
npm test                 # strategy, no-repaint and alert-replay tests
DRY_RUN=1 node alerts/check.js
```
