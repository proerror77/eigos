# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["jdk4py==25.0.2.1", "jpype1==1.7.1", "pyshacl==0.40.2", "rdflib==7.6.0"]
# ///
"""Read one verified release document on stdin. Emit only bounded synthetic evidence."""

import hashlib
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic
import jdk4py
import jpype
import rdflib
from rdflib import Graph, RDF, RDFS, SH, URIRef
from pyshacl import validate
from mapping import cls, project
from cases import EXPECT, inputs

ROOT = Path(__file__).resolve().parent
rdflib.NORMALIZE_LITERALS = False


def engines():
    jars = []
    for file, expected in json.loads((ROOT / "jars.json").read_text()).items():
        path = Path.home() / ".m2/repository" / file
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("Dependency hash mismatch")
        jars.append(str(path))
    jvm = next(
        p
        for p in Path(jdk4py.JAVA_HOME).rglob("*jvm*")
        if p.name in {"libjvm.dylib", "libjvm.so", "jvm.dll"}
    )
    jpype.startJVM(str(jvm), "-Xmx1g", "-XX:ActiveProcessorCount=2", classpath=jars)
    J = jpype.JClass
    return {
        "HermiT": J("org.semanticweb.HermiT.ReasonerFactory")(),
        "JFact": J("uk.ac.manchester.cs.jfact.JFactFactory")(),
    }


def reason(factory, ontology, statement):
    J = jpype.JClass
    config = J("org.semanticweb.owlapi.reasoner.SimpleConfiguration")(
        jpype.JLong(30000)
    )
    start = monotonic()
    reasoner = factory.createReasoner(ontology, config)
    try:
        coherent = bool(reasoner.isConsistent())
        bottom = (
            sorted(
                str(x.getIRI())
                for x in reasoner.getUnsatisfiableClasses().getEntitiesMinusBottom()
            )
            if coherent
            else None
        )
        monetary = (
            bool(reasoner.isEntailed(statement))
            if coherent and statement is not None
            else None
        )
        return {
            "answer": [coherent, bottom, monetary],
            "ms": round((monotonic() - start) * 1000, 1),
        }
    finally:
        reasoner.dispose()


def check(name, schema, data, estimate, shared, producer, factories, path):
    expected, native, didi = EXPECT[name]
    facts = data + Graph()
    for sub, _, sup in schema.triples((None, RDFS.subClassOf, None)):
        if isinstance(sup, URIRef):
            facts.add((sub, RDFS.subClassOf, sup))
    shapes = []
    violations = []
    for shape in (shared, producer):
        if name == "schema-only":
            shapes.append(None)
        else:
            ok, report, _ = validate(
                facts, shacl_graph=shape, inference="none", advanced=True
            )
            if not isinstance(report, Graph):
                raise ValueError("Invalid SHACL report")
            shapes.append(bool(ok))
            for result in report.subjects(RDF.type, SH.ValidationResult):
                violations.append(
                    {
                        "shapeSet": "shared" if shape is shared else "didi",
                        "focus": str(report.value(result, SH.focusNode)),
                        "path": str(report.value(result, SH.resultPath) or ""),
                        "constraint": str(
                            report.value(result, SH.sourceConstraintComponent)
                        ),
                    }
                )
    (schema + data).serialize(destination=path, format="xml")
    J = jpype.JClass
    manager = J(
        "org.semanticweb.owlapi.apibinding.OWLManager"
    ).createOWLOntologyManager()
    ontology = manager.loadOntologyFromOntologyDocument(J("java.io.File")(str(path)))
    if (
        not J("org.semanticweb.owlapi.profiles.OWL2DLProfile")()
        .checkOntology(ontology)
        .isInProfile()
    ):
        return {"case": name, "status": "FAIL", "reason": "outside OWL 2 DL"}
    df = manager.getOWLDataFactory()
    iri = J("org.semanticweb.owlapi.model.IRI").create
    statement = df.getOWLClassAssertionAxiom(
        df.getOWLClass(iri(str(cls("MonetaryFact")))),
        df.getOWLNamedIndividual(iri(str(estimate))),
    )
    observed = {}
    for engine, factory in factories.items():
        try:
            observed[engine] = reason(
                factory, ontology, None if name == "schema-only" else statement
            )
        except Exception as error:
            observed[engine] = {"error": type(error).__name__}
    answers = [r.get("answer") for r in observed.values()]
    bottom = (
        [str(cls("ImpossibleAuditRecord"))] if name == "impossible-unused-class" else []
    )
    oracle = [
        expected,
        bottom if expected else None,
        True if expected and name != "schema-only" else None,
    ]
    if None in answers or answers[0] != answers[1]:
        status = "UNKNOWN"
    elif answers[0] != oracle or shapes != [native, didi]:
        status = "FAIL"
    else:
        status = "PASS"
    return {
        "case": name,
        "status": status,
        "engines": observed,
        "expectedOWL": oracle,
        "shacl": shapes,
        "violations": violations[:20],
        "violationCount": len(violations),
        "expectedSHACL": [native, didi],
    }


