"""Independent operational consumer of lean-operational-ir.

This Python controller uses a tree of private node states and derives status
from its Python order book. It does not run JavaScript, predict broker fills,
or select an approved study policy. Bar inputs and receipts share one clock.
"""
import copy
import json
import re
import sys
from execution_reference import ExecutionLedger, TERMINAL, integer, only_fields, require

ROLES = ("buy_reason", "buy_process", "sell_reason", "sell_process")
IDENTIFIER = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")


def initial_state():
    return dict(generation=0, completed=False, completedAt=None, lastActionTime=None,
                blockedThrough=None, lotId=None, firstFillTime=None, holdingBars=0,
                historyAfterTime=None, cursor=0, winner=None, winnerHadFill=False,
                gateOpen=False, gateOpenedBar=None, gateArmed=True, previousGate=False,
                previousReset=False, drain=None)


def validate_ir(ir):
    only_fields(ir, ("format", "version", "compositionSha256", "execution", "contract", "nodes", "historyWindows"))
    require(ir.get("format") == "lean-operational-ir" and type(ir.get("version")) is int and ir["version"] == 1
            and isinstance(ir.get("compositionSha256"), str) and re.fullmatch("[a-f0-9]{64}", ir["compositionSha256"]), "Invalid operational representation")
    ExecutionLedger(ir["execution"])
    contract = ir["contract"]
    expected = dict(dispatch="completed-bar-only", entryFailure="retry-next-bar", sameBar="one-action-per-strategy",
                    completion="flat-and-terminal-roundtrip", reset="cancel-then-liquidate-before-clear",
                    unreadyGate="block-entry-without-new-transition", resetTriggerHistory="preserve-requesting-controller",
                    ancestorReset="invalidate-completion-rewind-sequence", raceReset="release-cleared-winning-child",
                    controllerEventBudget=ir["execution"]["limits"]["events"])
    require(isinstance(contract, dict) and set(contract) == set(expected) | {"barBudget", "exitWhileEntryPending", "resetHistory"}
            and all(contract[key] == value for key, value in expected.items())
            and integer(contract["barBudget"], 1) and contract["barBudget"] <= 1000000
            and contract["exitWhileEntryPending"] in ("wait-terminal", "owned-quantity")
            and contract["resetHistory"] in ("retain-observations", "restart-subtree"), "Invalid operational contract")
    assets = {asset["id"]: asset for asset in ir["execution"]["assets"]}
    windows = {}

    def predicate(rule, depth=0):
        require(isinstance(rule, dict) and depth <= 64, "Invalid predicate")
        kind = rule.get("kind")
        if kind in ("and", "or"):
            only_fields(rule, ("kind", "clauses"))
            require(isinstance(rule.get("clauses"), list) and 2 <= len(rule["clauses"]) <= 4, "Invalid predicate clauses")
            for item in rule["clauses"]:
                predicate(item, depth + 1)
        elif kind == "after":
            only_fields(rule, ("kind", "bars"))
            require(integer(rule.get("bars"), 1) and rule["bars"] <= 100000, "Invalid holding period")
        else:
            average = kind in ("above_sma", "below_sma")
            require(kind in ("above", "below", "cross_up", "cross_down", "above_sma", "below_sma")
                    and rule.get("asset") in assets, "Invalid price predicate")
            only_fields(rule, ("kind", "asset", "period" if average else "value"))
            count = rule.get("period") if average else 2 if kind.startswith("cross_") else 1
            require(integer(count, 2) and count <= 10000 if average else integer(rule.get("value"), 1), "Invalid predicate boundary")
            windows[rule["asset"]] = max(windows.get(rule["asset"], 1), count)

    def gate(rule):
        require(isinstance(rule, dict) and rule.get("kind") in ("none", "state", "event"), "Invalid gate")
        if rule["kind"] == "none":
            only_fields(rule, ("kind",))
            return
        only_fields(rule, ("kind", "predicate", "close") if rule["kind"] == "state"
                    else ("kind", "predicate", "close", "trigger", "ttlBars", "rearm"))
        predicate(rule["predicate"])
        require(rule.get("close") in ("block-entries", "drain-and-reset"), "Invalid gate close")
        if rule["kind"] == "event":
            require(rule.get("trigger") in ("level", "rising-edge") and "ttlBars" in rule
                    and (rule["ttlBars"] is None or integer(rule["ttlBars"], 1) and rule["ttlBars"] <= 100000)
                    and rule.get("rearm") in ("after-false-while-closed", "subtree-reset"), "Invalid event gate")

    nodes, owners, paths = ir["nodes"], [], set()
    require(isinstance(nodes, list) and 1 <= len(nodes) <= 4096, "Invalid node budget")
    path_size = 0
    for index, node in enumerate(nodes):
        only_fields(node, ("index", "namespace", "path", "parent", "slot", "kind", "children", "scopeEnd",
                           "requirementId", "roles", "operator", "policy", "asset", "gate", "reset", "initialState"))
        require(type(node.get("index")) is int and node["index"] == index and node.get("namespace") == "n" + str(index)
                and isinstance(node.get("path"), str) and node["path"] not in paths
                and integer(node.get("scopeEnd"), index + 1) and node["scopeEnd"] <= len(nodes)
                and json.dumps(node["initialState"], sort_keys=True) == json.dumps(initial_state(), sort_keys=True), "Invalid node identity")
        paths.add(node["path"])
        path_size += len(node["path"])
        require(path_size <= 8 * 1024 * 1024, "Path budget exceeded")
        if index == 0:
            require(node["parent"] is None and node["slot"] is None and node["path"] == "root" and node["scopeEnd"] == len(nodes), "Invalid root")
        else:
            require(integer(node.get("parent")) and node["parent"] < index and isinstance(node.get("slot"), str)
                    and IDENTIFIER.fullmatch(node["slot"]) and node["path"] == nodes[node["parent"]]["path"] + "/" + node["slot"]
                    and index in nodes[node["parent"]]["children"], "Invalid parent")
        children = node["children"]
        require(isinstance(children, list) and all(type(child) is int for child in children) and len(set(children)) == len(children), "Invalid children")
        cursor = index + 1
        for child in children:
            require(child == cursor and child < node["scopeEnd"] and nodes[child]["parent"] == index, "Invalid child order")
            cursor = nodes[child]["scopeEnd"]
        require(cursor == node["scopeEnd"], "Invalid scope")

        def linked(identifier, path):
            return isinstance(identifier, str) and identifier.startswith(path + "#") and IDENTIFIER.fullmatch(identifier[len(path) + 1:])

        require(linked(node.get("requirementId"), node["path"]), "Missing node requirement")
        if node["kind"] == "strategy":
            require(not children and node["asset"] in assets and node["operator"] is None and node["policy"] is None
                    and node["gate"] == {"kind": "none"} and node["reset"] is None and set(node["roles"]) == set(ROLES), "Invalid strategy")
            owners.append(node["namespace"])
            for role in ROLES:
                binding = node["roles"][role]
                only_fields(binding, ("rule", "requirementId"))
                require(linked(binding.get("requirementId"), node["path"] + "/" + role), "Missing role requirement")
                rule = binding["rule"]
                require(isinstance(rule, dict), "Invalid role rule")
                kind = rule.get("kind")
                if role.endswith("reason"):
                    predicate(rule)
                elif role == "buy_process":
                    if kind == "shares":
                        only_fields(rule, ("kind", "quantity", "cashCapCents"))
                        require(integer(rule.get("quantity"), 1) and rule["quantity"] % assets[node["asset"]]["quantityStep"] == 0
                                and integer(rule.get("cashCapCents"), 1), "Invalid fixed quantity")
                    else:
                        require(kind in ("cash_fraction", "fixed_cash"), "Invalid purchase")
                        only_fields(rule, ("kind", "feeAllowanceCents", "basisPoints" if kind == "cash_fraction" else "cashCents"))
                        require(integer(rule.get("feeAllowanceCents")) and (integer(rule.get("basisPoints"), 1) and rule["basisPoints"] <= 10000
                                if kind == "cash_fraction" else integer(rule.get("cashCents"), 1)), "Invalid budget")
                else:
                    require(kind in ("all", "fraction"), "Invalid sale")
                    only_fields(rule, ("kind",) if kind == "all" else ("kind", "basisPoints"))
                    require(kind == "all" or integer(rule.get("basisPoints"), 1) and rule["basisPoints"] <= 10000, "Invalid exit fraction")
        else:
            require(node["kind"] == "template" and 2 <= len(children) <= 4 and node["asset"] is None and node["roles"] is None, "Invalid template")
            operator, policy = node["operator"], node["policy"]
            require(operator in ("all", "sequence", "race"), "Invalid operator")
            if operator == "all":
                require(policy == {}, "Invalid ALL policy")
            elif operator == "sequence":
                require(policy == {"handoff": "next-bar"}, "Invalid SEQUENCE policy")
            else:
                require(isinstance(policy, dict) and set(policy) == {"claim", "release", "losers"}
                        and policy["claim"] in ("broker-accepted", "first-fill") and policy["release"] == "empty-or-complete-next-bar"
                        and policy["losers"] == "cancel-then-liquidate", "Invalid RACE policy")
            gate(node["gate"])
            if node["reset"] is not None:
                only_fields(node["reset"], ("predicate", "trigger"))
                require(node["reset"].get("trigger") in ("level", "rising-edge"), "Invalid reset")
                predicate(node["reset"]["predicate"])
    require(owners == ir["execution"]["owners"] and ir["historyWindows"] == [dict(asset=asset, observations=count)
            for asset, count in sorted(windows.items())], "Operational dependencies changed")


