"""Map candidate-defined types and their adjacent relationships to OWL and SHACL."""

import json
from urllib.parse import quote
from rdflib import Graph, Namespace, BNode, Literal, RDF, RDFS, OWL, XSD, SH
from rdflib.collection import Collection

FOCUS = ("RideEstimate", "RideRoute", "SourceReceipt")
E = Namespace("https://example.org/eigos-audit/")


def iri(part, *keys):
    return E[part + "/" + "/".join(quote(str(k), safe="") for k in keys)]


def cls(name):
    return iri("type", name)


def field(t, k):
    return iri("field", t, k)


def edge(k):
    return iri("link", k)


def graph():
    g = Graph()
    for k, n in [("e", E), ("owl", OWL), ("sh", SH), ("xsd", XSD)]:
        g.bind(k, n)
    return g


def seq(g, xs):
    n = BNode()
    Collection(g, n, xs)
    return n


def node(g, typ, **values):
    n = BNode()
    g.add((n, RDF.type, typ))
    for k, v in values.items():
        g.add((n, OWL[k], v))
    return n


def shape(g, t):
    s = iri("shape", t)
    g.add((s, RDF.type, SH.NodeShape))
    g.add((s, SH.targetClass, cls(t)))
    return s


def prop(g, s, path):
    n = BNode()
    g.add((s, SH.property, n))
    g.add((n, SH.path, path))
    return n


def count(g, c, p, pred, num):
    g.add(
        (
            c,
            RDFS.subClassOf,
            node(
                g,
                OWL.Restriction,
                onProperty=p,
                **{pred: Literal(num, datatype=XSD.nonNegativeInteger)},
            ),
        )
    )


def inverse_path(g, p):
    b = BNode()
    g.add((b, SH.inversePath, p))
    return b


def project(doc, release_digest, facts):
    objects = {o["id"]: o for o in doc["objects"]}
    parents = {i["id"]: i.get("parents", []) for i in doc["interfaces"]}
    ancestors = {}
    for t, o in objects.items():
        pending = [i["id"] for i in o.get("interfaces", [])]
        known = set()
        while pending:
            i = pending.pop()
            if i not in known:
                known.add(i)
                pending.extend(parents[i])
        ancestors[t] = sorted(known)
    targets = set(FOCUS).union(*(ancestors[t] for t in FOCUS))
    links = [
        l for l in doc["links"] if any(l[k]["type"] in targets for k in ("from", "to"))
    ]
    model, native = graph(), graph()
    model.add((iri("ontology", doc["id"]), RDF.type, OWL.Ontology))
    model.add(
        (iri("ontology", doc["id"]), OWL.versionIRI, iri("release", release_digest))
    )
    focus = {k: objects[k] for k in FOCUS}
    ends = (
        set(focus)
        | {l[k]["type"] for l in links for k in ("from", "to")}
        | {
            str(t).split("/")[-1]
            for t in facts.objects(None, RDF.type)
            if str(t).startswith(str(iri("type")) + "/")
        }
    )
    for t in sorted(ends):
        model.add((cls(t), RDF.type, OWL.Class))
        for interface in ancestors.get(t, []):
            model.add((cls(interface), RDF.type, OWL.Class))
            model.add((cls(t), RDFS.subClassOf, cls(interface)))
    # Record types are exclusive for EIGOS typed references. No real-world sameAs assertion.
    classes = sorted(ends & ancestors.keys())
    model.add(
        (
            node(model, OWL.AllDisjointClasses),
            OWL.members,
            seq(model, [cls(c) for c in classes]),
        )
    )
    dt = {
        "string": XSD.string,
        "decimal": XSD.string,
        "timestamp": XSD.dateTime,
        "integer": XSD.integer,
        "boolean": XSD.boolean,
        "struct": XSD.string,
        "array": XSD.string,
    }
    for key in [
        "primaryKey",
        "sourceResource",
        "interfaceMappings",
        "dataKind",
        "linkSides",
    ]:
        model.add((iri("meta", key), RDF.type, OWL.AnnotationProperty))
    for t, o in focus.items():
        for key, x in [
            ("primaryKey", o["primaryKey"]),
            ("sourceResource", o["resourceId"]),
            ("interfaceMappings", json.dumps(o.get("interfaces", []), sort_keys=True)),
        ]:
            model.add((cls(t), iri("meta", key), Literal(x)))
        s = shape(native, t)
        for k, v in o["properties"].items():
            p = field(t, k)
            datatype = dt[v["kind"]]
            schema = v["schema"]
            model.add((p, RDF.type, OWL.DatatypeProperty))
            model.add((p, RDFS.domain, cls(t)))
            model.add((p, RDFS.range, datatype))
            model.add((p, iri("meta", "dataKind"), Literal(v["kind"])))
            model.add((p, RDF.type, OWL.FunctionalProperty))
            n = prop(native, s, p)
            native.add((n, SH.maxCount, Literal(1)))
            native.add((n, SH.datatype, datatype))
            if v.get("required"):
                count(model, cls(t), p, "minCardinality", 1)
                native.add((n, SH.minCount, Literal(1)))
            vals = schema.get("enum", [schema["const"]] if "const" in schema else [])
            if vals:
                arr = [Literal(x, datatype=datatype) for x in vals]
                ran = BNode()
                model.add((ran, RDF.type, RDFS.Datatype))
                model.add((ran, OWL.oneOf, seq(model, arr)))
                model.add((p, RDFS.range, ran))
                native.add((n, SH["in"], seq(native, arr)))
            for key, con in [
                ("minLength", SH.minLength),
                ("maxLength", SH.maxLength),
                ("minimum", SH.minInclusive),
                ("maximum", SH.maxInclusive),
                ("exclusiveMinimum", SH.minExclusive),
                ("exclusiveMaximum", SH.maxExclusive),
                ("pattern", SH.pattern),
            ]:
                if key in schema and not (
                    v["kind"] == "timestamp" and key == "pattern"
                ):
                    native.add((n, con, Literal(schema[key])))
    for l in links:
        p = edge(l["id"])
        q = iri("inverse", l["id"])
        model.add((p, RDF.type, OWL.ObjectProperty))
        model.add((q, RDF.type, OWL.ObjectProperty))
        model.add((q, OWL.inverseOf, p))
        model.add(
            (
                p,
                iri("meta", "linkSides"),
                Literal(json.dumps([l["from"], l["to"]], sort_keys=True)),
            )
        )
        model.add((p, RDFS.domain, cls(l["from"]["type"])))
        model.add((p, RDFS.range, cls(l["to"]["type"])))
        for direction, side, other, predicate in [
            ("out", l["from"], l["to"], p),
            ("in", l["to"], l["from"], q),
        ]:
            c = cls(side["type"])
            if not side["many"]:
                count(model, c, predicate, "maxCardinality", 1)
            if side.get("required"):
                count(model, c, predicate, "minCardinality", 1)
            for t in focus:
                if side["type"] not in [t] + ancestors.get(t, []):
                    continue
                n = prop(
                    native,
                    shape(native, t),
                    p if direction == "out" else inverse_path(native, p),
                )
                native.add((n, SH["class"], cls(other["type"])))
                if not side["many"]:
                    native.add((n, SH.maxCount, Literal(1)))
                if side.get("required"):
                    native.add((n, SH.minCount, Literal(1)))
    model.add((iri("audit", "receiptSubject"), RDF.type, OWL.ObjectProperty))
    return model, native
