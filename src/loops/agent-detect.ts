import * as fs from 'node:fs';
import {
  skillAgentTargets,
  type SkillAgent,
  type SkillAgentTargetOptions,
} from './skill-install.js';
import {
  policyTargets,
  type PolicyAgent,
  type PolicyTargetOptions,
} from './session-policy.js';

export function detectSkillAgents(options: SkillAgentTargetOptions = {}): SkillAgent[] {
  return skillAgentTargets(options)
    .filter((target) => fs.existsSync(target.root))
    .map((target) => target.agent);
}

export function detectPolicyAgents(options: PolicyTargetOptions = {}): PolicyAgent[] {
  return policyTargets(options)
    .filter((target) => fs.existsSync(target.root) || fs.existsSync(target.file))
    .map((target) => target.agent);
}
