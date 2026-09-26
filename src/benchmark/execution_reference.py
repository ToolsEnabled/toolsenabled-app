"""Independent broker-event ledger for the generated Python decision runtime.

The event schema is shared with execution.mjs. This implementation derives
reservations and ownership from its order/lot book; it does not execute or
translate the JavaScript ledger. No strategy/operator is selected here.
"""
import copy
import json
import sys

MAXIMUM = 9007199254740991
TERMINAL = {"filled", "cancelled", "rejected", "expired"}
# Match the JSON-facing JavaScript contract's ECMAScript trim characters,
# including BOM and excluding Python-only whitespace such as U+0085.
TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= MAXIMUM


def checked(value):
    require(integer(value), "Execution arithmetic exceeds the safe integer range")
    return value


def identifier(value):
    return isinstance(value, str) and bool(value.strip(TRIM)) and len(value.encode("utf-16-le", "surrogatepass")) <= 480


def only_fields(value, allowed):
    require(isinstance(value, dict) and set(value) <= set(allowed), "Unsupported execution fields")


class ExecutionLedger:
    def __init__(self, config):
        only_fields(config, ("version", "cashCents", "currency", "assets", "owners", "limits"))
        require(type(config.get("version")) is int and config["version"] == 1 and integer(config.get("cashCents")) and identifier(config.get("currency")), "Invalid execution configuration")
        assets, owners = config.get("assets"), config.get("owners")
        require(isinstance(assets, list) and 1 <= len(assets) <= 4096, "Invalid assets")
        for asset in assets:
            only_fields(asset, ("id", "multiplier", "quantityStep"))
            require(identifier(asset.get("id")) and integer(asset.get("multiplier"), 1) and integer(asset.get("quantityStep"), 1), "Invalid asset")
        require(len({asset["id"] for asset in assets}) == len(assets), "Duplicate asset")
        require(isinstance(owners, list) and 1 <= len(owners) <= 4096 and all(identifier(owner) for owner in owners) and len(set(owners)) == len(owners), "Invalid owners")
        limits = config.get("limits")
        only_fields(limits, ("intents", "events"))
        require(integer(limits.get("intents"), 1) and limits["intents"] <= 100000 and integer(limits.get("events"), 1) and limits["events"] <= 1000000, "Invalid execution limits")
        self.config = copy.deepcopy(config)
        self.assets = {asset["id"]: copy.deepcopy(asset) for asset in assets}
        self.owners = set(owners)
        self.cash = config["cashCents"]
        self.orders, self.lots, self.journal = {}, {}, []
        self.proposed, self.receipts, self.broker = set(), {}, {}
        self.time = -1
        self.event_count = 0

    def _ordered(self, time):
        require(integer(time) and time >= self.time, "Execution time moved backwards")

    def _event_budget(self):
        require(self.event_count < self.config["limits"]["events"], "Execution event budget exhausted")

    @staticmethod
    def _open(order):
        return order["status"] not in TERMINAL

    def _pending(self, lot_id, orders=None):
        return [order for order in (self.orders if orders is None else orders).values() if order["lotId"] == lot_id and self._open(order)]

    def _reserved_cash(self, orders=None):
        return sum(order["cashReservedCents"] for order in (self.orders if orders is None else orders).values() if self._open(order))

    def _reserved_lot(self, lot_id, orders=None):
        return sum(order["quantity"] - order["filledQuantity"] for order in self._pending(lot_id, orders) if order["side"] == "sell")

    def _validate_book(self, cash, orders, lots):
        checked(cash)
        cash_reserved, sale_reserved = 0, {}
        for order in orders.values():
            if self._open(order):
                cash_reserved += order["cashReservedCents"]
                if order["side"] == "sell":
                    sale_reserved[order["lotId"]] = sale_reserved.get(order["lotId"], 0) + order["quantity"] - order["filledQuantity"]
        require(cash >= cash_reserved, "Cash reservations exceed available cash")
        positions = {}
        for lot in lots.values():
            checked(lot["quantity"])
            require(lot["quantity"] >= sale_reserved.get(lot["id"], 0), "Private sale reservations exceed owned quantity")
            positions[lot["asset"]] = checked(positions.get(lot["asset"], 0) + lot["quantity"])

    def admit(self, intent):
        only_fields(intent, ("id", "owner", "lotId", "asset", "side", "quantity", "cashCapCents", "reason", "time"))
        require(identifier(intent.get("id")) and intent["id"] not in self.proposed, "Intent identity reused")
        require(len(self.proposed) < self.config["limits"]["intents"], "Execution intent budget exhausted")
        require(intent.get("owner") in self.owners and identifier(intent.get("lotId")) and identifier(intent.get("reason")), "Invalid private ownership")
        asset = self.assets.get(intent.get("asset"))
        require(asset is not None and intent.get("side") in ("buy", "sell") and integer(intent.get("quantity"), 1) and intent["quantity"] % asset["quantityStep"] == 0, "Invalid asset quantity")
        require(integer(intent.get("cashCapCents")) and (intent["cashCapCents"] > 0 if intent["side"] == "buy" else intent["cashCapCents"] == 0), "Invalid explicit cash cap")
        self._ordered(intent.get("time"))
        intent = copy.deepcopy(intent)
        lot = self.lots.get(intent["lotId"])
        if intent["side"] == "buy":
            require(lot is None, "Private lot identity reused")
            reason = "insufficient-unreserved-cash" if intent["cashCapCents"] > self.cash - self._reserved_cash() else None
        else:
            require(lot is not None and lot["owner"] == intent["owner"] and lot["asset"] == intent["asset"], "Foreign private inventory")
            reason = "insufficient-unreserved-private-quantity" if intent["quantity"] > lot["quantity"] - self._reserved_lot(lot["id"]) else None
        decision = dict(sequence=len(self.journal) + 1, intent=intent, admitted=reason is None, reason=reason)
        self.proposed.add(intent["id"])
        self.time = intent["time"]
        self.journal.append(dict(kind="intent", decision=decision))
        if reason is None:
            self.orders[intent["id"]] = dict(intent, status="admitted", brokerOrderId=None, filledQuantity=0, cashReservedCents=intent["cashCapCents"],
                                              grossCents=0, feesCents=0, cancellationRequested=False, lastEventTime=None)
            if intent["side"] == "buy":
                self.lots[intent["lotId"]] = dict(id=intent["lotId"], owner=intent["owner"], asset=intent["asset"], entryIntentId=intent["id"],
                                                  quantity=0, boughtQuantity=0, soldQuantity=0, firstFillTime=None, lastFillTime=None)
        return copy.deepcopy(decision)

    def request_cancel(self, intent_id, time):
        require(intent_id in self.orders, "Unknown intent")
        order = self.orders[intent_id]
        self._ordered(time)
        require(self._open(order), "Terminal cancellation request")
        if order["cancellationRequested"]:
            return False
        self._event_budget()
        order["cancellationRequested"] = True
        self.time = time
        self.journal.append(dict(kind="cancel-request", event=dict(sequence=len(self.journal) + 1, kind="cancel-request", intentId=intent_id, time=time)))
        self.event_count += 1
        return True

    def reconcile(self, event):
        only_fields(event, ("id", "intentId", "brokerOrderId", "kind", "time", "quantity", "priceCents", "feeCents"))
        require(identifier(event.get("id")) and identifier(event.get("brokerOrderId")), "Invalid broker identifiers")
        if event["id"] in self.receipts:
            require(json.dumps(event, sort_keys=True) == json.dumps(self.receipts[event["id"]], sort_keys=True), "Conflicting duplicate receipt")
            return dict(applied=False, duplicate=True)
        self._event_budget()
        self._ordered(event.get("time"))
        require(event.get("kind") in ("accepted", "fill", "cancelled", "rejected", "expired"), "Unknown receipt kind")
        require(event.get("intentId") in self.orders, "Unknown intent")
        order = copy.deepcopy(self.orders[event["intentId"]])
        lot = copy.deepcopy(self.lots[order["lotId"]])
        asset = self.assets[order["asset"]]
        require(event["time"] >= order["time"], "Receipt precedes intent")
        native_id = event["brokerOrderId"]
        require(native_id not in self.broker or self.broker[native_id] == order["id"], "Broker order moved between intents")
        require(order["brokerOrderId"] is None or order["brokerOrderId"] == native_id, "Intent changed its broker order")
        require(self._open(order) or event["kind"] == "accepted" and order["brokerOrderId"] == native_id, "New transition after terminal receipt")
        order["brokerOrderId"], order["lastEventTime"] = native_id, event["time"]
        cash = self.cash
        if event["kind"] == "fill":
            quantity, price, fee = event.get("quantity"), event.get("priceCents"), event.get("feeCents")
            require(integer(quantity, 1) and quantity % asset["quantityStep"] == 0 and integer(price, 1) and integer(fee), "Invalid fill quantity, price or fee")
            require(order["filledQuantity"] + quantity <= order["quantity"], "Overfilled order")
            gross = quantity * price * asset["multiplier"]
            order["grossCents"] = checked(order["grossCents"] + gross)
            order["feesCents"] = checked(order["feesCents"] + fee)
            if order["side"] == "buy":
                spent = checked(gross + fee)
                require(spent <= order["cashReservedCents"], "Fill exceeds its cash cap")
                cash -= spent
                order["cashReservedCents"] -= spent
                lot["quantity"] = checked(lot["quantity"] + quantity)
                lot["boughtQuantity"] = checked(lot["boughtQuantity"] + quantity)
                if lot["firstFillTime"] is None:
                    lot["firstFillTime"] = event["time"]
            else:
                require(quantity <= lot["quantity"], "Foreign filled inventory")
                cash += gross - fee
                lot["quantity"] -= quantity
                lot["soldQuantity"] = checked(lot["soldQuantity"] + quantity)
            lot["lastFillTime"] = event["time"]
            order["filledQuantity"] += quantity
            order["status"] = "filled" if order["filledQuantity"] == order["quantity"] else "partially-filled"
            if not self._open(order):
                order["cashReservedCents"] = 0
        else:
            require(not any(field in event for field in ("quantity", "priceCents", "feeCents")), "Non-fill receipt carries fill data")
            if event["kind"] == "accepted":
                if order["status"] == "admitted":
                    order["status"] = "accepted"
            else:
                order["status"], order["cashReservedCents"] = event["kind"], 0
        orders, lots = dict(self.orders), dict(self.lots)
        orders[order["id"]], lots[lot["id"]] = order, lot
        self._validate_book(cash, orders, lots)
        self.cash, self.orders, self.lots = cash, orders, lots
        self.broker[native_id] = order["id"]
        self.receipts[event["id"]] = copy.deepcopy(event)
        self.time = event["time"]
        self.journal.append(dict(kind="broker-event", event=dict(copy.deepcopy(event), sequence=len(self.journal) + 1)))
        self.event_count += 1
        return dict(applied=True, duplicate=False)

    def status(self, owners):
        require(isinstance(owners, list) and all(owner in self.owners for owner in owners), "Unknown subtree ownership")
        selected = set(owners)
        active = any(lot["owner"] in selected and lot["quantity"] > 0 for lot in self.lots.values())
        pending = any(order["owner"] in selected and self._open(order) for order in self.orders.values())
        return dict(active=active, pending=pending, resettable=not active and not pending)

    def snapshot(self):
        lots = [dict(lot, reservedQuantity=self._reserved_lot(lot["id"]), pending=bool(self._pending(lot["id"])),
                     roundTripComplete=lot["boughtQuantity"] > 0 and lot["quantity"] == 0 and not self._pending(lot["id"])) for lot in self.lots.values()]
        positions = [dict(asset=asset["id"], quantity=checked(sum(lot["quantity"] for lot in lots if lot["asset"] == asset["id"]))) for asset in self.config["assets"]]
        reserved = self._reserved_cash()
        return copy.deepcopy(dict(version=1, config=self.config, cashCents=self.cash, reservedCashCents=reserved, availableCashCents=self.cash - reserved,
                                  tickets=list(self.orders.values()), lots=lots, positions=positions, journal=self.journal,
                                  decisions=[row["decision"] for row in self.journal if row["kind"] == "intent"], events=[row["event"] for row in self.journal if row["kind"] != "intent"]))


def exercise(request):
    ledger = ExecutionLedger(request["config"])
    errors = []
    for index, action in enumerate(request["actions"]):
        try:
            if action["kind"] == "intent":
                ledger.admit(action["intent"])
            elif action["kind"] == "event":
                ledger.reconcile(action["event"])
            elif action["kind"] == "cancel":
                ledger.request_cancel(action["intentId"], action["time"])
            else:
                raise ValueError("Unknown action")
        except (ValueError, KeyError, TypeError):
            errors.append(index)
    return dict(errors=errors, snapshot=ledger.snapshot())


if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(json.dumps([exercise(item) for item in request] if isinstance(request, list) else exercise(request), sort_keys=True))
