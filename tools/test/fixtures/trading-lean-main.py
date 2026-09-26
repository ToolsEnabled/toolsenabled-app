"""Actual LEAN lifecycle control using an independently declared fill table."""
from generated import FrozenBenchmark as OperationalBenchmark
from AlgorithmImports import *
import json
from pathlib import Path
from execution_reference import require
from execution_lean import seconds

FIXTURE = json.loads(Path("/Algorithm/fixture.json").read_text())


class ScheduledOperationalFill(FillModel):
    def __init__(self, algorithm):
        self.algorithm = algorithm
        self.filled, self.seen = {}, set()

    def market_fill(self, security, order):
        result = super().market_fill(security, order)
        identifier = json.loads(order.tag)[1]
        intent = self.algorithm.runtime.ledger.orders[identifier]
        key = ":".join(intent[name] for name in ("owner", "side", "reason"))
        now = seconds(self.algorithm.utc_time)
        quantity = FIXTURE["fills"].get(key, {}).get(str(now), 0)
        occurrence = (order.id, now)
        if not quantity or occurrence in self.seen:
            result.fill_quantity = 0
            result.status = OrderStatus.NONE
            return result
        require(result.status == OrderStatus.FILLED, "The fixture has no valid market price")
        self.seen.add(occurrence)
        filled = self.filled.get(order.id, 0) + quantity
        require(filled <= abs(order.quantity), "Fixture overfill")
        self.filled[order.id] = filled
        result.fill_quantity = quantity if order.quantity > 0 else -quantity
        result.order_fee = OrderFee(CashAmount(0, "USD"))
        result.status = OrderStatus.FILLED if filled == abs(order.quantity) else OrderStatus.PARTIALLY_FILLED
        return result


class FrozenBenchmark(OperationalBenchmark):
    def configure_security(self, security):
        super().configure_security(security)
        security.set_fill_model(ScheduledOperationalFill(self))

    def on_end_of_algorithm(self):
        super().on_end_of_algorithm()
        Path("/Results/operational-snapshot.json").write_text(json.dumps(self.runtime.snapshot(), sort_keys=True))
        Path("/Results/operational-callbacks.json").write_text(json.dumps(self.bridge.raw_events, sort_keys=True))
