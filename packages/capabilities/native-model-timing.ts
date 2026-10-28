import { z } from 'zod';

const markerNames = ['mcpReady', 'runStarted', 'spawnRequested', 'spawned', 'threadStarted', 'turnStarted', 'firstOutput', 'lastOutput', 'finalOutput', 'turnCompleted', 'processExited', 'outputParsed'] as const;
type Marker = typeof markerNames[number];
const toolNames = ['read_task_context', 'read_task_instructions', 'describe_ontology', 'discover_actions', 'query_ontology', 'evaluate_ontology', 'assess_conditions', 'propose_action', 'submit_decision', 'other'] as const;
type Tool = typeof toolNames[number];
const outcomes = ['running', 'succeeded', 'failed', 'spawn_failed', 'process_failed', 'timed_out', 'interrupted', 'output_limit', 'invalid_result'] as const;
export type NativeModelOutcome = Exclude<typeof outcomes[number], 'running'>;
const stages = ['local_preparation', 'cli_or_mcp_startup', 'tool_call', 'model_response', 'process_exit', 'output_validation', 'completed'] as const;
const elapsed = z.number().finite().nonnegative();
const MAX_TRACE_SPANS = 96;
const spanSchema = z.object({
  kind: z.enum(['initialize', 'tools_list', 'tool_request', 'client_tool', 'server_tool']), tool: z.enum(toolNames).optional(),
  startedMs: elapsed.optional(), completedMs: elapsed.optional(), durationMs: elapsed.optional(),
  status: z.enum(['pending', 'completed', 'failed', 'interrupted']), httpStatus: z.number().int().min(100).max(599).optional(),
}).strict();
type Span = z.infer<typeof spanSchema>;
const durationNames = ['mcpSetupMs', 'localPreparationMs', 'processSpawnMs', 'cliToThreadMs', 'cliToTurnMs', 'cliBeforeMcpRequestMs', 'mcpInitializeMs', 'mcpToolsListMs', 'mcpHandshakeMs', 'mcpReadyToTurnMs', 'turnToFirstToolMs', 'clientToolObservedMs', 'mcpToolRequestObservedMs', 'serverToolObservedMs', 'turnOutsideToolsMs', 'turnToFirstOutputMs', 'turnToFinalOutputMs', 'turnMs', 'afterTurnMs', 'outputReadMs'] as const;
export const nativeModelTimingSchema = z.object({
  version: z.literal('native-model-client-timing-v1'), clock: z.literal('monotonic'), originAt: z.string().datetime(),
  outputBoundary: z.literal('completed_message'),
  totalMs: elapsed, outcome: z.enum(outcomes), stage: z.enum(stages),
  promptBytes: z.number().int().nonnegative().optional(),
  toolCatalogReadyBeforeTurn: z.boolean().nullable(),
  markers: z.object(Object.fromEntries(markerNames.map(name => [name, elapsed.optional()])) as Record<Marker, z.ZodOptional<typeof elapsed>>).strict(),
  durations: z.object(Object.fromEntries(durationNames.map(name => [name, elapsed.nullable()])) as Record<typeof durationNames[number], z.ZodNullable<typeof elapsed>>).strict(),
  spans: z.array(spanSchema).max(MAX_TRACE_SPANS), omittedSpans: z.number().int().nonnegative(),
}).strict();
export type NativeModelTiming = z.infer<typeof nativeModelTimingSchema>;

/** One process-local monotonic clock covers server setup, CLI and MCP requests.
 * Intervals may overlap. Time outside tools includes model/transport scheduling,
 * not a measurement of provider inference. No caller text or IDs are retained. */
