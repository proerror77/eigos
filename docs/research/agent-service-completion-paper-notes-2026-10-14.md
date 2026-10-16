# Service-completion verification: three paper readings

Read on 2026-10-14. Scope: verify whether a service fulfilled its agreed purpose; no new payment, custody, clearing, insurance, or settlement layer. Read each v1 HTML main text and appendices in full (reference bibliography excluded); did not reproduce experiments or independently audit implementations. These are author-reported research findings, not evidence of production performance.

## How Agentic Is Agentic Commerce?

[Primary paper](https://arxiv.org/html/2607.12575v1), especially §3 Identification/Supply, §4 Classification/Bounds, §6 Validity, Appendices B–C.

The authors study Base settlements over 2025-09-17–2026-06-23, with a separate, coarser Solana census. Their evidence concerns payment graphs and catalog availability, not completed work. On Base they classify 21.20% of settlements as fictitious and 63.78% as internal to linked clusters. They explicitly do not equate the latter with fake underlying business. Their host probe performs no purchases, so an HTTP 402 response demonstrates neither delivery nor quality.

The paper cannot establish that execution networks do not exist: off-chain requests, supplied resources, private services, and beneficial control remain partly unobservable. Its service-directed revenue “floor” also does not prove successful fulfillment or independent counterparties. Behavioral classifier labels inherit annotator assumptions; headline classifications exclude that classifier. The paper promises data/pipeline release upon publication; this reading did not reproduce its results.

Reusable lesson: count independently verified fulfilled obligations and actual external users; neither payment count, registry size, endpoint count, nor tool-call count establishes those outcomes.

## TessPay

[Primary paper](https://arxiv.org/html/2602.00213v1), especially IV.B–C Architecture/Verification, VII Tiers, VIII Threat Modelling, IX Use Cases, X Future Work.

The Agent Contract defines required proof objects and predicates. PoTE bundles TLSNotary interaction evidence, identity/input-output bindings, and TEE attestations. An oracle quorum supplies off-chain artifact assessments; validators accept evidence. Low-risk transactions may use simple API receipts instead of full witnessing. The work is an architecture with scenario-based security analysis and illustrative shopping/portfolio cases, without reported empirical task-success evaluation.

Trust remains in the external service, predicate design, notaries/oracles, validators, identity infrastructure, and attestation roots. A witnessed HTTPS response proves the response’s provenance, not physical delivery or semantic adequacy. A TEE attestation does not by itself prove the agent understood intent or avoided prompt injection. The paper’s stronger TEE/security language therefore exceeds what those artifacts alone establish. Semantic quality verification is explicitly future work.

Reusable without payments: an agreed task specification, task-bound receipts, external-state evidence, predicate-based verification, and an auditable result. Escrow, TessChain, rail adapters, and payment release are unnecessary for that narrower objective.

## RAILS

[Primary paper](https://arxiv.org/html/2606.08790v1), especially §4–5 Formal Model/Admissibility, §8 Worked Scenarios, §11 Evaluation, §12 Limitations, Appendix A.

RAILS separates obligation, evidence, verifier outputs, and decision. Verifiers declare their evidence basis; a floor excludes weak evidence. Performance and policy verdicts remain separate. Crucially, §5.5 expressly denies guarantees of ground truth, verifier correctness, attestor honesty, or an appropriate floor. §12 also excludes correct interpretation of user intent.

Its evaluation uses 180 synthetic cases across 48 scenarios, plus synthetic conformance and exposure harnesses. Zero floor violations demonstrate gate conformance under assumptions, not zero erroneous real-world completion decisions. Clean/defective twins deliberately share identical self-reports; refusal prevents unsupported approval but does not detect which twin actually succeeded. Production evaluation is future work. The appendix’s schemas are illustrative, not normative.

Reusable: explicit acceptance criteria, provenance, independently supplied receipts, per-criterion decisions, unknown/disputed states, and appeals. Do not import its margin/slashing/settlement scope. Its universal evidence ranking also deserves scrutiny: attested execution can be authentic but irrelevant to the promised external outcome. Authenticity, relevance, coverage, and freshness should remain separate dimensions.

## Synthesis for the requested scope (analysis)

The defensible claim is that paying, issuing a request, and observing a successful operation are different from establishing fulfillment. These papers do not justify saying that no real execution network exists.

A practical service-completion system can connect existing browser automation, APIs, human providers, and operational systems. The distinguishing work is to specify success before execution, obtain outcome evidence from the authoritative system, compare each acceptance criterion, and track deferred outcomes and exceptions.

Examples:

- Booking: accepted booking identifier, correct dates/venue/party, and current confirmed status; a clicked button is only an attempt.
- Purchased goods: order accepted, shipped, delivered, and accepted by the buyer are distinct milestones; delayed payment does not decide which milestone the service promised.
- Software: a commit, passing tests, deployed version, and requested production behavior are different claims requiring different checks.
- Submitted form: local success text is weaker than the receiving system’s persisted record and identifier.

A result should state completed / partially completed / failed / still pending / insufficient evidence, identify the criteria checked, attach the evidence source and observation time, and state what remains unverified. Escalation or human acceptance is legitimate for subjective or physical outcomes. No universal cryptographic proof eliminates that boundary.

The first useful product need not establish a marketplace or financial infrastructure. It can deliver a reliable, independently inspectable fulfillment record for one well-bounded service workflow using existing executors and payment arrangements. This is a product inference, not a demonstrated market conclusion from the papers.
