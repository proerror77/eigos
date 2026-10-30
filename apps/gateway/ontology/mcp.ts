import { type McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DomainError, type Principal } from '../../../packages/core/domain.js';
import { DefinitionService, definitionQuerySchema, definitionCommandSchema, foundationDefinitionQuerySchema, foundationDefinitionCommandSchema, prepareOntologyActionSchema, approveOntologyActionSchema } from '../../../packages/ontology/definition-service.js';

function result(action: () => { version: 1; result: unknown }): CallToolResult {
  try { const value = action(); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }
  catch (error) {
    if (error instanceof DomainError || error instanceof z.ZodError) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ version: 1, error: { code: error instanceof DomainError ? error.code : 'INVALID_INPUT', message: error instanceof DomainError ? error.message : 'Invalid metadata request' } }) }] };
    throw error;
  }
}

export function mountDefinitionMcp(server: McpServer, service: DefinitionService, principal: Principal): void {
  if (service.secured) {
    if (principal.scopes.includes('ontology:read')) server.registerTool('query_ontology_definitions', {
      description: 'Read operator-owned service intake metadata or authorized task-specific discovery, source changes and verification uses. Intake contracts require namespace management; task data retains its current row and field grants.',
      inputSchema: foundationDefinitionQuerySchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, input => result(() => service.query(principal, input)));
    if (principal.scopes.some(scope => ['ontology:write', 'ontology:publish'].includes(scope))) server.registerTool('manage_ontology_definitions', {
      description: 'Manage service intakes on the reviewed business model: validate, publish, activate, prepare bounded validation tasks, register independently accepted task evidence, and revoke verification. Requires namespace management and operation-specific ontology scopes; preparation retains parent, source and exact effect authorization.',
      inputSchema: foundationDefinitionCommandSchema, annotations: { destructiveHint: false, openWorldHint: false },
    }, input => result(() => service.command(principal, input)));
    if (principal.scopes.includes('ontology:read') && principal.scopes.includes('tasks:write')) server.registerTool('prepare_ontology_action', {
      description: 'Preview a reviewed personal-context Action in this task authority. It binds self or manages explicit personal defaults through the existing nonfinancial Intent/Worker ledger. Other caller-managed actions remain unavailable in Foundation mode.',
      inputSchema: prepareOntologyActionSchema, annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
    }, input => result(() => service.prepare(principal, input)));
    if (principal.scopes.includes('ontology:object_write') && principal.scopes.includes('tasks:write')) server.registerTool('approve_ontology_action', {
      description: 'Approve the exact owned personal-data preview with its unchanged scope and expiry. Current action, field, source and task permissions are still required; completion is independently read back by the Worker.',
      inputSchema: approveOntologyActionSchema, annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
    }, input => result(() => service.approve(principal, input)));
    return;
  }
  server.registerTool('query_ontology_definitions', { description: 'Read owned ontology namespaces, bounded Object Type/Link Type/Interface/Action Type resources, draft diffs and validation, published releases and history. Use get_definition for one exact resource. A published definition is distinct from executable handler availability. Validation requires edit or publish permission; metadata reads require ontology:read.', inputSchema: definitionQuerySchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, input => result(() => service.query(principal, input)));
  server.registerTool('manage_ontology_definitions', { description: 'Edit one typed definition in an owned draft, retire a resource, validate separately, publish an immutable release and explicitly activate it. Editing requires ontology:write; publication/activation require ontology:publish; shared default ontology management additionally requires ontology:admin. Exact draft revision and activation generation prevent overwrites. Metadata publication grants no business execution authority.', inputSchema: definitionCommandSchema, annotations: { destructiveHint: false, openWorldHint: false } }, input => result(() => service.command(principal, input)));
  server.registerTool('prepare_ontology_action', { description: 'Preview one published declarative data Action and create an owned task awaiting its exact object_write authorization. Uses the existing Intent/Worker ledger; does not mutate objects yet and never performs order/payment/provider writes. Reuse requestId for identical retries; committed retries read the original task.', inputSchema: prepareOntologyActionSchema, annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false } }, input => result(() => service.prepare(principal, input)));
  server.registerTool('approve_ontology_action', { description: 'Authorize only the exact managed-data preview returned by prepare_ontology_action, with explicit expiry. Requires tasks:write and ontology:object_write. Uses the existing plan authorization ledger. The Worker later commits atomically and independently reads back the result; this response is authorization, not completion.', inputSchema: approveOntologyActionSchema, annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false } }, input => result(() => service.approve(principal, input)));
}
