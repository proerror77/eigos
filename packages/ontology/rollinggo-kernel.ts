import { z } from 'zod';
import {
  rollingGoObjects,
  rollingGoLinks,
  rollingGoActions,
  rollingGoFunctions,
} from './rollinggo.js';
import { composable } from './composition-kernel.js';
import { executionReferenceLinks } from './execution-model.js';
import type { OntologyDocument } from './definition-contracts.js';
import type { TrustedDefinitionRegistry } from './model-compiler.js';
export function extendRollingGoKernel(
  original: OntologyDocument,
  registry: TrustedDefinitionRegistry,
): OntologyDocument {
  const d = structuredClone(original);
  d.version = '23';
  for (const type of rollingGoObjects)
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
                'rollinggo-v23',
                validator,
                schema,
              ),
            },
          ];
        }),
      ),
    });
  const links = [...rollingGoLinks];
  const evidence = new Set(
    d.objects
      .filter((t) => t.interfaces?.some((i) => i.id === 'EvidenceBacked'))
      .map((t) => t.id),
  );
  for (const value of rollingGoActions) {
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
  for (const fn of rollingGoFunctions)
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
