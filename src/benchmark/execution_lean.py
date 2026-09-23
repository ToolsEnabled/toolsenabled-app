"""LEAN market-order adapter for the explicit private execution ledger.

Admission precedes dispatch. Only real OrderEvent callbacks settle inventory
and cash. A cancellation request does not acknowledge its own success.
The caller selects/reviews trading semantics and the backtest fill model.
"""
import json
from datetime import timezone
from decimal import Decimal
from AlgorithmImports import OrderStatus
from execution_reference import require, checked

TAG_VERSION = "LB-EXEC-1"


def cents(value):
    result = Decimal(str(value)) * 100
    require(result == result.to_integral_value(), "Native amount is not exact cents")
    return checked(int(result))


def seconds(value):
    result = value.replace(tzinfo=timezone.utc).timestamp()
    require(result == int(result), "Native time is not an integer UTC second")
    return checked(int(result))


class LeanExecutionBridge:
    def __init__(self, algorithm, ledger, symbols, reconciler=None, tagger=None):
        require(set(symbols) == set(ledger.assets), "Native asset registry differs")
        self.algorithm, self.ledger, self.symbols = algorithm, ledger, dict(symbols)
        self.reconcile = reconciler or ledger.reconcile
        self.tagger = tagger or (lambda intent: [TAG_VERSION, intent["id"]])
        self.tickets, self.raw_events = {}, []
        for asset, symbol in self.symbols.items():
            security = algorithm.securities[symbol]
            require(security.quote_currency.symbol == ledger.config["currency"], "Native quote currency differs")
            require(security.symbol_properties.contract_multiplier == ledger.assets[asset]["multiplier"], "Native asset multiplier differs")

    def submit(self, intent):
        require(intent["time"] == seconds(self.algorithm.utc_time), "Intent timestamp differs from dispatch")
        decision = self.ledger.admit(intent)
        if not decision["admitted"]:
            return decision
        self.dispatch(intent)
        return decision

    def dispatch(self, intent):
        require(intent["time"] == seconds(self.algorithm.utc_time), "Intent timestamp differs from dispatch")
        admitted = self.ledger.orders.get(intent["id"])
        require(admitted is not None and all(admitted.get(key) == value for key, value in intent.items()), "Native dispatch differs from its admitted intent")
        require(intent["id"] not in self.tickets and admitted["brokerOrderId"] is None, "Native intent was already dispatched")
        quantity = intent["quantity"] * (1 if intent["side"] == "buy" else -1)
        ticket = self.algorithm.market_order(self.symbols[intent["asset"]], quantity, True,
                                            tag=json.dumps(self.tagger(intent), separators=(",", ":")))
        # A callback may have settled this order before market_order returns.
        # Do not fabricate acceptance or replace its reconciled status.
        order = self.ledger.orders[intent["id"]]
        require(order["brokerOrderId"] in (None, str(ticket.order_id)), "Native ticket identity differs from its callback")
        self.tickets[intent["id"]] = ticket
        return ticket

    def cancel(self, intent_id):
        if not self.ledger.request_cancel(intent_id, seconds(self.algorithm.utc_time)):
            return False
        return self.dispatch_cancel(intent_id)

    def dispatch_cancel(self, intent_id):
        require(self.ledger.orders.get(intent_id, {}).get("cancellationRequested"), "Native cancellation needs its recorded request")
        require(intent_id in self.tickets, "No native ticket for cancellation")
        response = self.tickets[intent_id].cancel()
        # A failed request remains a request. Release reservations only when
        # a terminal broker event arrives.
        return bool(response.is_success)

    def on_order_event(self, event):
        order = self.algorithm.transactions.get_order_by_id(event.order_id)
        require(order is not None, "Native event has no order")
        tag = json.loads(order.tag)
        require(isinstance(tag, list) and len(tag) > 1 and isinstance(tag[-1], str), "Native order has no execution tag")
        intent = self.ledger.orders.get(tag[-1])
        require(intent is not None and tag == self.tagger(intent), "Native order has no admitted intent or changed its attribution")
        require(event.symbol == self.symbols[intent["asset"]], "Native event changed its asset")
        signed = intent["quantity"] * (1 if intent["side"] == "buy" else -1)
        require(order.quantity == signed, "Native order changed its admitted quantity")
        raw = dict(orderId=int(event.order_id), orderEventId=int(event.id), status=str(event.status),
                   time=seconds(event.utc_time), fillQuantity=str(event.fill_quantity), fillPrice=str(event.fill_price),
                   feeAmount=str(event.order_fee.value.amount), feeCurrency=event.order_fee.value.currency)
        self.raw_events.append(raw)
        kind = {OrderStatus.SUBMITTED: "accepted", OrderStatus.PARTIALLY_FILLED: "fill", OrderStatus.FILLED: "fill",
                OrderStatus.CANCELED: "cancelled", OrderStatus.INVALID: "rejected"}.get(event.status)
        if kind is None:
            require(event.status in (OrderStatus.NEW, OrderStatus.NONE, OrderStatus.CANCEL_PENDING), "Unsupported native order status")
            require(event.fill_quantity == 0 and event.order_fee.value.amount == 0, "Unreconciled native cash or fill")
            return
        normalized = dict(id=str(event.order_id) + ":" + str(event.id), intentId=intent["id"],
                          brokerOrderId=str(event.order_id), kind=kind, time=raw["time"])
        if kind == "fill":
            quantity = abs(event.fill_quantity)
            require(quantity == int(quantity) and quantity > 0 and (event.fill_quantity > 0) == (intent["side"] == "buy"), "Unsupported native fill quantity")
            require(event.order_fee.value.currency == self.ledger.config["currency"], "Native fee currency differs")
            normalized.update(quantity=int(quantity), priceCents=cents(event.fill_price), feeCents=cents(event.order_fee.value.amount))
        else:
            require(event.fill_quantity == 0 and event.order_fee.value.amount == 0, "Non-fill native event carries a fill or fee")
        self.reconcile(normalized)
        expected_status = "filled" if event.status == OrderStatus.FILLED else "partially-filled" if event.status == OrderStatus.PARTIALLY_FILLED else None
        require(expected_status is None or self.ledger.orders[intent["id"]]["status"] == expected_status, "Native fill status differs from its accumulated quantity")

    def verify_portfolio(self):
        require(cents(self.algorithm.portfolio.cash) == self.ledger.cash, "Native and private cash differ")
        snapshot = self.ledger.snapshot()
        for position in snapshot["positions"]:
            require(self.algorithm.portfolio[self.symbols[position["asset"]]].quantity == position["quantity"], "Native and private inventory differ")
        return snapshot
