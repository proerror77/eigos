// Synthetic customer module. Its only engine dependency is the registration argument.
export function register({ PARequests }) {
  const handlers = new Map([
    ['ReadShipment', async ({ id }, context) => (await context.objects.read({ type: 'Shipment', id })).properties.name],
    ['RegisterShipment', async ({ id, name }, context) => {
      const ref = { type: 'Shipment', id };
      if (!name) {
        const { tasks, task } = context.execution;
        const answer = await new PARequests(tasks).requestActionInput(task, context.operationId,
          'shipment-name', 'shipment.complete_details', 'input', {}, {
            type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } }, additionalProperties: false,
          });
        name = answer.name;
      }
      return context.edit(ref, graph => graph.create(ref, { id, name, state: 'registered' }));
    }],
    ['DeliverShipment', async ({ shipment }, context) => context.edit(shipment, async graph => {
      const current = await graph.read(shipment);
      await graph.edit(shipment, current.revision, { state: 'delivered' });
    })],
  ]);
  return { handlers };
}
