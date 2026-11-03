import { pathToFileURL } from 'node:url';
import { createSyntheticPackagePipeline } from './pipeline.js';
import { syntheticPackageFeed } from './pipeline-fixture.js';

export function runPackagePipelineDemo() {
  return (['dinner', 'breakfast', 'qualification'] as const).map(scenario => {
    const study = createSyntheticPackagePipeline(syntheticPackageFeed(scenario));
    try {
      const result = study.optimize(), verification = study.verify(result);
      if (!verification.accepted) throw new Error('Independent pipeline proposal replay failed: ' + verification.reasons.join(', '));
      const native = new Map(study.imported.map(item => [JSON.stringify(item.object), item.nativeId]));
      return { scenario, ...study.mappingSummary, status: result.status, totalMinor: result.plans[0]?.totalMinor, currency: 'CNY',
        skus: result.plans[0]?.purchases.map(p => native.get(JSON.stringify(p.sku))),
        alternatives: result.plans.map(plan => ({ totalMinor: plan.totalMinor, skus: plan.purchases.map(p => native.get(JSON.stringify(p.sku))) })),
        path: result.plans[0]?.path.map(step => ({ ...step, nativeSku: native.get(JSON.stringify(step.sku)) })), verification,
        bookable: result.bookable, executed: result.executed };
    } finally { study.close(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(runPackagePipelineDemo(), null, 2));
