"""Isolated regression mutations of the same two synthetic DiDi quotes."""

from rdflib import Graph, Literal, RDF, RDFS, OWL, XSD
from mapping import cls, edge, field, iri

# Expected consistency, shared SHACL, producer SHACL
EXPECT = {
    "schema-only": (True, None, None),
    "projected": (True, True, True),
    "missing-route": (True, False, True),
    "two-routes": (False, False, True),
    "receipt-as-route": (False, False, True),
    "fees-complete": (False, False, True),
    "amount-without-currency": (True, True, False),
    "missing-origin-place": (True, True, False),
    "receipt-from-other-read": (True, True, False),
    "missing-source-identity": (True, True, False),
    "fulfillment-on-read": (True, True, False),
    "minor-in-didi": (True, True, False),
    "missing-estimate-receipt": (True, False, False),
    "impossible-unused-class": (True, True, True),
    "two-titles": (False, False, True),
}


def inputs(model, baseline):
    (estimate,) = baseline.subjects(field("RideEstimate", "estimatedAmount"), None)
    route_edge = edge("RideEstimateBusinessRoute")
    evidence = edge("RideEstimateEvidence")
    route = baseline.value(estimate, route_edge)
    receipt = baseline.value(estimate, evidence)
    other = next(
        s for s in baseline.subjects(RDF.type, cls("SourceReceipt")) if s != receipt
    )
    for name in EXPECT:
        schema = model
        data = baseline + Graph()
        if name == "schema-only":
            data = Graph()
        elif name == "missing-route":
            data.remove((estimate, route_edge, None))
        elif name == "two-routes":
            extra = iri("control", "other-route")
            data.add((estimate, route_edge, extra))
            data.add((extra, OWL.differentFrom, route))
        elif name == "receipt-as-route":
            data.set((estimate, route_edge, receipt))
        elif name == "fees-complete":
            data.set(
                (
                    estimate,
                    field("RideEstimate", "feesComplete"),
                    Literal("complete", datatype=XSD.string),
                )
            )
        elif name == "amount-without-currency":
            data.remove((estimate, field("RideEstimate", "currency"), None))
        elif name == "missing-origin-place":
            data.remove((route, edge("RideRouteOriginPlace"), None))
        elif name == "receipt-from-other-read":
            data.set((estimate, evidence, other))
        elif name == "missing-source-identity":
            data.remove((receipt, field("SourceReceipt", "sourceIdentity"), None))
        elif name == "fulfillment-on-read":
            data.set(
                (
                    receipt,
                    field("SourceReceipt", "evidenceLevel"),
                    Literal("live_fulfillment", datatype=XSD.string),
                )
            )
        elif name == "minor-in-didi":
            data.set(
                (
                    estimate,
                    field("RideEstimate", "amountUnit"),
                    Literal("minor", datatype=XSD.string),
                )
            )
        elif name == "missing-estimate-receipt":
            data.remove((estimate, evidence, None))
        elif name == "impossible-unused-class":
            schema = model + Graph()
            bad = cls("ImpossibleAuditRecord")
            schema.add((bad, RDF.type, OWL.Class))
            for t in ("RideEstimate", "SourceReceipt"):
                schema.add((bad, RDFS.subClassOf, cls(t)))
        elif name == "two-titles":
            data.add(
                (
                    estimate,
                    field("RideEstimate", "displayTitle"),
                    Literal("second distinct title", datatype=XSD.string),
                )
            )
        yield name, schema, data, estimate
