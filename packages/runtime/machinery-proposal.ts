import type { z } from 'zod';
import { Conflict, digest, NotFound, PermissionDenied } from '../core/identity.js';
import type { MachineryModel } from '../ontology/process-definition.js';
import type { Access, Requirement } from './access.js';
import type { Database } from './database.js';
import { analyzeMachinery, machineryAnalysisSchema } from './machinery-analysis.js';
import type { PublishedOntology } from './metadata.js';

type Query = z.output<typeof machineryAnalysisSchema>;
type Report = Awaited<ReturnType<typeof analyzeMachinery>>;

function summarize(report: Report, proposed: MachineryModel) {
  const reference = report.reference?.transitions ?? [];
  const proposedEdges = proposed.transitions;
  const keys = new Set([...reference, ...proposedEdges].map(edge => JSON.stringify([edge.from, edge.to])));
  const affected = [...keys].flatMap(key => {
    const [from, to] = JSON.parse(key) as [string | null, string | null];
    const matches = (edge: { from: string | null; to: string | null }) => edge.from === from && edge.to === to;
    if (digest(reference.filter(matches)) === digest(proposedEdges.filter(matches))) return [];
    return [{ from, to, observedCases: report.transitions.find(matches)?.cases ?? 0 }];
  });
  return { cases: report.casesTotal, deviationCases: report.conformance.deviation,
    candidateDeviationCases: report.comparison!.candidate.deviation,
    bottlenecks: report.findings.bottlenecks.map(({ state, completedP95Ms }) => ({ state, completedP95Ms })),
    affectedEdges: affected };
}
export type ProposalEvidence = {
  release: string; process: string; modelDigest: string; owner: string; contributors: string[]; query: Query;
  visibility: string; requirements: Requirement[]; summary: ReturnType<typeof summarize>;
};

export async function analyzeProposal(db: Database, access: Access, model: PublishedOntology, query: Query,
  type: string, proposed: MachineryModel): Promise<ProposalEvidence> {
  if (query.type !== type || query.reference || query.candidate)
    throw new Conflict('Use the selected process and its published reference for proposal evidence');
  const report = await analyzeMachinery(db,access,model,{ ...query, candidate: proposed });
  const requirements = await access.finalDataRequirements();
  if (!await access.canReturn(requirements)) throw new PermissionDenied('Machinery evidence permissions changed');
  return { release: model.release, process:type, owner:access.principal.owner, contributors:[access.principal.owner], modelDigest:digest(proposed),
    query:{ ...query, from:report.from, to:report.to }, visibility:access.visibilityDigest,
    requirements,summary:summarize(report,proposed) };
}

export async function visibleProposalEvidence(db: Database, access: Access, model: PublishedOntology, evidence: ProposalEvidence,
  current?: MachineryModel) {
  const { query } = evidence;
  const header = { process:evidence.process, release:evidence.release, from:query.from, to:query.to };
  if (!current || digest(current)!==evidence.modelDigest) return { ...header, scope:'earlier_revision' as const };
  if (access.principal.owner===evidence.owner) {
    if (await access.canReturn(evidence.requirements) && access.visibilityDigest===evidence.visibility)
      return { ...header, scope:'recorded' as const, summary:evidence.summary };
    return { ...header, scope:'restricted' as const };
  }
  // A definition reviewer has their own data authority. Never expose private case selectors, saved sets or source rows.
  if (query.object || query.focus || query.setId || query.externalSource || query.filter) return { ...header, scope:'restricted' as const };
  try {
    const replay = await analyzeProposal(db,access,model,query,evidence.process,current);
    return { ...header, scope:'reviewer' as const, summary:replay.summary };
  } catch (error) {
    if (error instanceof PermissionDenied || error instanceof NotFound) return { ...header, scope:'restricted' as const };
    if (error instanceof Conflict) return { ...header, scope:'unavailable' as const };
    throw error;
  }
}
