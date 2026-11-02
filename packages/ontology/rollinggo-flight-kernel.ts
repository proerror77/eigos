export const FLIGHT_PREDECESSOR = '78e73e56caaed8c894b716a0ed486dd98442beed1234a7c29e557821ba2f4020';
import { z } from 'zod';
import {
  rollingGoFlightObjects,
  rollingGoFlightLinks,
  rollingGoFlightActions,
  rollingGoFlightFunctions,
} from './rollinggo-flight.js';
import { composable } from './composition-kernel.js';
import { executionReferenceLinks } from './execution-model.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
export function extendRollingGoFlightKernel(
  original: OntologyDocument,
  registry: TrustedDefinitionRegistry,
): OntologyDocument {
  const d = structuredClone(original);
  d.version = '27';
  for (const type of rollingGoFlightObjects)
    d.objects.push({
      ...type,
      resourceId: `builtin:eigos.business:object:${type.id}`,
      writePolicy: 'source',
      properties: Object.fromEntries(
        Object.entries(type.properties).map(([name, p]) => {
          const { schema: validator, ...meta } = p,
            schema = z.toJSONSchema(validator);
          return [
            name,
            {
              ...meta,
              schema,
              validatorRef: registry.registerValidator(
                `eigos.business:object:${type.id}:${name}`,
                'rollinggo-flight-v27',
                validator,
                schema,
              ),
            },
          ];
        }),
      ),
    });
  const links = [...rollingGoFlightLinks];
  const evidence = new Set(
    d.objects
      .filter((t) => t.interfaces?.some((i) => i.id === 'EvidenceBacked'))
      .map((t) => t.id),
  );
  for (const value of rollingGoFlightActions) {
    const action = composable(value, evidence);
    d.actions.push({
      ...action,
      resourceId: `builtin:eigos.business:action:${action.id}`,
      implementation: {
        kind: 'trusted',
        handlerRef: registry.registerAction(action),
      },
    });
  }
  for (const fn of rollingGoFlightFunctions)
    d.functions.push({ ...fn, handlerRef: registry.registerFunction(fn) });
  const known = new Set(d.links.map((l) => l.id));
  for (const l of [
    ...links,
    ...executionReferenceLinks(d.objects, d.actions, d.interfaces),
  ])
    if (!known.has(l.id)) {
      d.links.push({
        ...l,
        resourceId: `builtin:eigos.business:link:${l.id}`,
        writePolicy: 'source',
      });
      known.add(l.id);
    }
  return d;
}
