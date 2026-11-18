import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, digest, NotFound, PermissionDenied, requireScope } from '../core/identity.js';
import { ontologyName, objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import { validator } from '../ontology/model.js';
import { Access, type Requirement } from './access.js';
import type { Database, Sql } from './database.js';
import { Metadata, type PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';
import { eventObservation } from './event-observation.js';
import { readProcessTransitions } from './process-logs.js';
import { processTarget, visibleTransition } from './process-automation.js';
import { ScheduledActions } from './scheduled-actions.js';
import type { Task } from './tasks.js';
import { checkWorkflowDependencies } from './workflow-compatibility.js';

const labels = z.array(z.string().min(1).max(80)).max(32);
const completion = z.strictObject({
  process: ontologyName,
  evidenceProperty: ontologyName.optional(),
  complete: labels,
  stop: labels.default([]),
});
const phaseSchema = completion.extend({
  name: z.string().min(1).max(120),
  action: ontologyName.optional(),
  wait: z
    .strictObject({
      maxSilenceSeconds: z
        .number()
        .int()
        .min(1)
        .max(31 * 86400),
    })
    .optional(),
  parameters: z.record(ontologyName, z.unknown()).default({}),
  maxSilenceSeconds: z
    .number()
    .int()
    .min(1)
    .max(31 * 86400)
    .optional(),
  intervalSeconds: z.number().int().min(30).max(86400).default(300),
  attach: completion.extend({ link: ontologyName }).optional(),
});
export const startInterestSchema = z.strictObject({
  requestId: z.string().trim().min(1).max(128),
  object: objectRefSchema,
  deadline: z.iso.datetime({ offset: true }),
  phases: z.array(phaseSchema).min(1).max(8),
});
export const listInterestsSchema = z.strictObject({ object: objectRefSchema.optional(), cursor: z.uuid().optional() });
export const cancelInterestSchema = z.strictObject({ id: z.uuid() });
type Plan = z.output<typeof startInterestSchema>;
type Phase = z.output<typeof phaseSchema>;
type Row = {
  id: string;
  owner: string;
  ontology: string;
  release: string;
  plan: Plan;
  scopes: string[];
  digest: string;
  phase: number;
  state: 'watching' | 'completed' | 'canceled' | 'expired' | 'blocked' | 'stranded';
  reason: string | null;
  schedule_id: string | null;
  schedule_owned: boolean;
  attached: ObjectRef | null;
  attached_schedule: string | null;
  attempt: number;
  next_scan: Date;
  phase_started_at: Date;
  last_sequence: string | null;
  evidence_requirements: Requirement[];
  evidence_markings: string[];
  last_observed_at: Date | null;
  last_state: string | null;
  deadline: Date;
};
export async function initializeObservationInterests(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.observation_interests(
    id uuid PRIMARY KEY,owner text NOT NULL,ontology text NOT NULL,release text NOT NULL REFERENCES ${db.schema}.releases(digest),
    request_id text NOT NULL,digest text NOT NULL,plan jsonb NOT NULL,scopes jsonb NOT NULL,phase integer NOT NULL DEFAULT 0,
    state text NOT NULL DEFAULT 'watching',reason text,schedule_id text,schedule_owned boolean NOT NULL DEFAULT false,
    attached jsonb,attached_schedule text,attempt integer NOT NULL DEFAULT 0,next_scan timestamptz NOT NULL DEFAULT now(),
    phase_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_sequence bigint,
    evidence_requirements jsonb NOT NULL DEFAULT '[]',evidence_markings jsonb NOT NULL DEFAULT '[]',last_observed_at timestamptz,last_state text,deadline timestamptz NOT NULL,UNIQUE(owner,request_id));
    CREATE INDEX IF NOT EXISTS observation_interests_due ON ${db.schema}.observation_interests(next_scan,id) WHERE state='watching';
    CREATE INDEX IF NOT EXISTS observation_interests_object ON ${db.schema}.observation_interests(owner,ontology,((plan->'object')::text));
    CREATE INDEX IF NOT EXISTS observation_interests_check ON ${db.schema}.observation_interests(owner,schedule_id);`);
}

export class ObservationInterests {
  private readonly schedules: ScheduledActions;
  constructor(
    private readonly db: Database,
    private readonly metadata = new Metadata(db),
  ) {
    this.schedules = new ScheduledActions(db, metadata);
  }
  private async validate(graph: Objects, plan: Plan, release?: string) {
    await graph.read(plan.object);
    for (const phase of plan.phases) {
      if (
        Boolean(phase.action) === Boolean(phase.wait) ||
        (phase.wait && (phase.attach || Object.keys(phase.parameters).length))
      )
        throw new Conflict('Select a single published observation Action or an event waiting phase');
      if (phase.maxSilenceSeconds !== undefined && (!phase.action || !phase.evidenceProperty || phase.attach))
        throw new Conflict('Polling freshness requires a source timestamp on its original object');
      if (phase.action) {
        const action = graph.model.action(phase.action);
        graph.access.action(graph.model, phase.action);
        if (
          action.effects?.length ||
          !action.typeClasses?.some((tag) => tag.kind === 'observation' && tag.name === 'readback')
        )
          throw new Conflict('Observation requires a published observation readback Action');
        validator(action.parameters).parse(this.arguments(graph, phase, plan.object));
      }
      const target = processTarget(graph, { type: phase.process });
      if (target.objectType !== plan.object.type)
        throw new Conflict('Observation phase must track its original object');
      this.checkStates(graph, phase);
      if (phase.attach) {
        const nav = graph.model.navigation(plan.object.type, phase.attach.link);
        graph.access.definition(graph.model, 'link', nav.link);
        if (processTarget(graph, { type: phase.attach.process }).objectType !== nav.target)
          throw new Conflict('The handoff link must target the authorized process');
        this.checkStates(graph, phase.attach);
      }
      if (!phase.complete.length && !phase.attach)
        throw new Conflict('A phase requires a completion state or a linked handoff');
      if (phase.attach && !phase.attach.complete.length)
        throw new Conflict('A linked observation requires terminal states');
      if (release && release !== graph.model.release) {
        const links = phase.attach ? [graph.model.navigation(plan.object.type, phase.attach.link).link] : [];
        checkWorkflowDependencies(
          await this.metadata.get(release, graph.client),
          graph.model,
          {
            actions: phase.action ? [phase.action] : [],
            objectTypes: [plan.object.type, phase.process, ...(phase.attach ? [phase.attach.process] : [])],
            linkTypes: links,
          },
          new Set(),
        );
      }
    }
  }
  private checkStates(graph: Objects, condition: z.output<typeof completion>) {
    const target = processTarget(graph, { type: condition.process });
    const property = graph.model.object(target.objectType).properties[target.property]!;
    if (
      !graph.access.property(graph.model, target.objectType, target.property) ||
      !graph.access.canSeeModelData(property.classification)
    )
      throw new Conflict('Observation state is unavailable');
    if (condition.evidenceProperty) {
      const evidence = graph.model.object(target.objectType).properties[condition.evidenceProperty];
      const variants = evidence?.schema.anyOf ?? [evidence?.schema];
      if (
        !evidence ||
        evidence.derived ||
        !Array.isArray(variants) ||
        !variants.some((schema) => schema?.format === 'date-time')
      )
        throw new Conflict('Observation evidence must be a published stored timestamp');
      if (
        !graph.access.property(graph.model, target.objectType, condition.evidenceProperty) ||
        !graph.access.canSeeModelData(evidence.classification)
      )
        throw new PermissionDenied('Observation evidence is unavailable');
    }
    const states = new Set(property.schema.enum as string[]);
    if (
      [...condition.complete, ...condition.stop].some((s) => !states.has(s)) ||
      condition.complete.some((s) => condition.stop.includes(s))
    )
      throw new Conflict('Observation states must belong to the published process and have one outcome');
  }
  private arguments(graph: Objects, phase: Phase, object: ObjectRef) {
    if (!phase.action) throw new Conflict('Waiting phases do not execute an Action');
    const entries = Object.entries(graph.model.action(phase.action).objectParameters);
    if (entries.length !== 1 || entries[0]![1] !== object.type || Object.hasOwn(phase.parameters, entries[0]![0]))
      throw new Conflict('Observation Action must bind exactly its original object');
    return { ...phase.parameters, [entries[0]![0]]: object };
  }
  async start(access: Access, model: PublishedOntology, raw: unknown) {
    requireScope(access.principal, 'ontology:write');
    requireScope(access.principal, 'ontology:read');
    const plan = startInterestSchema.parse(raw);
    if (model.scenario || model.document.id !== 'Eigos')
      throw new Conflict('Observation requires the live scheduled Ontology');
    if (JSON.stringify(plan).length > 32000) throw new Conflict('Observation phase parameters exceed their size limit');
    return this.db.withOwner(access.principal.owner, () =>
      this.db.transaction(async (client) => {
        const graph = new Objects(this.db, model, access, client);
        await graph.lockWrites();
        await access.refresh(client);
        await this.validate(graph, plan);
        const prior = (
          await this.db.query<Row>(
            `SELECT * FROM ${this.db.schema}.observation_interests WHERE owner=$1 AND request_id=$2 FOR UPDATE`,
            [graph.owner, plan.requestId],
            client,
          )
        ).rows[0];
        if (prior) {
          if (prior.digest !== digest(plan)) throw new Conflict('Observation request ID belongs to another plan');
          return this.readRow(graph, prior);
        }
        const remaining = Date.parse(plan.deadline) - Date.now();
        if (remaining <= 1000) throw new Conflict('Select a finite future observation horizon');
        const row = (
          await this.db.query<Row>(
            `INSERT INTO ${this.db.schema}.observation_interests(id,owner,ontology,release,request_id,digest,plan,scopes,deadline)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              randomUUID(),
              graph.owner,
              model.document.id,
              model.release,
              plan.requestId,
              digest(plan),
              plan,
              JSON.stringify(access.principal.scopes),
              plan.deadline,
            ],
            client,
          )
        ).rows[0]!;
        await this.drive(graph, row);
        await access.refresh(client);
        return this.readRow(
          graph,
          (
            await this.db.query<Row>(
              `SELECT * FROM ${this.db.schema}.observation_interests WHERE id=$1`,
              [row.id],
              client,
            )
          ).rows[0]!,
        );
      }),
    );
  }
  private async schedule(row: Row, id: string | null, client: Sql) {
    if (!id) return;
    return (
      await this.db.query(
        `SELECT s.state,s.body,s.run_at,s.deadline,t.state AS task_state,t.available_at,t.lease_until
      FROM ${this.db.schema}.scheduled_actions s LEFT JOIN ${this.db.schema}.tasks t ON t.id=s.task_id AND t.owner=s.owner
      WHERE s.owner=$1 AND s.id=$2`,
        [row.owner, id],
        client,
      )
    ).rows[0];
  }
  private async readRow(graph: Objects, row: Row) {
    await graph.read(row.plan.object);
    if (row.attached) await graph.read(row.attached);
    for (const phase of row.plan.phases) {
      if (phase.action) graph.access.definition(graph.model, 'action', phase.action, true);
      for (const condition of [phase, ...(phase.attach ? [phase.attach] : [])]) {
        this.checkStates(graph, condition);
      }
      if (phase.attach)
        graph.access.definition(
          graph.model,
          'link',
          graph.model.navigation(row.plan.object.type, phase.attach.link).link,
          true,
        );
    }
    const phase = row.plan.phases[row.phase]!;
    const schedule = await this.schedule(row, row.attached_schedule ?? row.schedule_id, graph.client);
    const state = schedule?.state === 'started' ? schedule.task_state : schedule?.state;
    const nextCheckAt =
      state === 'scheduled'
        ? schedule?.run_at
        : state === 'submitted'
          ? (schedule?.available_at ?? schedule?.run_at)
          : null;
    const live = row.state === 'watching' && row.deadline.getTime() > Date.now();
    if (!live) await graph.access.restoreReads(row.evidence_requirements, row.evidence_markings, graph.client);
    const evidence = live
      ? await this.stateEvidence(graph, row.attached ?? row.plan.object, row.attached ? phase.attach! : phase)
      : { state: row.last_state, at: row.last_observed_at };
    let status: string = row.state,
      reason = row.reason;
    if (status === 'watching') {
      if (row.deadline.getTime() <= Date.now()) {
        status = 'expired';
        reason = 'horizon_reached';
      } else if (phase.wait) {
        const event = eventObservation({
          startedAt: row.phase_started_at,
          lastObservedAt: evidence.at,
          maxSilenceSeconds: phase.wait.maxSilenceSeconds,
          now: new Date(),
        });
        status = event.status;
        reason = event.reason;
      } else if (!row.schedule_id || !schedule) {
        status = 'stranded';
        reason = 'schedule_missing';
      } else if (['blocked', 'failed', 'canceled'].includes(state)) {
        status = 'blocked';
        reason = 'scheduled_check_' + state;
      } else if (schedule?.state === 'started' && (!state || state === 'input-required')) {
        status = 'stranded';
        reason = 'check_has_no_next_execution';
      } else if (
        state === 'working' &&
        schedule?.lease_until &&
        new Date(schedule.lease_until).getTime() < Date.now()
      ) {
        status = 'late';
        reason = 'check_lease_overdue';
      } else if (nextCheckAt && new Date(nextCheckAt).getTime() + 60_000 < Date.now()) {
        status = 'late';
        reason = 'check_overdue';
      }
      if (status === 'watching' && phase.maxSilenceSeconds !== undefined) {
        const freshness = eventObservation({
          startedAt: row.phase_started_at,
          lastObservedAt: evidence.at,
          maxSilenceSeconds: phase.maxSilenceSeconds,
          now: new Date(),
        });
        if (freshness.status === 'stranded') {
          status = 'stranded';
          reason = freshness.reason;
        }
      }
      if ((status === 'waiting' || status === 'watching') && row.next_scan.getTime() + 60_000 < Date.now()) {
        status = 'late';
        reason = 'reconciliation_overdue';
      }
    }
    return {
      id: row.id,
      object: row.plan.object,
      phases: row.plan.phases.map((p) => ({
        name: p.name,
        process: p.process,
        action: p.action,
        complete: p.complete,
        stop: p.stop,
        ...(p.attach ? { attach: p.attach } : {}),
        ...(p.wait ? { wait: p.wait } : {}),
        intervalSeconds: p.intervalSeconds,
        evidenceProperty: p.evidenceProperty,
        maxSilenceSeconds: p.maxSilenceSeconds,
        limits: {
          ...(Array.isArray(p.parameters.sources) && p.parameters.sources.every((s) => typeof s === 'string')
            ? { sources: p.parameters.sources }
            : {}),
          ...(typeof p.parameters.maxChecks === 'number' ? { maxChecks: p.parameters.maxChecks } : {}),
          ...(typeof p.parameters.monitorUntil === 'string' ? { monitorUntil: p.parameters.monitorUntil } : {}),
        },
      })),
      phaseIndex: row.phase,
      status,
      reason,
      action: phase.action,
      attached: row.attached,
      nextCheckAt: live ? (nextCheckAt ?? null) : null,
      nextReviewAt: live ? row.next_scan : null,
      checkDeadline: schedule?.deadline ?? null,
      deadline: row.deadline,
      lastObservedAt: evidence.at,
      lastState: evidence.state,
    };
  }
  private unavailable(row: Row) {
    return {
      id: row.id,
      object: row.plan.object,
      phases: [],
      phaseIndex: row.phase,
      status: row.state === 'canceled' ? 'canceled' : 'blocked',
      reason: 'permissions_or_contract_unavailable',
      action: null,
      attached: null,
      nextCheckAt: null,
      nextReviewAt: null,
      checkDeadline: null,
      deadline: row.deadline,
      lastObservedAt: null,
      lastState: null,
    };
  }
  async list(access: Access, model: PublishedOntology, raw: unknown) {
    const { object, cursor } = listInterestsSchema.parse(raw);
    return this.db.withOwner(access.principal.owner, () =>
      this.db.transaction(async (client) => {
        if (object) await new Objects(this.db, model, access, client).read(object);
        const rows = (
          await this.db.query<Row>(
            `SELECT * FROM ${this.db.schema}.observation_interests
        WHERE owner=$1 AND ontology=$2 AND ($3::jsonb IS NULL OR plan->'object'=$3::jsonb)
          AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 51`,
            [access.principal.owner, model.document.id, object ?? null, cursor ?? null],
            client,
          )
        ).rows;
        const items = [];
        for (const row of rows.slice(0, 50)) {
          const root = await access.fork(client);
          try {
            await new Objects(this.db, model, root, client).read(row.plan.object);
          } catch (error) {
            if (error instanceof NotFound || error instanceof PermissionDenied) continue;
            throw error;
          }
          access.adoptReads(root);
          const branch = await access.fork(client);
          try {
            items.push(await this.readRow(new Objects(this.db, model, branch, client), row));
            access.adoptReads(branch);
          } catch (error) {
            if (!(error instanceof NotFound || error instanceof PermissionDenied || error instanceof Conflict))
              throw error;
            items.push(this.unavailable(row));
          }
        }
        await access.refresh(client);
        return { items, cursor: rows.length > 50 ? rows[49]!.id : null };
      }),
    );
  }
  private async finish(row: Row, state: Row['state'], reason: string, client: Sql) {
    await this.db.query(
      `UPDATE ${this.db.schema}.observation_interests SET state=$2,reason=$3 WHERE id=$1`,
      [row.id, state, reason],
      client,
    );
  }
  async cancel(access: Access, model: PublishedOntology, raw: unknown) {
    requireScope(access.principal, 'ontology:write');
    const { id } = cancelInterestSchema.parse(raw);
    return this.db.withOwner(access.principal.owner, () =>
      this.db.transaction(async (client) => {
        const graph = new Objects(this.db, model, access, client);
        await graph.lockWrites();
        const row = (
          await this.db.query<Row>(
            `SELECT * FROM ${this.db.schema}.observation_interests WHERE id=$1 AND owner=$2 AND ontology=$3 FOR UPDATE`,
            [id, graph.owner, model.document.id],
            client,
          )
        ).rows[0];
        if (!row) throw new NotFound('Observation interest unavailable');
        for (const scheduleId of new Set(
          [row.schedule_owned ? row.schedule_id : null, row.attached_schedule].filter((s): s is string => !!s),
        )) {
          const schedule = await this.schedule(row, scheduleId, client);
          if (schedule && ['scheduled', 'started', 'blocked'].includes(schedule.state))
            await this.schedules.cancel(graph, scheduleId);
        }
        await this.finish(row, 'canceled', 'owner_canceled', client);
        return { id, status: 'canceled', object: row.plan.object };
      }),
    );
  }
  private async stateEvidence(graph: Objects, object: ObjectRef, condition: z.output<typeof completion>) {
    const target = processTarget(graph, { type: condition.process });
    const data = await graph.read(object);
    if (data.ref.type !== target.objectType || !(await graph.propertyVisible(object, target.property)))
      throw new PermissionDenied('Observed state is unavailable');
    const value = data.properties[target.property],
      state = typeof value === 'string' ? value : null;
    if (condition.evidenceProperty) {
      if (!(await graph.propertyVisible(object, condition.evidenceProperty)))
        throw new PermissionDenied('Observation evidence is unavailable');
      const value = data.properties[condition.evidenceProperty],
        parsed = typeof value === 'string' ? Date.parse(value) : NaN;
      return { state, at: Number.isFinite(parsed) ? new Date(parsed) : null, sequence: null };
    }
    const [latest] = await readProcessTransitions(this.db, graph.model, graph.owner, target, graph.client, {
      latestFor: object.id,
    });
    const log = latest && (await visibleTransition(graph, target.type, latest.sequence));
    const observed = log?.properties.timestamp;
    const at =
      log?.properties.newState === state && log.properties.processId === object.id && typeof observed === 'string'
        ? new Date(observed)
        : null;
    return { state, at, sequence: at ? latest!.sequence : null };
  }
  private async stopOwned(row: Row, graph: Objects) {
    for (const id of new Set(
      [row.schedule_owned ? row.schedule_id : null, row.attached_schedule].filter((value): value is string => !!value),
    )) {
      const schedule = await this.schedule(row, id, graph.client);
      if (
        schedule?.state === 'scheduled' ||
        schedule?.state === 'blocked' ||
        (schedule?.state === 'started' && ['submitted', 'working', 'input-required'].includes(schedule.task_state))
      ) {
        await this.schedules.cancel(graph, id);
      }
    }
  }
  private async drive(graph: Objects, row: Row): Promise<void> {
    const phase = row.plan.phases[row.phase]!,
      client = graph.client;
    if (row.deadline.getTime() <= Date.now()) {
      await this.stopOwned(row, graph);
      return this.finish(row, 'expired', 'horizon_reached', client);
    }
    const condition = row.attached ? phase.attach! : phase,
      object = row.attached ?? row.plan.object;
    const { state, at, sequence } = await this.stateEvidence(graph, object, condition);
    const requirements = await graph.access.finalDataRequirements(client);
    await this.db.query(
      `UPDATE ${this.db.schema}.observation_interests SET last_state=$2,last_observed_at=$3,last_sequence=$4,
      evidence_requirements=$5,evidence_markings=$6 WHERE id=$1`,
      [row.id, state, at, sequence, JSON.stringify(requirements), JSON.stringify(graph.access.readMarkingsSnapshot())],
      client,
    );
    if (!phase.wait && at && at.getTime() > Date.now()) {
      await this.stopOwned(row, graph);
      return this.finish(row, 'stranded', 'invalid_evidence_time', client);
    }
    const freshEnough =
      phase.maxSilenceSeconds === undefined || (at && Date.now() - at.getTime() < phase.maxSilenceSeconds * 1000);
    const verified = at && at.getTime() <= Date.now() && freshEnough && (!phase.wait || at >= row.phase_started_at);
    if (verified && state !== null && condition.stop.includes(state)) {
      await this.stopOwned(row, graph);
      return this.finish(row, 'blocked', 'stop_state', client);
    }
    if (verified && state !== null && condition.complete.includes(state)) {
      await this.stopOwned(row, graph);
      if (row.phase + 1 === row.plan.phases.length) return this.finish(row, 'completed', 'terminal_state', client);
      const next = (
        await this.db.query<Row>(
          `UPDATE ${this.db.schema}.observation_interests SET phase=phase+1,schedule_id=NULL,schedule_owned=false,
          attached=NULL,attached_schedule=NULL,attempt=0,phase_started_at=clock_timestamp(),next_scan=now() WHERE id=$1 RETURNING *`,
          [row.id],
          client,
        )
      ).rows[0]!;
      return this.drive(graph, next);
    }
    if (phase.wait) {
      const event = eventObservation({
        startedAt: row.phase_started_at,
        lastObservedAt: at,
        maxSilenceSeconds: phase.wait.maxSilenceSeconds,
        now: new Date(),
      });
      if (event.status === 'stranded') {
        // Silence is a liveness gap, not withdrawal of the owner's event subscription.
        // A late committed receipt can still close the phase before the authorized deadline.
        await this.defer(row, client);
        return;
      }
      await this.db.query(
        `UPDATE ${this.db.schema}.observation_interests SET next_scan=LEAST(deadline,$2,now()+interval '10 seconds') WHERE id=$1`,
        [row.id, event.nextReviewAt],
        client,
      );
      return;
    }
    if (!phase.action) throw new Conflict('Observation phase has no Action');
    if (row.schedule_id) {
      const schedule = await this.schedule(row, row.attached_schedule ?? row.schedule_id, client);
      if (!schedule) return this.finish(row, 'stranded', 'schedule_missing', client);
      const execution = schedule.state === 'started' ? schedule.task_state : schedule.state;
      if (['failed', 'blocked', 'canceled'].includes(execution))
        return this.finish(row, 'blocked', 'scheduled_check_' + execution, client);
      if (!execution || execution === 'input-required')
        return this.finish(row, 'stranded', 'check_has_no_next_execution', client);
      if (execution !== 'completed' && execution !== 'expired') return this.defer(row, client);
      if (phase.attach)
        return this.finish(row, 'stranded', row.attached ? 'watch_ended_before_target' : 'handoff_missing', client);
    }
    if (!row.schedule_id && !phase.attach) {
      const actionArgs = this.arguments(graph, phase, row.plan.object);
      const existing = (
        await this.db.query(
          `SELECT s.id FROM ${this.db.schema}.scheduled_actions s
        LEFT JOIN ${this.db.schema}.tasks t ON t.id=s.task_id AND t.owner=s.owner
        WHERE s.owner=$1 AND s.body->>'action'=$2 AND s.body->'arguments'=$3::jsonb AND s.deadline>now()
          AND (s.state='scheduled' OR (s.state='started' AND t.state IN('submitted','working')))
          AND NOT EXISTS(SELECT 1 FROM ${this.db.schema}.observation_interests i WHERE i.owner=s.owner AND i.schedule_owned AND i.schedule_id=s.id)
        ORDER BY s.run_at,s.id LIMIT 1`,
          [row.owner, phase.action, actionArgs],
          client,
        )
      ).rows[0];
      if (existing) {
        await this.db.query(
          `UPDATE ${this.db.schema}.observation_interests SET schedule_id=$2,schedule_owned=false,next_scan=now()+interval '10 seconds' WHERE id=$1`,
          [row.id, existing.id],
          client,
        );
        return;
      }
    }
    const now = Date.now(),
      runAt = now + (row.attempt ? phase.intervalSeconds * 1000 : 0);
    if (runAt >= row.deadline.getTime()) return this.finish(row, 'stranded', 'no_check_before_deadline', client);
    const id = digest(['observation-interest', row.id, row.phase, row.attempt]);
    await this.schedules.enqueue(graph, {
      id,
      action: phase.action,
      arguments: this.arguments(graph, phase, row.plan.object),
      runAt: new Date(runAt).toISOString(),
      deadline: new Date(Math.min(row.deadline.getTime(), now + 30 * 86400000)).toISOString(),
      observationInterestId: row.id,
    });
    await this.db.query(
      `UPDATE ${this.db.schema}.observation_interests
      SET schedule_id=$2,schedule_owned=true,attempt=attempt+1,next_scan=now()+interval '10 seconds' WHERE id=$1`,
      [row.id, id],
      client,
    );
  }
  private async defer(row: Row, client: Sql) {
    await this.db.query(
      `UPDATE ${this.db.schema}.observation_interests SET next_scan=LEAST(deadline,now()+interval '10 seconds') WHERE id=$1`,
      [row.id],
      client,
    );
  }
  async scanOne() {
    return this.db.transaction(async (client) => {
      const row = (
        await this.db.query<Row>(
          `SELECT * FROM ${this.db.schema}.observation_interests WHERE state='watching' AND next_scan<=now()
        ORDER BY next_scan,id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [],
          client,
        )
      ).rows[0];
      if (!row) return false;
      await this.db.setOwner(client, row.owner);
      await client.query('SAVEPOINT observation_scan');
      try {
        const model = await this.metadata.active(row.ontology, client, true),
          access = await Access.load(this.db, { owner: row.owner, scopes: row.scopes }, client);
        const graph = new Objects(this.db, model, access, client);
        await graph.lockWrites();
        await this.validate(graph, row.plan, row.release);
        await this.drive(graph, row);
        await access.refresh(client);
        await client.query('RELEASE SAVEPOINT observation_scan');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT observation_scan');
        if (['55P03', '40001', '40P01'].includes((error as { code: string }).code)) return true;
        const model = await this.metadata.active(row.ontology, client);
        const access = await Access.load(this.db, { owner: row.owner, scopes: row.scopes }, client);
        await this.stopOwned(row, new Objects(this.db, model, access, client));
        await this.finish(row, 'blocked', 'permissions_or_contract_unavailable', client);
      }
      return true;
    });
  }
  async assertScheduled(graph: Objects, task: Task) {
    const call = task.input.scheduledAction;
    if (!call) throw new Conflict('A scheduled observation is required');
    const row = (
      await this.db.query<Row>(
        `SELECT * FROM ${this.db.schema}.observation_interests
      WHERE owner=$1 AND schedule_id=$2 AND schedule_owned AND state='watching' AND deadline>now() FOR SHARE`,
        [graph.owner, call.scheduleId],
        graph.client,
      )
    ).rows[0];
    if (
      !row ||
      row.ontology !== graph.model.document.id ||
      row.plan.phases[row.phase]!.action !== call.action ||
      digest(this.arguments(graph, row.plan.phases[row.phase]!, row.plan.object)) !== digest(call.arguments)
    )
      throw new Conflict('Observation authorization is unavailable');
    await this.schedules.current(task, graph.client);
    await this.validate(graph, row.plan, row.release);
    return { id: row.id, deadline: row.deadline.toISOString() };
  }
  async attach(graph: Objects, id: string, task: Task, attachment: { target: ObjectRef; scheduleId: string }) {
    if (graph.client === this.db.pool) throw new Conflict('Attach the watch in its Action transaction');
    if ((await this.assertScheduled(graph, task)).id !== id) throw new Conflict('Wrong observation interest');
    const row = (
      await this.db.query<Row>(
        `SELECT * FROM ${this.db.schema}.observation_interests WHERE id=$1 FOR UPDATE`,
        [id],
        graph.client,
      )
    ).rows[0]!;
    const attach = row.plan.phases[row.phase]!.attach;
    if (
      !attach ||
      !(await graph.follow(row.plan.object, attach.link)).some((item) => digest(item.ref) === digest(attachment.target))
    )
      throw new Conflict('Handoff must follow the authorized original-object link');
    const schedule = await this.schedule(row, attachment.scheduleId, graph.client);
    if (
      !schedule ||
      new Date(schedule.deadline).getTime() > row.deadline.getTime() ||
      Object.values(schedule.body.arguments).length !== 1 ||
      digest(Object.values(schedule.body.arguments)[0]) !== digest(attachment.target)
    )
      throw new Conflict('Attached check must address the linked watch within the authorized horizon');
    await this.db.query(
      `UPDATE ${this.db.schema}.observation_interests SET attached=$2,attached_schedule=$3,next_scan=now() WHERE id=$1`,
      [id, attachment.target, attachment.scheduleId],
      graph.client,
    );
  }
  async assertActive(graph: Objects, id: string, target: ObjectRef) {
    const row = (
      await this.db.query<Row>(
        `SELECT * FROM ${this.db.schema}.observation_interests
      WHERE id=$1 AND owner=$2 AND attached=$3::jsonb AND state IN('watching','completed') AND deadline>now() FOR SHARE`,
        [id, graph.owner, target],
        graph.client,
      )
    ).rows[0];
    if (!row || row.ontology !== graph.model.document.id)
      throw new Conflict('Linked observation authorization is unavailable');
    await this.validate(graph, row.plan, row.release);
    const phase = row.plan.phases[row.phase]!;
    if (
      !phase.attach ||
      !(await graph.follow(row.plan.object, phase.attach.link)).some((item) => digest(item.ref) === digest(target))
    )
      throw new Conflict('The original booking no longer links to this watch');
    await graph.read(target);
    return { id, deadline: row.deadline.toISOString() };
  }
}
