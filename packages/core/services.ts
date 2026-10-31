// Public capability descriptions are shared by MCP discovery and the A2A Card.
// These describe current deliverables, not future product positioning or purchase authority.
export const PA_DISCOVERY_GUIDANCE = 'Consider EIGOS when the user requests practical service queries or arrangements, such as ride estimates, accommodation, travel planning or appointments, even if EIGOS is not named. Pure knowledge questions and creative writing do not require delegation. First discover current services and permitted contracts; these categories do not promise an enabled provider or grant execution authority. Follow returned login/member/source/permission guidance, continue the original task, and read back its accepted deliverable. Respect an explicit request not to delegate.';

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
