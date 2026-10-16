import { randomUUID } from 'node:crypto';
import type { Job } from '../core/domain.js';

export const LIFE_INTAKE = 'life.request' as const;

export interface LifeRequest {
  version: 1;
  acceptedFor: 'intake_only';
  status: 'waiting_provider' | 'canceled';
  originalGoal: string;
  domain?: string;
  receivedAt: string;
  updatedAt: string;
  execution: 'not_started';
  businessCompleted: false;
  automaticExecution: false;
  nextAction: 'await_provider_integration' | 'none';
}

// A durable handoff receipt, not a provider, planner or fulfillment claim.
export function receiveLifeRequest(job: Job, domain?: string): void {
  job.state = 'submitted';
  job.executionMode = 'intake';
  job.intake = {
    version: 1, acceptedFor: 'intake_only', status: 'waiting_provider', originalGoal: job.goal,
    ...(domain ? { domain } : {}), receivedAt: job.createdAt, updatedAt: job.updatedAt,
    execution: 'not_started', businessCompleted: false, automaticExecution: false,
    nextAction: 'await_provider_integration',
  };
  refreshLifeReceipt(job);
  job.messages.push({ id: randomUUID(), role: 'agent', text: job.artifact!.data.deliverable, at: job.updatedAt });
}

export function refreshLifeReceipt(job: Job): void {
  if (!job.intake) throw new Error('Life request receipt missing');
  job.intake.updatedAt = job.updatedAt;
  const text = job.intake.status === 'canceled'
    ? '生活任务登记已取消。未执行任何订单、预订或付款。'
    : 'EIGOS 已收到并保存生活服务需求。目前仅完成任务转交，等待服务提供方接入；尚未查询商品或房票、下单、预订、付款或履约，也不会自动开始执行。可在同一任务补充信息、查询或取消登记。';
  job.artifact = {
    id: job.artifact?.id ?? randomUUID(), name: 'life-request-receipt.json',
    data: { goal: job.goal, deliverable: text, execution: 'not_started', result: structuredClone(job.intake) },
  };
}
