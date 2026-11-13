export class Clarification extends Error {
  constructor(message: string, readonly choices?: unknown) { super(message); }
}
