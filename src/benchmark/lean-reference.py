"""Standalone semantic reference and LEAN decision kernel, version 1.

This implementation does not invoke the JavaScript interpreter. It consumes
the same typed semantic tree and records private lots in individual nodes.
Review the constitution and this entire file before admitting a counted task.
"""
import json
import sys
from execution_reference import ExecutionLedger, require


class Node:
    def __init__(self, spec):
        self.spec = spec
        self.kind = spec["kind"]
        self.path = spec["path"]
        self.children = [] if self.kind == "strategy" else [Node(spec["children"][key]) for key in spec.get("childOrder", spec["children"])]
        self.clear()

    def clear(self):
        self.quantity = 0
        self.entry = None
        self.complete = False
        self.position = 0
        self.owner = None
        self.latched = False
        self.lot_id = None
        for child in self.children:
            child.clear()

    def leaves(self):
        if self.kind == "strategy":
            yield self
        for child in self.children:
            yield from child.leaves()


class Reference:
    def __init__(self, semantic, cash_cents, dispatch=None):
        self.root = Node(semantic)
        self.nodes = {leaf.path: leaf for leaf in self.root.leaves()}
        self.ledger = ExecutionLedger(dict(version=1, cashCents=cash_cents, currency="USD",
            assets=[dict(id=symbol, multiplier=1, quantityStep=1) for symbol in sorted({leaf.spec["symbol"] for leaf in self.nodes.values()})],
            owners=list(self.nodes), limits=dict(intents=100000, events=1000000)))
        self.dispatch = dispatch or self.simulate_full_fill
        self.serial = 0
        self.history = {}
        self.tape = []
        self.coverage = set()
        self.bar = -1
        self.prices = {}
        self.time = 0

    @property
    def cash(self):
        return self.ledger.cash

    def reconcile(self, event):
        result = self.ledger.reconcile(event)
        if not result["applied"] or event["kind"] != "fill":
            return
        ticket = self.ledger.orders[event["intentId"]]
        node = self.nodes[ticket["owner"]]
        require(node.lot_id == ticket["lotId"], "A fill addressed a cleared or foreign strategy lot")
        node.quantity = self.ledger.lots[node.lot_id]["quantity"]
        quantity = event["quantity"] * (1 if ticket["side"] == "buy" else -1)
        if quantity > 0 and node.entry is None:
            node.entry = self.bar
        self.tape.append(dict(bar=self.bar, path=node.path, symbol=ticket["asset"],
                              quantity=quantity, priceCents=event["priceCents"], reason=ticket["reason"]))
        self.coverage.add(node.path + ":" + ticket["reason"])

    def simulate_full_fill(self, intent):
        # This is the explicitly controlled v1 interpretation model. Native
        # generation supplies its own dispatcher and calls reconcile only
        # from real OrderEvents; it never runs this simulation.
        self.reconcile(dict(id=intent["id"] + ":fill", intentId=intent["id"], brokerOrderId=intent["id"],
                            kind="fill", time=self.time, quantity=intent["quantity"],
                            priceCents=self.prices[intent["asset"]], feeCents=0))

    def condition(self, rule, symbol, node):
        price = self.prices.get(symbol)
        if not price:
            return False
        values = self.history.get(symbol, [])
        kind = rule["kind"]
        if kind == "above":
            return price > rule["value"]
        if kind == "below":
            return price < rule["value"]
        if kind == "cross_up":
            return len(values) >= 2 and values[-2] <= rule["value"] < price
        if kind == "above_sma":
            period = rule["period"]
            return len(values) >= period and price * period > sum(values[-period:])
        if kind == "after":
            return node.entry is not None and self.bar - node.entry >= rule["bars"]
        raise ValueError("Unknown predicate: " + kind)

    def order(self, node, quantity, reason):
        symbol = node.spec["symbol"]
        price = self.prices.get(symbol)
        if not quantity or not price:
            return False
        if quantity > 0 and quantity * price > self.cash:
            return False
        self.serial += 1
        intent_id = "intent-" + str(self.serial)
        lot_id = intent_id + ":lot" if quantity > 0 else node.lot_id
        intent = dict(id=intent_id, owner=node.path, lotId=lot_id, asset=symbol,
                      side="buy" if quantity > 0 else "sell", quantity=abs(quantity),
                      cashCapCents=quantity * price if quantity > 0 else 0, reason=reason, time=self.time)
        if not self.ledger.admit(intent)["admitted"]:
            return False
        node.lot_id = lot_id
        self.dispatch(intent)
        require(self.ledger.orders[intent_id]["status"] == "filled", "Version 1 requires a reconciled synchronous full fill")
        return True

    def tick(self, node, entries):
        spec = node.spec
        if node.kind == "strategy":
            if node.complete or not self.prices.get(spec["symbol"]):
                return
            rules = spec["children"]
            if node.quantity:
                if self.condition(rules["sell_reason"], spec["symbol"], node):
                    process = rules["sell_process"]
                    amount = node.quantity if process["kind"] == "all" else max(1, node.quantity * process["basisPoints"] // 10000)
                    self.order(node, -amount, "sell")
                    node.complete = node.quantity == 0
            elif entries and self.condition(rules["buy_reason"], spec["symbol"], node):
                process = rules["buy_process"]
                amount = process["quantity"] if process["kind"] == "shares" else self.cash * process["basisPoints"] // (10000 * self.prices[spec["symbol"]])
                self.order(node, amount, "buy")
            return
        if node.kind == "reset" and self.condition(spec["predicate"], spec["symbol"], node):
            held = [leaf for leaf in node.leaves() if leaf.quantity]
            if all(self.prices.get(leaf.spec["symbol"]) for leaf in held):
                for leaf in held:
                    self.order(leaf, -leaf.quantity, "reset")
                require(self.ledger.status([leaf.path for leaf in node.leaves()])["resettable"], "Cannot clear a subtree with private inventory or pending tickets")
                node.clear()
                self.coverage.add(node.path + ":reset")
            return
        if node.complete:
            return
        if node.kind in ("state_gate", "event_gate"):
            opened = self.condition(spec["predicate"], spec["symbol"], node)
            node.latched = node.latched or opened
            if opened:
                self.coverage.add(node.path + ":open")
            entries = entries and (node.latched if node.kind == "event_gate" else opened)
        if node.kind == "sequence":
            if node.position < len(node.children):
                child = node.children[node.position]
                self.tick(child, entries)
                if child.complete:
                    node.position += 1
                    self.coverage.add(node.path + ":advance")
            node.complete = node.position == len(node.children)
        elif node.kind == "race":
            if node.owner is None:
                for index, child in enumerate(node.children):
                    before = len(self.tape)
                    self.tick(child, entries)
                    if any(fill["quantity"] > 0 for fill in self.tape[before:]):
                        node.owner = index
                        self.coverage.add(node.path + ":winner")
                        break
            else:
                self.tick(node.children[node.owner], entries)
            node.complete = node.owner is not None and node.children[node.owner].complete
        else:
            for child in node.children:
                self.tick(child, entries)
            node.complete = all(child.complete for child in node.children)

    def step(self, prices, time=None):
        self.bar += 1
        self.time = self.bar if time is None else time
        self.prices = prices
        for symbol, price in prices.items():
            if price:
                self.history.setdefault(symbol, []).append(price)
        before = len(self.tape)
        self.tick(self.root, True)
        return self.tape[before:]

    def result(self):
        return dict(trace=self.tape, cashCents=self.cash,
                    lots={leaf.path: leaf.quantity for leaf in self.root.leaves() if leaf.quantity},
                    coverage=sorted(self.coverage))


def interpret(semantic, inputs):
    reference = Reference(semantic, inputs["cashCents"])
    for bar in inputs["bars"]:
        reference.step(bar["prices"])
    return reference.result()


if __name__ == "__main__":
    request = json.load(sys.stdin)
    result = interpret(request["semantic"], request["input"])
    print(json.dumps(result, sort_keys=True))