class Node:
    def __init__(self, spec):
        self.spec = spec
        self.state = initial_state()
        self.parent, self.children = None, []

    def descendants(self):
        pending = [self]
        while pending:
            child = pending.pop()
            yield child
            pending.extend(reversed(child.children))

    def ancestors(self):
        parent = self.parent
        while parent is not None:
            yield parent
            parent = parent.parent


class TradingRuntime:
    def __init__(self, ir, dispatch=None, cancel=None):
        validate_ir(ir)
        self.ir = copy.deepcopy(ir)
        self.contract = self.ir["contract"]
        self.ledger = ExecutionLedger(self.ir["execution"])
        self.nodes = [Node(spec) for spec in self.ir["nodes"]]
        self.paths = {node.spec["path"]: node for node in self.nodes}
        for node in self.nodes:
            node.children = [self.nodes[index] for index in node.spec["children"]]
            node.parent = None if node.spec["parent"] is None else self.nodes[node.spec["parent"]]
        self.dispatch, self.cancel = dispatch or (lambda intent: None), cancel or (lambda intent: None)
        self.time, self.last_bar_time, self.bar_index = -1, -1, -1
        self.stepping, self.serial = False, 0
        self.prices, self.history = {}, {}
        self.windows = {row["asset"]: row["observations"] for row in self.ir["historyWindows"]}
        self.transitions, self.timeline, self.coverage = [], [], {}
        self.issued, self.receipts = {}, {}
        self._book_version, self._cached_book = -1, None

    def book(self):
        if len(self.ledger.journal) != self._book_version:
            self._cached_book = self.ledger.snapshot()
            self._book_version = len(self.ledger.journal)
        return self._cached_book

    def lot(self, node):
        return next((lot for lot in self.book()["lots"] if lot["id"] == node.state["lotId"]), None)

    def flags(self, node):
        owners = [child.spec["namespace"] for child in node.descendants() if child.spec["kind"] == "strategy"]
        return self.ledger.status(owners)

    def mark(self, node, kind, **details):
        require(len(self.transitions) < self.contract["controllerEventBudget"], "Controller event budget exhausted")
        self.transitions.append(dict(sequence=len(self.transitions) + 1, time=self.time, path=node.spec["path"],
                                     requirementId=node.spec["requirementId"], kind=kind, **copy.deepcopy(details)))

    def observe(self, requirement, result=None):
        counts = self.coverage.setdefault(requirement, dict(evaluated=0, ready=0, true=0, actions=0))
        if result is None:
            counts["actions"] += 1
        else:
            counts["evaluated"] += 1
            counts["ready"] += int(result[0])
            counts["true"] += int(result[0] and result[1])

    def evaluate(self, node, rule):
        kind = rule["kind"]
        if kind == "after":
            ready = node.state["firstFillTime"] is not None
            return ready, ready and node.state["holdingBars"] >= rule["bars"]
        if kind in ("and", "or"):
            results = [self.evaluate(node, clause) for clause in rule["clauses"]]
            ready = all(value[0] for value in results)
            return ready, ready and (all(value[1] for value in results) if kind == "and" else any(value[1] for value in results))
        asset = rule["asset"]
        if not integer(self.prices.get(asset), 1):
            return False, False
        after = node.state["historyAfterTime"]
        values = [price for time, price in self.history.get(asset, []) if after is None or time > after]
        period = rule.get("period", 2 if kind.startswith("cross_") else 1)
        if len(values) < period:
            return False, False
        price = self.prices[asset]
        if kind == "above":
            value = price > rule["value"]
        elif kind == "below":
            value = price < rule["value"]
        elif kind == "cross_up":
            value = values[-2] <= rule["value"] < price
        elif kind == "cross_down":
            value = values[-2] >= rule["value"] > price
        elif kind == "above_sma":
            value = price * period > sum(values[-period:])
        else:
            value = price * period < sum(values[-period:])
        return True, value

    def eligible(self, node):
        return node.state["blockedThrough"] is None or self.time > node.state["blockedThrough"]

    def selected(self, node):
        if node.spec["operator"] == "sequence":
            return node.children[node.state["cursor"]:node.state["cursor"] + 1]
        if node.spec["operator"] == "race" and node.state["winner"] is not None:
            return [self.nodes[node.state["winner"]]]
        return node.children

    def ancestors_allow(self, node):
        child = node
        for parent in node.ancestors():
            state, gate = parent.state, parent.spec["gate"]
            if state["completed"] or state["drain"] or not self.eligible(parent):
                return False
            if gate["kind"] != "none" and (not state["gateOpen"] or not self.evaluate(parent, gate["predicate"])[0]):
                return False
            if child not in self.selected(parent):
                return False
            child = parent
        return True

    def size(self, node):
        spec, rule = node.spec, node.spec["roles"]["buy_process"]["rule"]
        if not integer(self.prices.get(spec["asset"]), 1):
            return 0, 0
        asset = self.ledger.assets[spec["asset"]]
        cost = self.prices[spec["asset"]] * asset["multiplier"]
        if rule["kind"] == "shares":
            return (rule["quantity"] if rule["quantity"] * cost <= rule["cashCapCents"] else 0), rule["cashCapCents"]
        budget = self.book()["availableCashCents"] * rule["basisPoints"] // 10000 if rule["kind"] == "cash_fraction" else rule["cashCents"]
        step = asset["quantityStep"]
        return max(0, budget - rule["feeAllowanceCents"]) // cost // step * step, budget

    def readiness(self, node):
        if node.spec["kind"] == "strategy":
            price = integer(self.prices.get(node.spec["asset"]), 1)
            return dict(entry=price and self.evaluate(node, node.spec["roles"]["buy_reason"]["rule"])[0],
                        exit=price and self.evaluate(node, node.spec["roles"]["sell_reason"]["rule"])[0])
        children = [self.readiness(child) for child in self.selected(node)]
        gate = node.spec["gate"]
        return dict(entry=(gate["kind"] == "none" or self.evaluate(node, gate["predicate"])[0]) and any(child["entry"] for child in children),
                    exit=any(child["exit"] for child in children))

    def can_initiate(self, node):
        if node.state["completed"] or node.state["drain"] or not self.eligible(node) or not self.ancestors_allow(node):
            return False
        if node.spec["kind"] == "strategy":
            flags = self.flags(node)
            if flags["active"] or flags["pending"] or node.state["lastActionTime"] == self.time:
                return False
            ready, value = self.evaluate(node, node.spec["roles"]["buy_reason"]["rule"])
            quantity, cap = self.size(node)
            return ready and value and quantity > 0 and cap <= self.book()["availableCashCents"]
        gate = node.spec["gate"]
        if gate["kind"] != "none" and (not node.state["gateOpen"] or not self.evaluate(node, gate["predicate"])[0]):
            return False
        return any(self.can_initiate(child) for child in self.selected(node))

    def begin_drain(self, node, cause, keep_gate=False):
        if node.state["drain"] is None:
            node.state["drain"] = dict(phase="cancel", cause=cause, keepGate=keep_gate)
            self.mark(node, "subtree-draining", cause=cause)
            child = node
            for parent in node.ancestors():
                position = parent.children.index(child)
                rewind = parent.spec["operator"] == "sequence" and position < parent.state["cursor"]
                if parent.state["completed"] or rewind:
                    parent.state.update(completed=False, completedAt=None)
                    if rewind:
                        parent.state.update(cursor=position, blockedThrough=self.time)
                    self.mark(parent, "descendant-reset", child=child.spec["path"], cursor=parent.state["cursor"])
                child = parent

    def clear(self, node):
        require(self.flags(node)["resettable"], "Cannot clear inventory or pending orders")
        previous = copy.deepcopy(node.state)
        for child in node.descendants():
            old = child.state
            child.state = initial_state()
            child.state.update(generation=old["generation"] + 1, blockedThrough=self.time,
                               historyAfterTime=self.time if self.contract["resetHistory"] == "restart-subtree" else old["historyAfterTime"])
        node.state["previousReset"] = previous["previousReset"]
        if previous["drain"]["keepGate"]:
            for key in ("gateOpen", "gateOpenedBar", "gateArmed", "previousGate"):
                node.state[key] = previous[key]
        self.mark(node, "subtree-cleared", cause=previous["drain"]["cause"],
                  generation=node.state["generation"], scopeEnd=node.spec["scopeEnd"])
        if node.parent is not None and node.parent.spec["operator"] == "race" and node.parent.state["winner"] == node.spec["index"]:
            node.parent.state["winnerHadFill"] = False

    def complete(self, node):
        if not node.state["completed"]:
            node.state.update(completed=True, completedAt=self.time)
            self.mark(node, "roundtrip-completed")

    def settle(self):
        for node in self.nodes:
            if node.state["drain"] and self.flags(node)["resettable"]:
                self.clear(node)
        for node in reversed(self.nodes):
            state, spec = node.state, node.spec
            if state["completed"] or state["drain"]:
                continue
            if spec["kind"] == "strategy":
                lot = self.lot(node)
                if lot and lot["roundTripComplete"]:
                    self.complete(node)
            elif spec["operator"] == "all":
                if self.flags(node)["resettable"] and all(child.state["completed"] and not child.state["drain"] for child in node.children):
                    self.complete(node)
            elif spec["operator"] == "sequence":
                selected = self.selected(node)
                if selected and selected[0].state["completed"] and not selected[0].state["drain"]:
                    state["cursor"] += 1
                    state["blockedThrough"] = self.time
                    self.mark(node, "sequence-advanced", child=selected[0].spec["path"], cursor=state["cursor"])
                if state["cursor"] == len(node.children) and self.flags(node)["resettable"]:
                    self.complete(node)
            elif state["winner"] is not None:
                winner = self.nodes[state["winner"]]
                empty = not state["winnerHadFill"] and self.flags(winner)["resettable"]
                finished = state["winnerHadFill"] and winner.state["completed"] and not winner.state["drain"]
                if (empty or finished) and self.flags(node)["resettable"] and all(not child.state["drain"] for child in node.children):
                    state.update(winner=None, winnerHadFill=False, blockedThrough=self.time)
                    self.mark(node, "race-released", winner=winner.spec["path"], cause="completed-roundtrip" if finished else "empty-entry")
                    if finished:
                        self.complete(node)

    def issue(self, node, side, quantity, cap, reason):
        if quantity == 0 or node.state["lastActionTime"] == self.time:
            return
        self.serial += 1
        identifier = "i" + str(self.serial)
        intent = dict(id=identifier, owner=node.spec["namespace"], lotId=identifier + ":lot" if side == "buy" else node.state["lotId"],
                      asset=node.spec["asset"], side=side, quantity=quantity, cashCapCents=cap, reason=reason, time=self.time)
        decision = self.ledger.admit(intent)
        node.state["lastActionTime"] = self.time
        self.mark(node, "intent-admitted" if decision["admitted"] else "intent-skipped",
                  intentId=identifier, side=side, reason=reason, disposition=decision["reason"])
        if decision["admitted"]:
            node.state["lotId"] = intent["lotId"]
            self.issued[identifier] = (node, node.state["generation"], intent["lotId"])
            self.observe(node.spec["roles"]["buy_process" if side == "buy" else "sell_process"]["requirementId"])
            self.timeline.append(dict(kind="dispatch-start", intentId=identifier, time=self.time))
            self.dispatch(copy.deepcopy(intent))
            self.timeline.append(dict(kind="dispatch-end", intentId=identifier, time=self.time))
            self.settle()

    def drain(self, node):
        if not node.state["drain"]:
            return
        if node.state["drain"]["phase"] == "cancel":
            owners = {child.spec["namespace"] for child in node.descendants() if child.spec["kind"] == "strategy"}
            identifiers = [order["id"] for order in self.book()["tickets"] if order["owner"] in owners and order["status"] not in TERMINAL]
            for identifier in identifiers:
                order = self.ledger.orders[identifier]
                if order["status"] in TERMINAL or order["cancellationRequested"]:
                    continue
                self.ledger.request_cancel(identifier, self.time)
                self.mark(node, "cancellation-requested", intentId=identifier, cause=node.state["drain"]["cause"])
                self.timeline.append(dict(kind="cancel-start", intentId=identifier, time=self.time))
                self.cancel(identifier)
                self.timeline.append(dict(kind="cancel-end", intentId=identifier, time=self.time))
                if not node.state["drain"]:
                    return
            if self.flags(node)["pending"]:
                return
            node.state["drain"]["phase"] = "liquidate"
            self.mark(node, "liquidation-ready", cause=node.state["drain"]["cause"])
        for child in node.descendants():
            if not node.state["drain"]:
                return
            if child.spec["kind"] == "strategy":
                lot = self.lot(child)
                if lot and lot["quantity"] > 0 and not lot["pending"] and integer(self.prices.get(child.spec["asset"]), 1):
                    self.issue(child, "sell", lot["quantity"], 0, node.state["drain"]["cause"])
        self.settle()

    def gate(self, node):
        rule, state = node.spec["gate"], node.state
        if rule["kind"] == "none":
            return True
        if rule["kind"] == "event" and state["gateOpen"] and rule["ttlBars"] is not None and self.bar_index - state["gateOpenedBar"] >= rule["ttlBars"]:
            state["gateOpen"] = False
            self.mark(node, "gate-expired")
            if rule["close"] == "drain-and-reset":
                self.begin_drain(node, "gate-close", True)
        ready, value = self.evaluate(node, rule["predicate"])
        self.observe(node.spec["requirementId"] + ":gate", (ready, value))
        if not ready:
            return False
        if rule["kind"] == "state":
            previous = state["gateOpen"]
            state["gateOpen"] = value
            if previous != value:
                self.mark(node, "gate-opened" if value else "gate-closed")
                if not value and rule["close"] == "drain-and-reset":
                    self.begin_drain(node, "gate-close", True)
        else:
            if not state["drain"] and not state["gateOpen"] and not value and rule["rearm"] == "after-false-while-closed":
                state["gateArmed"] = True
            if not state["drain"] and not state["gateOpen"] and state["gateArmed"] and value and (rule["trigger"] == "level" or not state["previousGate"]):
                state.update(gateOpen=True, gateArmed=False, gateOpenedBar=self.bar_index)
                self.mark(node, "gate-opened")
        state["previousGate"] = value
        return state["gateOpen"]

    def visit(self, node, entries):
        spec, state = node.spec, node.state
        if state["drain"]:
            self.drain(node)
            return
        if spec["reset"] is not None:
            ready, value = self.evaluate(node, spec["reset"]["predicate"])
            self.observe(spec["requirementId"] + ":reset", (ready, value))
            trigger = ready and value and (spec["reset"]["trigger"] == "level" or not state["previousReset"])
            if ready:
                state["previousReset"] = value
            if trigger:
                self.begin_drain(node, "reset")
                self.drain(node)
                return
        open_gate = self.gate(node)
        if node.state["drain"]:
            self.drain(node)
            return
        if state["completed"]:
            return
        if spec["kind"] == "strategy":
            if not self.eligible(node) or not integer(self.prices.get(spec["asset"]), 1) or state["lastActionTime"] == self.time:
                return
            lot = self.lot(node)
            if lot and lot["quantity"] > 0:
                if self.contract["exitWhileEntryPending"] == "wait-terminal" and self.ledger.orders[lot["entryIntentId"]]["status"] not in TERMINAL:
                    return
                if any(order["owner"] == spec["namespace"] and order["side"] == "sell" and order["status"] not in TERMINAL for order in self.book()["tickets"]):
                    return
                result = self.evaluate(node, spec["roles"]["sell_reason"]["rule"])
                self.observe(spec["roles"]["sell_reason"]["requirementId"], result)
                if all(result):
                    process, step = spec["roles"]["sell_process"]["rule"], self.ledger.assets[spec["asset"]]["quantityStep"]
                    available = lot["quantity"] - lot["reservedQuantity"]
                    quantity = available if process["kind"] == "all" else max(step, available * process["basisPoints"] // 10000 // step * step)
                    self.issue(node, "sell", quantity, 0, "exit")
            elif entries and self.ancestors_allow(node) and not self.flags(node)["pending"]:
                result = self.evaluate(node, spec["roles"]["buy_reason"]["rule"])
                self.observe(spec["roles"]["buy_reason"]["requirementId"], result)
                if all(result):
                    quantity, cap = self.size(node)
                    self.issue(node, "buy", quantity, cap, "entry")
            return
        entries = entries and open_gate and self.eligible(node)
        if spec["operator"] == "sequence":
            if self.eligible(node):
                for child in self.selected(node):
                    self.visit(child, entries)
        elif spec["operator"] == "race":
            for child in node.children:
                if node.state["completed"] or not self.eligible(node):
                    break
                winner = node.state["winner"]
                if winner is not None and winner != child.spec["index"]:
                    if not self.flags(child)["resettable"] or child.state["drain"]:
                        self.begin_drain(child, "race-release")
                        self.drain(child)
                else:
                    self.visit(child, entries)
        else:
            for child in node.children:
                self.visit(child, entries)
        self.settle()

    def step(self, bar):
        only_fields(bar, ("time", "prices"))
        require(not self.stepping and integer(bar.get("time")) and bar["time"] > self.last_bar_time and bar["time"] >= self.time, "Invalid bar chronology")
        require(self.bar_index + 1 < self.contract["barBudget"], "Completed-bar budget exhausted")
        require(isinstance(bar.get("prices"), dict) and all(asset in self.ledger.assets and (price is None or integer(price, 1)) for asset, price in bar["prices"].items()), "Invalid bar prices")
        self.time = self.last_bar_time = bar["time"]
        self.bar_index += 1
        self.prices = copy.deepcopy(bar["prices"])
        self.timeline.append(dict(kind="bar-start", bar=self.bar_index, time=self.time))
        for asset, price in self.prices.items():
            if price is not None:
                self.history[asset] = (self.history.get(asset, []) + [(self.time, price)])[-self.windows.get(asset, 1):]
        for node in self.nodes:
            if node.state["firstFillTime"] is not None and self.time > node.state["firstFillTime"]:
                node.state["holdingBars"] += 1
        self.stepping = True
        try:
            self.settle()
            self.visit(self.nodes[0], True)
            self.settle()
            self.timeline.append(dict(kind="bar-end", bar=self.bar_index, time=self.time))
        finally:
            self.stepping = False
        return self.snapshot()

    def reconcile(self, event):
        identifier = event.get("id")
        if identifier in self.receipts:
            require(event == self.receipts[identifier], "Changed duplicate receipt")
            return self.ledger.reconcile(event)
        require(integer(event.get("time")) and event["time"] >= self.time and (not self.stepping or event["time"] == self.time)
                and event.get("intentId") in self.issued, "Invalid runtime receipt")
        result = self.ledger.reconcile(event)
        self.receipts[identifier] = copy.deepcopy(event)
        self.time = event["time"]
        self.timeline.append(dict(kind="receipt", id=identifier, time=self.time))
        node, generation, lot_id = self.issued[event["intentId"]]
        if node.state["generation"] != generation or node.state["lotId"] != lot_id:
            return result
        order = self.ledger.orders[event["intentId"]]
        if order["side"] == "buy" and event["kind"] == "fill":
            for ancestor in [node, *node.ancestors()]:
                if ancestor.state["firstFillTime"] is None:
                    ancestor.state["firstFillTime"] = self.time
        if order["status"] in TERMINAL and order["status"] != "filled" and (order["filledQuantity"] == 0 or order["side"] == "sell"):
            node.state["blockedThrough"] = self.time
        if order["side"] == "buy" and (event["kind"] == "fill" or event["kind"] == "accepted" and order["status"] not in TERMINAL):
            child = node
            for parent in node.ancestors():
                state = parent.state
                if parent.spec["operator"] == "race" and not state["completed"] and not state["drain"]:
                    if state["winner"] is None and (parent.spec["policy"]["claim"] == "broker-accepted" or event["kind"] == "fill"):
                        state.update(winner=child.spec["index"], winnerHadFill=event["kind"] == "fill")
                        self.mark(parent, "race-acquired", winner=child.spec["path"], claim=parent.spec["policy"]["claim"])
                    elif state["winner"] == child.spec["index"] and event["kind"] == "fill":
                        state["winnerHadFill"] = True
                child = parent
        self.settle()
        return result

    def request_reset(self, path, at):
        require(path in self.paths and integer(at) and at >= self.time and not self.stepping, "Invalid subtree reset request")
        self.time = at
        self.begin_drain(self.paths[path], "reset")
        self.settle()

    def status(self, path):
        require(path in self.paths, "Unknown trading node")
        node = self.paths[path]
        flags = self.flags(node)
        return dict(readiness=self.readiness(node), canInitiate=self.can_initiate(node),
                    active=flags["active"], pending=flags["pending"],
                    completedRoundTrip=node.state["completed"] and not bool(node.state["drain"]),
                    resetPhase=node.state["drain"]["phase"] if node.state["drain"] else None)

    def snapshot(self):
        return copy.deepcopy(dict(version=1, compositionSha256=self.ir["compositionSha256"],
                                  clock=dict(time=self.time, lastBarTime=self.last_bar_time, barIndex=self.bar_index),
                                  ledger=self.book(), states=[dict(path=node.spec["path"], namespace=node.spec["namespace"],
                                                                 **node.state, **self.status(node.spec["path"])) for node in self.nodes],
                                  transitions=self.transitions, coverage=[dict(requirementId=key, **value) for key, value in sorted(self.coverage.items())],
                                  timeline=self.timeline))


def exercise(request):
    sent, cancellations, checkpoints = [], [], []
    callbacks = []

    def callback(kind, identifier):
        require(callbacks, "Unscheduled operational dispatch")
        action = callbacks.pop(0)
        require(action["kind"] == kind and action["intentId"] == identifier, "Operational callback order differs")
        for event in action["events"]:
            runtime.reconcile(event)

    def dispatch(intent):
        sent.append(intent)
        callback("dispatch", intent["id"])

    def cancel(identifier):
        cancellations.append(identifier)
        callback("cancel", identifier)

    runtime = TradingRuntime(request["ir"], dispatch=dispatch, cancel=cancel)
    for action in request["actions"]:
        if action["kind"] == "bar":
            callbacks = copy.deepcopy(action["callbacks"])
            runtime.step(action["bar"])
            require(not callbacks, "Operational callbacks were not consumed")
        elif action["kind"] == "receipt":
            runtime.reconcile(action["event"])
        elif action["kind"] == "reset":
            runtime.request_reset(action["path"], action["time"])
        else:
            raise ValueError("Unknown operational action")
        if request.get("checkpoints"):
            checkpoints.append(runtime.snapshot())
    return dict(sent=sent, cancelled=cancellations, snapshot=runtime.snapshot(), checkpoints=checkpoints)


if __name__ == "__main__":
    request = json.load(sys.stdin)
    json.dump([exercise(item) for item in request] if isinstance(request, list) else exercise(request), sys.stdout, separators=(",", ":"), allow_nan=False)
    sys.stdout.write("\n")