export class NativeModelTrace {
  private readonly origin: number;
  private readonly originAt: string;
  private readonly markers: Partial<Record<Marker, number>> = {};
  private readonly spans: Span[] = [];
  private readonly clientCalls = new Map<string, number>();
  private omittedSpans = 0;
  private promptBytes?: number;
  private finished?: { at: number; outcome: NativeModelOutcome; stage: NativeModelTiming['stage'] };
  constructor(private readonly now: () => number = () => performance.now(), at = new Date().toISOString()) { this.origin = now(); this.originAt = at; }
  private elapsed() { return Math.max(0, this.now() - this.origin); }
  inputBytes(bytes: number) { if (!this.finished && Number.isSafeInteger(bytes) && bytes >= 0) this.promptBytes = bytes; }
  mark(name: Marker, ...others: Marker[]) {
    if (this.finished) return;
    const at = this.elapsed();
    for (const marker of [name, ...others]) if (this.markers[marker] === undefined || marker === 'lastOutput') this.markers[marker] = at;
  }
  start(kind: Span['kind'], tool?: string): number | undefined {
    if (this.finished) return;
    if (this.spans.length >= MAX_TRACE_SPANS) { this.omittedSpans++; return; }
    this.spans.push({ kind, ...(tool === undefined ? {} : { tool: toolNames.includes(tool as Tool) ? tool as Tool : 'other' }), startedMs: this.elapsed(), status: 'pending' });
    return this.spans.length - 1;
  }
  end(index: number | undefined, status: Exclude<Span['status'], 'pending'>, httpStatus?: number) {
    if (this.finished || index === undefined) return;
    const span = this.spans[index]; if (!span || span.completedMs !== undefined) return;
    span.completedMs = this.elapsed(); span.status = status;
    if (span.startedMs !== undefined) span.durationMs = Math.max(0, span.completedMs - span.startedMs);
    if (httpStatus !== undefined && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) span.httpStatus = httpStatus;
  }
  clientToolStarted(id: string, tool: string) {
    if (this.clientCalls.has(id)) return;
    const index = this.start('client_tool', tool); if (index !== undefined) this.clientCalls.set(id, index);
  }
  clientToolCompleted(id: string, tool: string, failed: boolean) {
    let index = this.clientCalls.get(id);
    if (index === undefined && !this.finished && this.spans.length < MAX_TRACE_SPANS) {
      this.spans.push({ kind: 'client_tool', tool: toolNames.includes(tool as Tool) ? tool as Tool : 'other', status: 'pending' });
      index = this.spans.length - 1; this.clientCalls.set(id, index);
    }
    if (index === undefined && !this.finished) this.omittedSpans++;
    this.end(index, failed ? 'failed' : 'completed');
  }
  private stage(): NativeModelTiming['stage'] {
    return this.markers.spawnRequested === undefined ? 'local_preparation' : this.markers.turnStarted === undefined ? 'cli_or_mcp_startup'
      : this.spans.some(span => span.kind === 'client_tool' && span.status === 'pending') ? 'tool_call'
      : this.markers.turnCompleted === undefined ? 'model_response' : this.markers.processExited === undefined ? 'process_exit' : 'output_validation';
  }
  finish(outcome: NativeModelOutcome): NativeModelTiming {
    if (!this.finished) {
      const stage = outcome === 'succeeded' ? 'completed' : this.stage();
      this.finished = { at: this.elapsed(), outcome, stage };
    }
    return this.snapshot();
  }
  snapshot(): NativeModelTiming {
    const end = this.finished?.at ?? this.elapsed(), m = this.markers;
    const difference = (from: number | undefined, to: number | undefined) => from === undefined || to === undefined || to < from ? null : to - from;
    const first = (kind: Span['kind']) => this.spans.find(span => span.kind === kind && span.status === 'completed' && span.httpStatus === 200) ?? this.spans.find(span => span.kind === kind);
    const initialize = first('initialize'), list = first('tools_list'), tool = this.spans.find(span => span.kind === 'client_tool' && span.startedMs !== undefined);
    const ready = list?.status === 'completed' && list.httpStatus === 200;
    const union = (kind: Span['kind'], start = 0, until = end) => {
      const intervals = this.spans.filter(span => span.kind === kind && span.startedMs !== undefined)
        .map(span => [Math.max(start, span.startedMs!), Math.min(until, span.completedMs ?? end)])
        .filter(([a, b]) => b! >= a!).sort((a, b) => a[0]! - b[0]!);
      let total = 0, last = start;
      for (const [a, b] of intervals) { total += Math.max(0, b! - Math.max(last, a!)); last = Math.max(last, b!); }
      return total;
    };
    const turnMs = difference(m.turnStarted, m.turnCompleted);
    return {
      version: 'native-model-client-timing-v1', clock: 'monotonic', originAt: this.originAt, totalMs: end,
      outputBoundary: 'completed_message',
      outcome: this.finished?.outcome ?? 'running', stage: this.finished?.stage ?? this.stage(), markers: { ...m },
      ...(this.promptBytes === undefined ? {} : { promptBytes: this.promptBytes }),
      toolCatalogReadyBeforeTurn: list?.completedMs === undefined || m.turnStarted === undefined ? null : ready && list.completedMs <= m.turnStarted,
      durations: {
        mcpSetupMs: m.mcpReady ?? null, localPreparationMs: difference(m.runStarted, m.spawnRequested), processSpawnMs: difference(m.spawnRequested, m.spawned),
        cliToThreadMs: difference(m.spawnRequested, m.threadStarted), cliToTurnMs: difference(m.spawnRequested, m.turnStarted),
        cliBeforeMcpRequestMs: difference(m.spawnRequested, initialize?.startedMs),
        mcpInitializeMs: initialize?.durationMs ?? null, mcpToolsListMs: list?.durationMs ?? null, mcpHandshakeMs: difference(initialize?.startedMs, list?.completedMs),
        mcpReadyToTurnMs: ready ? difference(list?.completedMs, m.turnStarted) : null,
        turnToFirstToolMs: difference(m.turnStarted, tool?.startedMs), clientToolObservedMs: union('client_tool'), mcpToolRequestObservedMs: union('tool_request'), serverToolObservedMs: union('server_tool'),
        turnOutsideToolsMs: turnMs === null ? null : Math.max(0, turnMs - union('client_tool', m.turnStarted!, m.turnCompleted!)),
        turnToFirstOutputMs: difference(m.turnStarted, m.firstOutput), turnToFinalOutputMs: difference(m.turnStarted, m.finalOutput), turnMs, afterTurnMs: difference(m.turnCompleted, m.processExited), outputReadMs: difference(m.processExited, m.outputParsed),
      },
      spans: this.spans.map(span => ({ ...span })), omittedSpans: this.omittedSpans,
    };
  }
}
