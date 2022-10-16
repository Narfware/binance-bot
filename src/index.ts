/* eslint-disable no-console */
import { install as installSourceMapSupport } from "source-map-support";
import Binance, {
  AvgPriceResult,
  Candle,
  CandleChartInterval,
  OrderType,
} from "binance-api-node";
import { queue } from "async";
import { Big } from "big.js";
import axios from "axios";

const SYMBOL = "BTCUSDT"; // SELECT PAIR SYMBOL
const INTERVAL = "30m"; // Select candles interval
const quantity = "0.01"; // Quantity to buy/sell
const telegramApi = `https://api.telegram.org/{BOT_ID}:{API_KEY}`;
const chatId = 0; // Your telegram chat id

async function main() {
  // Source mapping => compiled js
  installSourceMapSupport();

  const testMode = true; // Enable disable test mode to connect with the test o real client

  const client = testMode
    ? Binance({
      httpBase: "https://testnet.binance.vision",
      wsBase: "wss://testnet.binance.vision/ws",
      apiKey: "{YOUR_API_KEY}",
      apiSecret: "{YOUR_API_SECRET}",
    })
    : Binance({ httpBase: "https://api.binance.com" });

  const now = new Date();

  try {
    Big.DP = 4;

    const allOrders = await client.allOrders({ symbol: SYMBOL });
    const lastOrder: { side: string; price: string | null } =
      allOrders.length > 0
        ? { side: allOrders[allOrders.length - 1].side, price: null }
        : { side: "SELL", price: null };
    // OPERATIONS
    const buy = async (quantity: string) => {
      await client.order({
        symbol: SYMBOL,
        type: OrderType.MARKET,
        side: "BUY",
        recvWindow: 20000,
        quantity: quantity,
      });

      const { balances } = await client.accountInfo();
      const avgPrice = (await client.avgPrice({
        symbol: SYMBOL,
      })) as AvgPriceResult;

      lastOrder.price = avgPrice.price;

      await sendTelegramMessage(
        `Purchase order placed, USDT BALANCE: ${balances.find(({ asset }) => asset === "USDT")?.free
        }, BTC balance ${balances.find(({ asset }) => asset === "BTC")?.free}`
      );
    };

    const sell = async (quantity: string) => {
      await client.order({
        symbol: SYMBOL,
        type: OrderType.MARKET,
        side: "SELL",
        recvWindow: 20000,
        quantity: quantity,
      });

      const { balances } = await client.accountInfo();
      const avgPrice = (await client.avgPrice({
        symbol: SYMBOL,
      })) as AvgPriceResult;

      lastOrder.price = avgPrice.price;

      await sendTelegramMessage(
        `Sales order placed, USDT BALANCE: ${balances.find(({ asset }) => asset === "USDT")?.free
        }, BTC balance ${balances.find(({ asset }) => asset === "BTC")?.free}`
      );
    };
    const sendTelegramMessage = async (message: string): Promise<void> => {
      await axios.post(`${telegramApi}/sendMessage`, {
        chat_id: chatId,
        text: message,
      });
    };

    const { balances } = await client.accountInfo();

    // Initial telegram message
    await sendTelegramMessage(
      `Initializing BOT with date ${now.toLocaleString()} with: ${balances.find(({ asset }) => asset === "USDT")?.free
      }, BTC balance, ${balances.find(({ asset }) => asset === "BTC")?.free
      }, Interval: ${INTERVAL}`
    );

    const candlesTwentyFivePeriods = await client.candles({
      symbol: SYMBOL,
      interval: CandleChartInterval.THIRTY_MINUTES,
      limit: 25,
    });

    const twentyFiveCandles: {
      high: string;
      low: string;
      open: string;
      close: string;
      openTime: number;
    }[] = candlesTwentyFivePeriods.flatMap(
      ({ high, low, open, close, openTime }) => ({
        high,
        low,
        open,
        close,
        openTime,
      })
    );

    // WS listen
    const listen = true;
    if (listen) {
      await client.ws.candles(SYMBOL, INTERVAL, async (candle) => {
        try {
          // Queue control flow
          const q = queue(async function (candle: Candle, callback) {
            if (candle.isFinal) {
              twentyFiveCandles.shift();
              twentyFiveCandles.push({
                high: candle.high,
                low: candle.low,
                open: candle.open,
                close: candle.close,
                openTime: candle.closeTime,
              });
            } else {
              twentyFiveCandles[twentyFiveCandles.length - 1].open =
                candle.open;
              twentyFiveCandles[twentyFiveCandles.length - 1].close =
                candle.close;
            }

            const maxCandleValue = new Big(candle.open);
            const minCandleValue = new Big(candle.close);
            const averageCandleValue = maxCandleValue
              .add(minCandleValue)
              .div("2");

            const sevenCandles = twentyFiveCandles.slice(
              twentyFiveCandles.length - 7,
              twentyFiveCandles.length
            );

            let totalTwentyFivePeriods = new Big(0);

            twentyFiveCandles.forEach((candle, index) => {
              ++index;
              const maxCandleValue = new Big(candle.high);
              const minCandleValue = new Big(candle.low);
              const averageCandleValue = maxCandleValue
                .add(minCandleValue)
                .div("2")
                .mul(index);
              totalTwentyFivePeriods = totalTwentyFivePeriods.add(
                new Big(candle.close).mul(index)
              );
            });

            let totalFivePeriods = new Big(0);

            sevenCandles.forEach((candle, index) => {
              ++index;
              const maxCandleValue = new Big(candle.high);
              const minCandleValue = new Big(candle.low);
              const averageCandleValue = maxCandleValue
                .add(minCandleValue)
                .div("2")
                .mul(index);
              totalFivePeriods = totalFivePeriods.add(
                new Big(candle.close).mul(index)
              );
            });

            const jaw = totalTwentyFivePeriods.div("325");
            const lips = totalFivePeriods.div("28");

            const averagePercentage = lips.div(jaw).mul("100");

            // Alligator strategy with lips and jaws
            if (lips.gt(jaw) && averagePercentage.gte("101")) {
              if (lastOrder.side === "SELL") {
                lastOrder.side = "BUY";
                await buy(quantity);
              }
            } else if (jaw.gt(lips) && averagePercentage.lte("99")) {
              if (lastOrder.side === "BUY") {
                lastOrder.side = "SELL";
                await sell(quantity);
              }
            }

            // PERCENTAGE CONTROL
            if (lastOrder.price && lastOrder.side === "BUY") {
              const percentage = averageCandleValue
                .div(lastOrder.price)
                .mul("100");
              if (percentage.gt("100.5") || percentage.lt("99.5")) {
                lastOrder.side = "SELL";
                await sell(quantity);
              }
            }

            callback();
          }, 1);
          q.push(candle);
        } catch (error) {
          console.error(error);
        }
      });
    }
  } catch (error) {
    console.error(error);
  }
}

main().catch((error) => console.error(error));
