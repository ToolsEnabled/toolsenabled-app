"""Synthetic adapter qualification, never a counted strategy or approved atom."""
from AlgorithmImports import *
import json
from pathlib import Path
from execution_reference import ExecutionLedger, require
from execution_lean import LeanExecutionBridge, cents, seconds

FIXTURE = json.loads(Path("/Algorithm/fixture.json").read_text())


class ScheduledPartialFill(FillModel):
    def __init__(self, algorithm):
        self.algorithm = algorithm
        self.filled, self.seen = {}, set()

    def market_fill(self, security, order):
        result = super().market_fill(security, order)
        intent_id = json.loads(order.tag)[1]
        now = seconds(self.algorithm.utc_time)
        quantity = FIXTURE["fills"].get(intent_id, {}).get(str(now), 0)
        key = (order.id, now)
        if not quantity or key in self.seen:
            result.fill_quantity = 0
            result.status = OrderStatus.NONE
            return result
        require(result.status == OrderStatus.FILLED, "The fixture attempted a fill without a valid market price")
        self.seen.add(key)
        filled = self.filled.get(order.id, 0) + quantity
        require(filled <= abs(order.quantity), "Fixture overfill")
        self.filled[order.id] = filled
        result.fill_quantity = quantity if order.quantity > 0 else -quantity
        # This fixture explicitly reports a USD zero fee on every partial
        # receipt; LEAN's currencyless default zero is deliberately not used.
        result.order_fee = OrderFee(CashAmount(0, "USD"))
        result.status = OrderStatus.FILLED if filled == abs(order.quantity) else OrderStatus.PARTIALLY_FILLED
        return result


class FrozenBenchmark(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2024, 1, 2)
        self.set_end_date(2024, 1, 2)
        self.set_time_zone(TimeZones.UTC)
        self.set_cash(FIXTURE["config"]["cashCents"] / 100)
        security = self.add_equity("SPY", Resolution.MINUTE, data_normalization_mode=DataNormalizationMode.RAW)
        security.set_fee_model(ConstantFeeModel(0))
        security.set_slippage_model(ConstantSlippageModel(0))
        security.set_fill_model(ScheduledPartialFill(self))
        self.symbol = security.symbol
        self.bridge = LeanExecutionBridge(self, ExecutionLedger(FIXTURE["config"]), {"SPY": self.symbol})
        self.bar_index = 0
        self.checkpoints = []

    def on_data(self, data):
        if self.bar_index >= len(FIXTURE["input"]["bars"]):
            return
        bar = FIXTURE["input"]["bars"][self.bar_index]
        at = int(datetime.fromisoformat(bar["time"].replace("Z", "+00:00")).timestamp())
        now = seconds(self.utc_time)
        if now < at:
            return
        require(now == at and self.symbol in data.bars, "Missing or mistimed input bar")
        require(cents(data.bars[self.symbol].close) == bar["prices"]["SPY"], "Native bar differs from the declared input")
        for action in FIXTURE["actions"]:
            action_time = action["intent"]["time"] if action["kind"] == "intent" else action["time"]
            if action_time != at:
                continue
            if action["kind"] == "intent":
                self.bridge.submit(action["intent"])
            else:
                require(self.bridge.cancel(action["intentId"]), "Native cancellation request failed")
        self.checkpoints.append(dict(time=now, snapshot=self.bridge.verify_portfolio()))
        self.bar_index += 1

    def on_order_event(self, event):
        self.bridge.on_order_event(event)

    def on_end_of_algorithm(self):
        require(self.bar_index == len(FIXTURE["input"]["bars"]), "Not every input bar was consumed")
        snapshot = self.bridge.verify_portfolio()
        Path("/Results/execution-snapshot.json").write_text(json.dumps(snapshot, sort_keys=True))
        Path("/Results/execution-checkpoints.json").write_text(json.dumps(self.checkpoints, sort_keys=True))
        Path("/Results/execution-callbacks.json").write_text(json.dumps(self.bridge.raw_events, sort_keys=True))
