from lumibot.strategies import Strategy


class SmaCrossover(Strategy):
    """Long when the fast SMA is above the slow SMA, flat otherwise. Long only."""

    parameters = {
        "symbol": "SPY",
        "fast": 20,
        "slow": 50,
        "cash_fraction": 0.95,
    }

    def initialize(self):
        self.sleeptime = "1D"

    def on_trading_iteration(self):
        symbol = self.parameters["symbol"]
        fast = int(self.parameters["fast"])
        slow = int(self.parameters["slow"])
        bars = self.get_historical_prices(symbol, slow + 1, "day")
        if bars is None or bars.df is None or len(bars.df) < slow:
            self.log_message("Not enough history yet")
            return
        closes = bars.df["close"]
        fast_sma = closes.tail(fast).mean()
        slow_sma = closes.tail(slow).mean()
        position = self.get_position(symbol)
        holding = position is not None and position.quantity > 0

        if fast_sma > slow_sma and not holding:
            price = self.get_last_price(symbol)
            if not price:
                return
            quantity = int(self.get_cash() * float(self.parameters["cash_fraction"]) // price)
            if quantity > 0:
                self.submit_order(self.create_order(symbol, quantity, "buy"))
        elif fast_sma < slow_sma and holding:
            self.submit_order(self.create_order(symbol, position.quantity, "sell"))
