"""Native adapter for a frozen operational IR and completed equity bars.

The Python controller receives actual OrderEvents. Fill scheduling belongs
to the declared LEAN environment; the controller does not synthesize fills.
The stored observation is a diagnostic, independently checked against native
orders/events during qualification. It is not a candidate grading oracle.
"""
from AlgorithmImports import *
import json
from datetime import datetime, timezone
from execution_reference import require
from execution_lean import LeanExecutionBridge, cents, seconds
from trading_reference import TradingRuntime

TASK = None


class FrozenBenchmark(QCAlgorithm):
    def initialize(self):
        require(TASK is not None, "Generate this program with its frozen task")
        bars = TASK["bars"]
        first, last = (datetime.fromtimestamp(bars[index]["time"], timezone.utc) for index in (0, -1))
        self.set_start_date(first.year, first.month, first.day)
        self.set_end_date(last.year, last.month, last.day)
        self.set_time_zone(TimeZones.UTC)
        self.set_cash(TASK["ir"]["execution"]["cashCents"] / 100)
        require(cents(self.portfolio.cash) == TASK["ir"]["execution"]["cashCents"], "Native starting cash differs")
        self.symbols = {}
        for asset in TASK["ir"]["execution"]["assets"]:
            security = self.add_equity(asset["id"], Resolution.MINUTE, fill_forward=False,
                                       data_normalization_mode=DataNormalizationMode.RAW)
            self.configure_security(security)
            self.symbols[asset["id"]] = security.symbol
        self.runtime = TradingRuntime(TASK["ir"], dispatch=self.dispatch_intent, cancel=self.cancel_intent)
        self.owner_paths = {node["namespace"]: node["path"] for node in TASK["ir"]["nodes"]}
        self.bridge = LeanExecutionBridge(self, self.runtime.ledger, self.symbols, reconciler=self.runtime.reconcile, tagger=self.order_tag)
        self.bar_index = 0

    def order_tag(self, intent):
        if TASK.get("observationTags"):
            return ["LB-OP-1", self.owner_paths[intent["owner"]], intent["lotId"], intent["reason"], intent["id"]]
        return ["LB-EXEC-1", intent["id"]]

    def configure_security(self, security):
        security.set_fee_model(ConstantFeeModel(0))
        security.set_slippage_model(ConstantSlippageModel(0))

    def dispatch_intent(self, intent):
        require(self.runtime.stepping, "Native dispatch escaped its bar")
        self.bridge.dispatch(intent)

    def cancel_intent(self, identifier):
        require(self.runtime.stepping, "Native cancellation escaped its bar")
        self.bridge.dispatch_cancel(identifier)

    def on_order_event(self, event):
        self.bridge.on_order_event(event)

    def on_data(self, data):
        if self.bar_index == len(TASK["bars"]):
            return
        declared = TASK["bars"][self.bar_index]
        now = seconds(self.utc_time)
        if now < declared["time"]:
            return
        require(now == declared["time"], "A frozen completed bar was not delivered")
        observed = {}
        for asset, price in declared["prices"].items():
            symbol = self.symbols[asset]
            if price is None:
                require(symbol not in data.bars, "Native data supplied an explicitly absent bar")
                observed[asset] = None
            else:
                require(symbol in data.bars and cents(data.bars[symbol].close) == price, "Native data differs from a frozen price")
                observed[asset] = cents(data.bars[symbol].close)
        require(all(symbol not in data.bars for asset, symbol in self.symbols.items() if asset not in declared["prices"]), "Native data supplied an undeclared asset bar")
        self.runtime.step(dict(time=now, prices=observed))
        self.bar_index += 1

    def on_end_of_algorithm(self):
        require(self.bar_index == len(TASK["bars"]), "Native execution omitted frozen bars")
        self.bridge.verify_portfolio()
        self.object_store.save("operational-observation.json",
                               json.dumps(dict(snapshot=self.runtime.snapshot(), rawEvents=self.bridge.raw_events),
                                          separators=(",", ":"), allow_nan=False))
