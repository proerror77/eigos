import { z } from 'zod';

export const sensitivitySchema = z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
export const sensitivityRank = { PUBLIC: 10, INTERNAL: 20, CONFIDENTIAL: 30, RESTRICTED: 40 } as const;
const compartment = z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);
export const classificationSchema = z.strictObject({
  sensitivity: sensitivitySchema,
  compartments: z.array(compartment).max(100).default([]),
});
export type Classification = z.output<typeof classificationSchema>;
export const internalClassification: Classification = { sensitivity: 'INTERNAL', compartments: [] };

export function combineClassification(...labels: (Classification | undefined)[]): Classification {
  let sensitivity: Classification['sensitivity'] = 'PUBLIC';
  const compartments = new Set<string>();
  for (const label of labels) {
    if (!label) continue;
    if (sensitivityRank[label.sensitivity] > sensitivityRank[sensitivity]) sensitivity = label.sensitivity;
    for (const tag of label.compartments) compartments.add(tag);
  }
  return { sensitivity, compartments: [...compartments].sort() };
}

export function marksClassification(markings: string[]): Classification {
  return combineClassification(...markings.map((mark): Classification => {
    const named = sensitivitySchema.safeParse(mark);
    return named.success ? { sensitivity: named.data, compartments: [] } : { sensitivity: 'PUBLIC', compartments: [mark] };
  }));
}

export function isProtected(label: Classification): boolean {
  return sensitivityRank[label.sensitivity] > sensitivityRank.INTERNAL || label.compartments.length > 0;
}

export function allowsClassification(clearance: Classification, required: Classification): boolean {
  return sensitivityRank[required.sensitivity] <= sensitivityRank[clearance.sensitivity]
    && required.compartments.every(tag => clearance.compartments.includes(tag));
}
