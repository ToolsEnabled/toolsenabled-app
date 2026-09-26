"""Independent Python broker simulation for the declared draft study fixture.

This interpreter neither imports JavaScript nor executes candidate code. It
produces its own normalized orders, receipt sequence and private fill book.
Native qualification must additionally compare the actual LEAN artifacts.
"""
import json
import sys
from trading_reference import TradingRuntime


def simulate(ir, data):
    orders, events, lots, pending, cancellations = [], [], [], {}, []
    owners = {node["namespace"]: node["path"] for node in ir["nodes"]}
    local_lots, last_prices = {}, {}
    cash = ir["execution"]["cashCents"]
    positions = {asset["id"]: 0 for asset in ir["execution"]["assets"]}
    index = -1

    def receipt(ticket, status, quantity=0, price=0):
        nonlocal cash
        order = ticket["order"]
        ticket["serial"] += 1
        now = data["bars"][index]["time"]
        order["status"] = status
        order["pending"] = status not in ("filled", "cancelled", "rejected")
        events.append(dict(order=order["order"], time=now, status=status,
                           quantity=quantity, priceCents=price, feeCents=0))
        if quantity:
            order["filledQuantity"] += abs(quantity)
            order["unfilledQuantity"] -= abs(quantity)
            lot = ticket["lot"]
            if quantity > 0:
                lot["boughtQuantity"] += quantity
                if lot["firstFillTime"] is None:
                    lot["firstFillTime"] = now
            else:
                lot["soldQuantity"] -= quantity
            lot["quantity"] += quantity
            lot["lastFillTime"] = now
            positions[order["asset"]] += quantity
            cash -= quantity * price
        if status == "cancel-pending":
            return
        event = dict(id=str(order["order"]) + ":" + str(ticket["serial"]),
                     intentId=ticket["intent"]["id"], brokerOrderId=str(order["order"]), time=now,
                     kind={"accepted": "accepted", "filled": "fill", "partial": "fill", "cancelled": "cancelled"}[status])
        if quantity:
            event.update(quantity=abs(quantity), priceCents=price, feeCents=0)
        runtime.reconcile(event)

    def submit(intent):
        settle_cancellations()
        owner = owners[intent["owner"]]
        local = local_lots.setdefault(owner, {})
        if intent["side"] == "buy":
            lot = dict(owner=owner, lot=len(local) + 1, asset=intent["asset"], boughtQuantity=0,
                       soldQuantity=0, quantity=0, firstFillTime=None, lastFillTime=None)
            local[intent["lotId"]] = lot
            lots.append(lot)
        lot = local[intent["lotId"]]
        order = dict(order=len(orders) + 1, owner=owner, lot=lot["lot"], asset=intent["asset"], time=intent["time"],
                     quantity=intent["quantity"] * (1 if intent["side"] == "buy" else -1), reason=intent["reason"],
                     status="new", filledQuantity=0, feesCents=0, unfilledQuantity=intent["quantity"], pending=True)
        orders.append(order)
        ticket = dict(intent=intent, order=order, lot=lot, created=index, serial=0)
        pending[intent["id"]] = ticket
        receipt(ticket, "accepted")

    def cancel(identifier):
        receipt(pending[identifier], "cancel-pending")
        cancellations.append(identifier)

    def settle_cancellations():
        for identifier in cancellations:
            receipt(pending.pop(identifier), "cancelled")
        cancellations.clear()

    runtime = TradingRuntime(ir, dispatch=submit, cancel=cancel)
    for index, bar in enumerate(data["bars"]):
        last_prices.update({asset: price for asset, price in bar["prices"].items() if price is not None})
        for identifier, ticket in list(pending.items()):
            price = bar["prices"].get(ticket["intent"]["asset"])
            if index - ticket["created"] < data["market"]["delayBars"] or price is None:
                continue
            quantity = min(data["market"]["maxFillQuantity"], ticket["order"]["unfilledQuantity"])
            filled = quantity == ticket["order"]["unfilledQuantity"]
            receipt(ticket, "filled" if filled else "partial", quantity * (1 if ticket["intent"]["side"] == "buy" else -1), price)
            if filled:
                del pending[identifier]
        runtime.step(bar)
        settle_cancellations()
    observation = dict(format="lean-operational-observation", version=1, orders=orders, events=events, lots=lots,
                       cashFromFillsCents=cash, positionsFromFills=[dict(asset=asset, quantity=quantity) for asset, quantity in positions.items()],
                       feesCents=0, equityCents=dict(start=ir["execution"]["cashCents"],
                                                  end=cash + sum(quantity * last_prices.get(asset, 0) for asset, quantity in positions.items())))
    return dict(observation=observation, snapshot=runtime.snapshot())


if __name__ == "__main__":
    task = json.load(sys.stdin)
    print(json.dumps(simulate(task["ir"], task["input"]), separators=(",", ":"), allow_nan=False))
