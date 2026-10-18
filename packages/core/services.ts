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
