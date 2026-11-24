# Naseem Trader

An installable web app (PWA) that gives 1H BUY/SELL signals with SL/TP, lot size, the values to enter in an MT5 order, a backtest, and push alerts through ntfy.

**Live app:** https://naseem512.github.io/gold-signals/

## Strategy
- **Signal:** EMA9/21 crossover in the EMA50/200 trend direction, RSI 50–70 for BUY and 30–50 for SELL, on a closed 1H candle (signals never repaint).
- **Fake-signal filter:** the 4H EMA50 trend agrees, the signal candle body is more than 50% of its range, and the close is within 1 ATR of EMA21.
- **Risk:** SL = 2.5 × ATR(14), TP1 = 1R, TP2 = 3R, and the trade closes after 72 hours.
- Weekend candles are removed for markets that close on the weekend.

## Signal modes (Settings → Signal mode)
- **Safe**: only the EMA9/21 cross. About 2 signals a month on gold. Many weeks have none: 16 of the last 26 weeks had no signal.
- **Active** (default since v2.6): the cross, plus a pullback entry. The trend must already be running (EMA9 on the trend side of EMA21), price dips back to EMA21, and the candle closes back with the trend beyond the previous candle's body. About 6 signals a month; 5 of the last 26 weeks had no signal. The filters, SL and targets are the same as Safe.

| Gold, 2.5y PAXG / 2.4y GC=F, $0.50 cost | Trades/month | Win | Profit factor | Max drawdown |
|---|---|---|---|---|
| Safe | 2.3 / 1.6 | 46% / 50% | 2.27 / 2.47 | 4.1R / 4.1R |
| Active | 5.8 / 5.1 | 40% / 38% | 1.61 / 1.38 | 13.8R / 8.2R |
| Scalp 15m (2y PAXG 15m only) | 18.9 | 31% | 1.27 | 14.9R (12 losses in a row) |

**Scalp 15m** applies the Active rules to 15-minute candles, with the same 4H trend filter and 72-hour hold. It was added on request for 15-20 signals a month. More signals came with lower quality: on 30m and 15m, every variant had a win rate of 27-41% and a PF of 1.03-1.61. Alerts go to `…-xauusd-scalp` and cover gold only. A late signal is announced only within 1 hour of the signal.

Active was profitable in both halves of both datasets, at $1 cost, and at every SL (2–3 ATR) and target (2.5–4R) tested. It is clearly weaker than Safe per trade.

Active alerts go to the main topic `…-xauusd`; Safe alerts go to `…-xauusd-safe`. A signal the cloud job finds late is announced only while it is still worth entering: TP1 not hit, price within -0.5R to +0.3R of entry, and at most 12 hours old.

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

## Pending STOP order + market analysis (v3.1)
Sometimes the trends agree but price has pulled back to the wrong side of EMA21, where a market entry tested poorly. In that case the card gives a **pending STOP order** at EMA21 in the trend direction. It is valid for 12 hours and fills when price returns to the trend side. Tested with one order at a time on 2.5y PAXG / 2.4y GC: about 8 a month, win ~36%, PF 1.27 / 1.28 (halves 1.04 / 1.48 and 1.11 / 1.48). It is weaker than signals and trend trades, and the card says so.

A breakout order on both sides when the trends disagree was tested too. It lost money on GC (PF 0.70), so it is not used, and those hours still show "no trade". On gold 1H the card now offers something actionable about 85% of the time: a signal, a trend trade or a pending order. A **Market analysis** card shows the 1H and 4H trend, RSI momentum, ATR speed compared with the 30-day average, the 40-candle support and resistance, the 24h range and the EMA positions, followed by a one-line verdict.

## Trend trade: always-on "trade now" (v3.0, gold 1H)
When no signal can be entered, the Signal card can still offer a trade at the current price. It does this when the 1H and 4H trends agree and price is on the trend side of EMA21. The card shows SELL/BUY at the live price, with SL 2.5×ATR, TP1 1R, TP2 3R, the lot size and the MT5 order, labelled **TREND TRADE**.

This was tested by entering at **every** qualifying hour on 2.5y PAXG / 2.4y GC:

| Result | PAXG | GC |
|---|---|---|
| Profit factor | 1.48 | 1.38 |
| First half / second half | 1.30 / 1.65 | 1.27 / 1.49 |
| Win rate | ~38% | ~37% |
| Time available | ~57% | ~56% |

Entries with price on the wrong side of EMA21 were not profitable in the first half, so they are excluded. The rule is `GS.trendTradeDir`. It sends no alerts; strategy signals still take priority while they can be entered.

## Gold Active breakout (v2.9)
In Nov 2026 gold fell about $290 in a week without one pullback to EMA21, and Active gave no entry. Gold Active now also enters on a **breakout**: in the trend, with the 4H trend agreeing and a strong candle body, a close beyond the last 40 candles' high or low. The RSI band and the EMA21-distance filter do not apply, because those are exactly what blocked the move.

| Gold Active, 2.5y PAXG / 2.4y GC | Trades/month | PF | Total R | Weeks with no signal (last 26) |
|---|---|---|---|---|
| Before | 5.8 / 5.1 | 1.61 / 1.38 | 63 / 35 | 5 |
| With breakout | 8.1 / 7.6 | 1.47 / 1.30 | 69 / 43 | 1 |

November 2026 with breakout: 7 trades, 4 TP and 3 SL, +8.9R. Breakout made the other markets worse (BTC PF 1.14, silver's first half losing), so it is on for gold only (`breakout: true` in `instruments.js`). The market plan shows both levels: the EMA21 zone and the breakout level.

## More markets (scanner + combined alerts)
Every market was backtested in both modes on 2+ years of hourly data. Each market is graded per mode: strong, ok, weak or loss. Only gold is strong, and only in Safe mode. The markets graded ok are gold (Active), BTC (Active), ETH (Safe), silver (Active, needs a key) and GBPUSD (Safe, needs a key). USDJPY, AUDUSD, EURUSD (Active), GBPJPY and oil were weak or losing.

The Signal tab's **Sab markets** scanner checks each ok/strong market in its picked mode, at most every 5 minutes. Tapping a row opens that market. The cloud job also posts each picked-mode signal to the combined topic `…-all`. Without a key that covers gold, BTC and ETH, about 17 signals a month.

## Market plan (no open signal)
Instead of a bare WAIT, the card states the trend. When the 1H and 4H trends agree, it shows the entry zone (EMA21), how far price is from it, and asks the user to set an MT5 price alert there. A "pending limit at EMA21" strategy was tested as an alternative. With one pending order at a time it was weaker (PF about 1.3 on both datasets), so it is not used.

## Signal card for beginners
"Aapko kya karna hai" gives numbered steps: the side and size to open, the Stop Loss, the Take Profit, and what to do at TP1. When entry is no longer sensible (TP1 already hit, price moved more than 0.3R, price near SL, market closed or data stale), it says "Nayi trade na lagayein" and shows what to do only for people already in the trade.

## Alerts
`.github/workflows/alerts.yml` runs `alerts/check.js` every 20 minutes. The job uses the same strategy code as the app and posts to `ntfy.sh/<topic>` for each market (topics are in `instruments.js`). Add a `TWELVEDATA_KEY` repository secret to enable Silver and Forex alerts.

## Development
```bash
npm test                 # strategy, no-repaint and alert-replay tests
DRY_RUN=1 node alerts/check.js
```
