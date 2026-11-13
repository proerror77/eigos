import type { Requirement } from './access.js';
export class Clarification extends Error {
  constructor(message: string, readonly choices?: unknown, readonly permissions: Requirement[] = []) { super(message); }
}