def check_bindings(document):
    """Names here are regression oracles for the supported read-only workflow."""
    actions = {a["id"]: a for a in document["actions"]}
    functions = {f["id"]: f for f in document["functions"]}
    checks = {}
    for name, input_types in (
        ("rideEstimateStatus", {"DidiPlaceObservation", "RideEstimateObservation"}),
        ("selectDidiPlace", {"DidiPlaceObservation"}),
    ):
        definition = functions.get(name, {})
        handler = definition.get("handlerRef", {})
        checks[name] = bool(
            handler.get("digest")
            and handler.get("version")
            and input_types <= set(definition.get("inputTypes", []))
        )
    for name, tool, output in (
        ("SearchDidiPlaces", "maps_textsearch", "DidiPlaceObservation"),
        ("EstimateDidiRide", "taxi_estimate", "RideEstimateObservation"),
    ):
        action = actions.get(name, {})
        read = action.get("read", {})
        binding = read.get("mcp", {})
        checks[name] = (
            read.get("effect") == "read"
            and not action.get("operation")
            and binding.get("server") == "didi"
            and binding.get("tool") == tool
            and read.get("resultType") == output
        )
    dependencies = (
        actions.get("EstimateDidiRide", {})
        .get("read", {})
        .get("mcp", {})
        .get("requires", [])
    )
    checks["estimateEndpoints"] = {
        d.get("role")
        for d in dependencies
        if d.get("action") == "SearchDidiPlaces"
        and d.get("objectType") == "DidiPlaceObservation"
        and d.get("evaluate") == "rideEstimateStatus"
        and d.get("derive", {}).get("function") == "selectDidiPlace"
    } == {"origin", "destination"}
    return checks


def main():
    request = json.load(sys.stdin)
    data = Graph().parse(ROOT / "fixtures/didi.ttl")
    producer = Graph().parse(ROOT / "fixtures/didi-shapes.ttl")
    model, shared = project(request["document"], request["digest"], data)
    factories = engines()
    with TemporaryDirectory() as tmp:
        rows = [
            check(
                name,
                schema,
                facts,
                estimate,
                shared,
                producer,
                factories,
                Path(tmp) / "case.rdf",
            )
            for name, schema, facts, estimate in inputs(model, data)
        ]
    bindings = check_bindings(request["document"])
    statuses = {r["status"] for r in rows}
    if not all(bindings.values()):
        statuses.add("FAIL")
    print(
        json.dumps(
            {
                "status": "UNKNOWN"
                if "UNKNOWN" in statuses
                else "FAIL"
                if "FAIL" in statuses
                else "PASS",
                "cases": rows,
                "bindings": bindings,
            }
        )
    )


if __name__ == "__main__":
    main()
