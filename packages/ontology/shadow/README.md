# DiDi candidate release shadow check

An operator runs this reader on the host with the business SQLite database. It observes committed `published` events for `eigos.business`, including publications made before it started, and reads the immutable release named by each event. It verifies the canonical document digest before processing. Draft edits, bootstrap records and activation alone do not trigger it. Publication, activation and request serving have no dependency on the reader.

Install the repository dependencies, uv and Maven on the checking host. Use Maven's default local repository. From the source checkout run:

```sh
npm ci
mvn -q -f packages/ontology/shadow/pom.xml org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath
npm run ontology:shadow -- --db /path/to/business.sqlite --out /private/ontology-reports --watch
```

Omit `--watch` for a batch. Use one process per report directory. Watch scans new publication events every ten seconds. A restart replays the event log and skips reports already present for the release and suite digests. After fixing a checker dependency, run a batch with `--retry` to replace reports atomically. Restrict the report directory and database access to the operator. Install uv dependencies before starting the reader on an offline host. The checker verifies resolved JAR hashes and pins Python packages with the script lockfile.

Open the JSON file printed by the command. It identifies the exact release, model digest, draft and suite. PASS means the 15 synthetic cases met their expected OWL and shared/producer SHACL outcomes, and the candidate retained the DiDi read bindings and function references. FAIL is a known regression. Disagreement, errors, missing tools and timeout produce UNKNOWN. No result alters release state. The independent workflow runs the actual engines against a real publication in a temporary store.

The projection covers RideEstimate, RideRoute, SourceReceipt, their field constraints, interface ancestry and adjacent link definitions. The fixed fixture contains synthetic source observations. Enumerations and supported scalar constraints are mapped explicitly; nested JSON is opaque. HermiT and JFact compare model consistency, unsatisfiable named classes and expected MonetaryFact membership. Both engines use the same serialized graph. SHACL receives the asserted facts and named subclass hierarchy. Function and Action checks inspect registered metadata only. The report makes no claim about other domains, live permissions, authorization to book, or an end-to-end SQL budget.
