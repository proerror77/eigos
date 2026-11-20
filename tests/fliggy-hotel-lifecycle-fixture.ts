import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { fliggyHotelBookingType, fliggyHotelPublic } from '../packages/ontology/fliggy-hotel.js';
import { objectRefSchema } from '../packages/ontology/schema.js';
import { json } from '../packages/ontology/service-contracts.js';
import { document } from './fixture.js';

export const paReportType = 'SyntheticHotelPAReport';
export const deliveryType = 'SyntheticHotelCancellationDelivery';
export const recordPAReport = 'RecordSyntheticHotelPAReport';
export const recordDelivery = 'RecordSyntheticHotelCancellationDelivery';

export function hotelLifecycleDefinition() {
  const definition = structuredClone(document);
  const label = { schema: { type: 'string' }, required: true, description: 'Synthetic record name' };
  const reportFields = {
    reportedState: { schema: json(fliggyHotelPublic.shape.state), required: true, description: 'State asserted by the PA' },
    effectiveAt: { schema: json(z.iso.datetime()), required: true, description: 'Business time asserted by the PA' },
    evidence: { schema: { type: 'string', const: 'synthetic' }, required: true, description: 'Fixture evidence' },
  };

  // Publish the PA evidence and the consumer only in the test database.
  for (const [type, action, link, reverse, fields] of [
    [paReportType, recordPAReport, 'SyntheticHotelPAReportBooking', 'syntheticPAReports', reportFields],
    [deliveryType, recordDelivery, 'SyntheticHotelCancellationDeliveryBooking', 'syntheticCancellationDeliveries', {}],
  ] as const) {
    const bookingId = { parameter: 'booking', path: ['id'] };
    const id = type === paReportType ? { parameter: 'reportId' } : bookingId;
    const result = { type, id };
    const schema = type === paReportType
      ? z.strictObject({ booking: objectRefSchema, reportId: z.uuid(),
        reportedState: fliggyHotelPublic.shape.state, effectiveAt: z.iso.datetime() })
      : z.strictObject({ booking: objectRefSchema });
    definition.objectTypes.push({
      apiName: type, displayName: type, description: 'Isolated hotel lifecycle fixture',
      primaryKey: 'id', titleProperty: 'name', interfaces: {}, properties: { id: label, name: label, ...fields },
    });
    definition.linkTypes.push({
      apiName: link, description: 'Original order for this synthetic record',
      from: { type, name: 'booking', cardinality: 'one' },
      to: { type: fliggyHotelBookingType, name: reverse, cardinality: 'many' },
    });
    definition.actionTypes.push({
      apiName: action, description: 'Record a synthetic observation or delivery against the original booking',
      parameters: json(schema), objectParameters: { booking: fliggyHotelBookingType }, submissionCriteria: [],
      rules: [
        { op: 'createObject', object: result, properties: type === paReportType
          ? { id, name: { literal: type }, reportedState: { parameter: 'reportedState' },
            effectiveAt: { parameter: 'effectiveAt' }, evidence: { literal: 'synthetic' } }
          : { id, name: { literal: type } } },
        { op: 'addLink', link, from: result, to: { type: fliggyHotelBookingType, id: bookingId } },
      ],
      result,
    });
  }
  return definition;
}

export function startHotelLifecycleIndexer(schema: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/indexer/main.ts'], {
    env: { DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_PG_SCHEMA: schema },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '', spawnError: Error | undefined, exited = false;
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  child.on('error', error => { spawnError = error; });
  const closed = new Promise<void>(resolve => {
    child.once('close', () => { exited = true; resolve(); });
  });
  return {
    async waitFor<T>(description: string, read: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 15000;
      while (!exited && Date.now() < deadline) {
        if (spawnError) throw spawnError;
        const result = await read();
        if (result !== undefined) return result;
        await delay(80);
      }
      throw new Error('Indexer did not complete ' + description + (stderr ? '\n' + stderr : ''));
    },
    async stop() {
      if (!exited) child.kill('SIGTERM');
      await closed;
    },
  };
}
