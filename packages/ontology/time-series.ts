import { z } from 'zod';

export const timeSeriesFormat = 'eigos-timeseries';
export const maxTimeSeriesPoints = 10_000;
export const timeSeriesJsonSchema = {
  type: 'array', format: timeSeriesFormat, maxItems: maxTimeSeriesPoints,
  items: {
    type: 'object', properties: { t: { type: 'string', format: 'date-time' }, v: { type: 'number' } },
    required: ['t', 'v'], additionalProperties: false,
  },
};
export const timeSeriesSchema = z.array(z.strictObject({ t: z.iso.datetime({ offset: true }), v: z.number() }))
  .max(maxTimeSeriesPoints).superRefine((points, context) => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const [index, point] of points.entries()) {
      const time = Date.parse(point.t);
      if (!Number.isFinite(time) || time <= previous) {
        context.addIssue({ code: 'custom', path: [index, 't'], message: 'Time series timestamps must increase' });
        return;
      }
      previous = time;
    }
  });
export type TimeSeries = z.infer<typeof timeSeriesSchema>;
export type TimeSeriesAggregate = 'sum' | 'avg' | 'min' | 'max';
type Field = { path: (string | '*')[] };

/** Resolve the time series markers used for stored properties and structured model arguments or results. */
export function timeSeriesFields(schema: unknown, path: Field['path'] = []): Field[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const { type, format, properties, items } = schema as Record<string, unknown>;
  if (format === timeSeriesFormat) {
    if (type !== 'array') throw new Error('Time series format requires array type');
    return [{ path }];
  }
  if (properties && typeof properties === 'object' && !Array.isArray(properties))
    return Object.entries(properties).flatMap(([key, child]) => timeSeriesFields(child, [...path, key]));
  if (type === 'array' && items) return timeSeriesFields(items, [...path, '*']);
  return [];
}

export function validateTimeSeriesFields(fields: Field[], data: unknown, context: z.RefinementCtx) {
  function validate(value: unknown, selectors: Field['path'], path: (string | number)[]) {
    if (value === undefined || value === null) return;
    const [key, ...rest] = selectors;
    if (key === undefined) {
      const parsed = timeSeriesSchema.safeParse(value);
      if (!parsed.success) for (const issue of parsed.error.issues)
        context.addIssue({ code: 'custom', message: issue.message, path: [...path, ...issue.path] });
    } else if (key === '*') {
      if (Array.isArray(value)) value.forEach((item, index) => validate(item, rest, [...path, index]));
    } else if (typeof value === 'object') validate((value as Record<string, unknown>)[key], rest, [...path, key]);
  }
  for (const { path } of fields) validate(data, path, []);
}

/** Compute successive windows in a linear scan. Each output is timestamped at the last point of the window. */
export function timeSeriesWindows(points: TimeSeries, options: { size: number; step: number }, aggregate: TimeSeriesAggregate): TimeSeries {
  const { size, step } = options;
  const result: TimeSeries = [];
  const extrema = aggregate === 'min' || aggregate === 'max';
  const queue: number[] = [];
  let head = 0, sum = 0;
  for (const [index, point] of points.entries()) {
    if (extrema) {
      while (head < queue.length && queue[head]! <= index - size) head++;
      while (queue.length > head) {
        const previous = points[queue.at(-1)!]!.v;
        if (aggregate === 'min' ? previous < point.v : previous > point.v) break;
        queue.pop();
      }
      queue.push(index);
    } else {
      sum += point.v;
      if (index >= size) sum -= points[index - size]!.v;
    }
    const first = index - size + 1;
    if (first < 0 || first % step) continue;
    const value = extrema ? points[queue[head]!]!.v : aggregate === 'avg' ? sum / size : sum;
    if (!Number.isFinite(value)) throw new Error('Time series window exceeds numeric precision');
    result.push({ t: point.t, v: value });
  }
  return result;
}
