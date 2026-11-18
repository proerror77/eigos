/** Deadline for a phase awaiting committed source evidence. Re-reading the same receipt never renews it. */
export function eventObservation(input: {
  startedAt: Date;
  lastObservedAt: Date | null;
  maxSilenceSeconds: number;
  now: Date;
}): { status: 'waiting' | 'stranded'; reason: string; nextReviewAt: Date } {
  const since = input.startedAt.getTime();
  const now = input.now.getTime();
  const evidenceTime = input.lastObservedAt?.getTime();
  if (evidenceTime !== undefined && (!Number.isFinite(evidenceTime) || evidenceTime > now)) {
    return { status: 'stranded', reason: 'invalid_evidence_time', nextReviewAt: input.now };
  }
  const hasEvidence = evidenceTime !== undefined && evidenceTime >= since;
  const nextReviewAt = new Date((hasEvidence ? evidenceTime : since) + input.maxSilenceSeconds * 1000);
  if (now >= nextReviewAt.getTime()) {
    return { status: 'stranded', reason: hasEvidence ? 'source_silent' : 'no_source_evidence', nextReviewAt };
  }
  return { status: 'waiting', reason: 'awaiting_source_event', nextReviewAt };
}
