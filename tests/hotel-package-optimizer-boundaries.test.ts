import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../packages/core/delegation.js';
import { createSyntheticPackageStudy, type StudyFixture } from '../packages/ontology/hotel-package-optimization/synthetic.js';
import { optimizeSyntheticHotelPackages as optimize } from '../packages/ontology/hotel-package-optimization/search.js';
import { verifySyntheticHotelPackagePlan as verify } from '../packages/ontology/hotel-package-optimization/verify.js';
import { packageDemoFixture } from '../packages/ontology/hotel-package-optimization/demo.js';

test('overlapping prerequisite dates retain every threshold regardless of rule order and quantity basis', () => {
  const dates = ['2030-01-10', '2030-01-11', '2030-01-12'];
  for (const [first, second] of [[2, 1], [1, 3], [3, 2]] as const) for (const basis of ['per_plan', 'per_unit'] as const)
    for (const anchor of ['same_date', 'any'] as const) for (const reverse of [false, true]) {
      const prerequisites = [{ sku: 'voucher', quantity: first, basis, anchor, dayOffset: 0 }, { sku: 'voucher', quantity: second, basis, anchor, dayOffset: 1 }];
      if (reverse) prerequisites.reverse();
      const fixture: StudyFixture = { environment: 'synthetic', id: `overlap-${first}-${second}-${basis}-${anchor}-${reverse}`,
        entitlements: [{ code: 'unused-breakfast' }], skus: [
          { id: 'room', maxUnits: 2, components: [{ kind: 'stay', rooms: 1, nights: 1, conditionsKnown: true }], prerequisites },
          { id: 'voucher', category: 'benefit', maxUnits: 10, components: [{ kind: 'benefit', quantity: 1, repeat: 'per_package', dayOffset: 0, optional: false, conditionsKnown: true, entitlement: 'unused-breakfast' }] },
        ], pools: [{ id: 'room-sale', kind: 'sale', capacity: 2, skus: ['room'] }, { id: 'voucher-sale', kind: 'sale', capacity: 10, skus: ['voucher'] },
          ...dates.slice(0, 2).map((date, n) => ({ id: 'night-' + n, kind: 'room' as const, capacity: 1, date }))],
        quotes: [...dates.slice(0, 2).map((anchorDate, n) => ({ id: 'room-' + n, sku: 'room', anchorDate, amountMinor: '10000', resources: [{ pool: 'room-sale' }, { pool: 'night-' + n }] })),
          ...dates.map((anchorDate, n) => ({ id: 'voucher-' + n, sku: 'voucher', anchorDate, amountMinor: '1000', resources: [{ pool: 'voucher-sale' }] }))],
        request: { checkIn: dates[0]!, checkOut: dates[2]! } };
      // Independent possession-count oracle: overlapping requirements reuse
      // holdings, but may not discard the larger threshold.
      const holdings = anchor === 'any' ? Math.max(first, second) * (basis === 'per_unit' ? 2 : 1) : first + Math.max(first, second) + second;
      const study = createSyntheticPackageStudy(fixture);
      try {
        const result = optimize(study.graph, study.owner, study.request, { maxPlans: 1 });
        assert.equal(result.status, 'optimal');
        assert.equal(result.plans[0]!.totalMinor, String(20000 + holdings * 1000));
        assert.equal(verify(study.graph, study.owner, result).accepted, true);
      } finally { study.close(); }
    }
});

test('independent replay rejects a supplied plan accounting for only one of two mandatory stays', () => {
  const fixture = packageDemoFixture(true); fixture.id = 'replay-two-mandatory-stays';
  const study = createSyntheticPackageStudy(fixture);
  try {
    const result = optimize(study.graph, study.owner, study.request, { maxPlans: 1 });
    const extra = { type: 'PackageComponent', id: fixture.id + ':extra-stay' }, sku = study.refs.get('PackageSkuSpecification:bundle')!, room = study.refs.get('RoomType:king')!;
    study.graph.ingest(study.owner, { objects: [{ ref: extra, properties: { id: extra.id, displayTitle: 'Synthetic second mandatory stay', data: { kind: 'stay', rooms: 1, nights: 1, conditionsKnown: true } } }],
      links: [{ type: 'PackageSkuComponents', from: sku, to: extra }, { type: 'PackageComponentRoomTypes', from: extra, to: room }] }, study.source);
    const fresh = optimize(study.graph, study.owner, study.request, { maxPlans: 1 }), forged = structuredClone(result);
    forged.inputDigest = fresh.inputDigest; forged.status = 'best_known'; forged.search = fresh.search;
    const purchase = forged.plans[0]!.purchases[0]!;
    purchase.components.push(extra); purchase.components.sort((a, b) => JSON.stringify([a.type, a.id]).localeCompare(JSON.stringify([b.type, b.id])));
    const old = purchase.id; purchase.id = digest({ quote: purchase.quote, roomIndex: purchase.roomIndex, components: purchase.components });
    forged.plans[0]!.id = digest([purchase.id]);
    for (const step of forged.plans[0]!.path) {
      step.id = step.id.replace(old.slice(0, 20), purchase.id.slice(0, 20));
      step.dependsOn = step.dependsOn.map(id => id.replace(old.slice(0, 20), purchase.id.slice(0, 20)));
    }
    assert.deepEqual(verify(study.graph, study.owner, forged).reasons, ['multi_room_unit_not_supported']);
    assert.equal(fresh.plans[0]!.totalMinor, '77900');
  } finally { study.close(); }
});
