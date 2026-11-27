// Synthetic test module. Its only engine dependency is the registration argument.
export function register({ PARequests }) {
  const handlers = new Map([
    ['ReadRecord', async ({ id }, context) => (await context.objects.read({ type: 'TestRecord', id })).properties.name],
    ['CreateRecord', async ({ id, name }, context) => {
      const ref = { type: 'TestRecord', id };
      if (!name) {
        const { tasks, task } = context.execution;
        const answer = await new PARequests(tasks).requestActionInput(task, context.operationId,
          'record-name', 'record.complete_details', 'input', {}, {
            type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } }, additionalProperties: false,
          });
        name = answer.name;
      }
      return context.edit(ref, graph => graph.create(ref, { id, name, state: 'open' }));
    }],
    ['CloseRecord', async ({ record }, context) => context.edit(record, async graph => {
      const current = await graph.read(record);
      await graph.edit(record, current.revision, { state: 'closed' });
    })],
  ]);
  return { handlers };
}
