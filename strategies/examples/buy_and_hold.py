from lumibot.strategies import Strategy


class BuyAndHold(Strategy):
    """Buy one symbol with (almost) all cash on the first iteration, then hold."""

    parameters = {
        "symbol": "SPY",
        "cash_fraction": 0.98,
    }

    def initialize(self):
        self.sleeptime = "1D"

    def on_trading_iteration(self):
        symbol = self.parameters["symbol"]
        if self.get_position(symbol) is not None:
            return
        price = self.get_last_price(symbol)
        if not price:
            self.log_message(f"No price for {symbol}, waiting")
            return
        quantity = int(self.get_cash() * float(self.parameters["cash_fraction"]) // price)
        if quantity > 0:
            self.submit_order(self.create_order(symbol, quantity, "buy"))
