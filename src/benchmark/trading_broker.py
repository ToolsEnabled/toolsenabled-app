"""Public candidate environment. This file contains no strategy oracle.

Each order receives at most its declared per-bar quantity after delayBars
completed input bars. The fill model reads native order state and market
prices only. Its behavior is the same for every candidate and reading.
"""
from AlgorithmImports import *
from datetime import timezone
from decimal import Decimal


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def seconds(value):
    result = value.replace(tzinfo=timezone.utc).timestamp()
    require(result == int(result), "The operational environment requires integer UTC seconds")
    return int(result)


def cents(value):
    amount = Decimal(str(value)) * 100
    require(amount == amount.to_integral_value(), "The operational environment requires exact cents")
    return int(amount)


class DelayedCappedFill(FillModel):
    def __init__(self, algorithm, contract):
        self.algorithm, self.contract = algorithm, contract
        self.indices = {bar["time"]: index for index, bar in enumerate(contract["bars"])}
        self.filled, self.seen = {}, set()

    def market_fill(self, security, order):
        result = super().market_fill(security, order)
        now, created = seconds(self.algorithm.utc_time), seconds(order.time)
        index, first = self.indices.get(now), self.indices.get(created)
        occurrence = (order.id, now)
        price = None if index is None else self.contract["bars"][index]["prices"].get(security.symbol.value)
        if index is None or first is None or index - first < self.contract["market"]["delayBars"] or price is None or occurrence in self.seen:
            result.fill_quantity = 0
            # LEAN copies the returned status onto its pending native order.
            # A no-fill scan must preserve that status: returning NONE would
            # erase Submitted/PartiallyFilled without a retained lifecycle event.
            result.status = order.status
            return result
        require(result.status == OrderStatus.FILLED and cents(result.fill_price) == price, "Native market pricing differs from the frozen completed bar")
        quantity = min(self.contract["market"]["maxFillQuantity"], abs(order.quantity) - self.filled.get(order.id, 0))
        require(quantity > 0 and quantity == int(quantity), "Unsupported native fill quantity")
        self.seen.add(occurrence)
        total = self.filled.get(order.id, 0) + quantity
        self.filled[order.id] = total
        result.fill_quantity = quantity if order.quantity > 0 else -quantity
        result.order_fee = OrderFee(CashAmount(0, "USD"))
        result.status = OrderStatus.FILLED if total == abs(order.quantity) else OrderStatus.PARTIALLY_FILLED
        return result


class OperationalEnvironment:
    def __init__(self, algorithm, contract):
        self.algorithm, self.contract, self.index = algorithm, contract, 0
        require(algorithm.account_currency == contract["currency"] and cents(algorithm.portfolio.cash) == contract["cashCents"], "Candidate starting cash or currency differs")
        require(algorithm.time_zone.id == "UTC", "Candidate must use UTC")
        actual = {security.symbol.value: security for security in algorithm.securities.values()}
        require(set(actual) == {asset["id"] for asset in contract["assets"]}, "Candidate equity subscriptions differ")
        self.symbols = {}
        for asset in contract["assets"]:
            security = actual[asset["id"]]
            require(security.type == SecurityType.EQUITY and security.symbol_properties.contract_multiplier == 1
                    and security.quote_currency.symbol == "USD" and security.holdings.quantity == 0, "Candidate starting security configuration differs")
            security.set_fee_model(ConstantFeeModel(0))
            security.set_slippage_model(ConstantSlippageModel(0))
            security.set_fill_model(DelayedCappedFill(algorithm, contract))
            self.symbols[asset["id"]] = security.symbol

    def on_data(self, data):
        now = seconds(self.algorithm.utc_time)
        if self.index == len(self.contract["bars"]) or now < self.contract["bars"][self.index]["time"]:
            return
        bar = self.contract["bars"][self.index]
        require(now == bar["time"], "Candidate execution omitted a frozen completed bar")
        for asset, symbol in self.symbols.items():
            price = bar["prices"].get(asset)
            require(symbol not in data.bars if price is None else symbol in data.bars and cents(data.bars[symbol].close) == price,
                    "Candidate subscriptions changed the frozen completed-bar input")
        self.index += 1

    def finish(self):
        require(self.index == len(self.contract["bars"]), "Candidate execution omitted frozen bars")
