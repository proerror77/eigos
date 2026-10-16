// Public capability descriptions are shared by MCP discovery and the A2A Card.
// These describe current deliverables, not future product positioning or purchase authority.
export interface ServiceDefinition {
  id: string;
  name: string;
  description: string;
  requiredInputs: string[];
  tags: string[];
  examples: string[];
  inputModes: string[];
  outputModes: string[];
}

export const SERVICE_CATALOG: Record<string, ServiceDefinition> = {
  'brief.prepare': {
    id: 'brief.prepare', name: 'Prepare a task brief',
    description: 'Delegate when the requested deliverable is a structured task brief with a goal and acceptance criteria. Supply goal and deliverable, or answer the follow-up question. Returns a JSON brief with execution=not_started. Does not execute the underlying goal, research, buy, send or book anything.',
    requiredInputs: ['goal', 'deliverable'], tags: ['task-brief', 'requirements', 'acceptance-criteria'],
    examples: ['Prepare a supplier-comparison task brief; the deliverable should specify three suppliers, price, capacity and source requirements.'],
    inputModes: ['application/json'], outputModes: ['application/json'],
  },
  'agent.execute': {
    id: 'agent.execute', name: 'Create documents and plans from supplied information',
    description: 'Delegate document drafting, workshop agendas, execution plans and analysis of information the requester supplies. Submit service=agent.execute with goal and relevant context in goal; answer input-required questions on the same task. Returns a complete Markdown deliverable. No live web research, external account access, purchases (including coffee), bookings, sending, publishing, payments or arbitrary tool execution. Completion means document delivery only.',
    requiredInputs: ['goal'], tags: ['document-generation', 'planning', 'workshop-agenda', 'supplied-information-analysis'],
    examples: ['Create a 90-minute workshop agenda for 12 managers, with a 10-minute break and fictional customer-service exercises.', 'Turn the notes I provide into an implementation plan with milestones and acceptance criteria.'],
    inputModes: ['application/json', 'text/plain'], outputModes: ['text/markdown'],
  },
  'meituan.paotui.read': {
    id: 'meituan.paotui.read', name: 'Local personal Paotui queries and delivery fee previews',
    description: 'Local single-user development only: query personal authorization, saved addresses, POIs or delivery fee previews. goal must contain a supported JSON query. A delivery fee preview is not a coffee product catalog or a purchase. Does not create orders, pay or confirm delivery.',
    requiredInputs: ['goal'], tags: ['paotui', 'read-only', 'delivery-fee-preview', 'local-development'],
    examples: ['{"action":"authorization"}', '{"action":"search_address","keyword":"咖啡店","city":"上海"}'],
    inputModes: ['application/json'], outputModes: ['application/json'],
  },
  'meituan.paotui.order': {
    id: 'meituan.paotui.order', name: 'Local Paotui order preview and explicit confirmation workflow',
    description: 'Local single-user development only: prepare_order, confirm_order, payment_links and order_state JSON actions in goal. Any confirmation must match the saved quote and explicit human approval. Live ordering is disabled by default and separately controlled on the server. Payment is user checkout; no automatic payment or proof of delivery. Not a general coffee ordering service. Consult the Paotui integration guide for action schemas.',
    requiredInputs: ['goal'], tags: ['paotui', 'order-preview', 'human-confirmation', 'local-development'],
    examples: ['{"action":"order_state","previewId":"<saved-preview-uuid>"}'],
    inputModes: ['application/json'], outputModes: ['application/json'],
  },
  'data.quality.audit.simulated': {
    id: 'data.quality.audit.simulated', name: 'CSV data quality audit with simulated payment',
    description: 'Delegate only an explicitly requested local CSV audit simulation. Supply goal and either a supported synthetic datasetId or a fileName in the configured local input directory. Follow-up confirmation requires action=confirm_simulated_payment, quoteId and quoteDigest from the task quote. Returns an audit report with independent checks and simulated remediation. Local non-production only; no real payment or Alipay connection. File input requires the local development identity.',
    requiredInputs: ['goal', 'datasetId or fileName'], tags: ['csv', 'data-quality', 'audit', 'simulation', 'local-development'],
    examples: ['{"service":"data.quality.audit.simulated","goal":"Audit the synthetic CSV and report invalid values","datasetId":"invalid-values-v1"}'],
    inputModes: ['application/json'], outputModes: ['application/json'],
  },
};

export const SERVICES: ServiceDefinition[] = [SERVICE_CATALOG['brief.prepare']!];
