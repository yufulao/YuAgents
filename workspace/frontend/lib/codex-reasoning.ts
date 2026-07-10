import type { CodexModelInfo } from './types';

const FALLBACK_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function addOption(options: Map<string, string>, value: string | null | undefined, label?: string) {
  const effort = value?.trim();
  if (!effort) return;
  options.set(effort, label || options.get(effort) || effort);
}

export function getCodexReasoningOptions(
  model: CodexModelInfo | null | undefined,
  extras: Array<string | null | undefined> = [],
) {
  const options = new Map<string, string>();
  for (const level of model?.supported_reasoning_levels || []) {
    addOption(options, level.effort, level.description ? `${level.effort} - ${level.description}` : level.effort);
  }
  addOption(options, model?.default_reasoning_level || undefined);
  for (const extra of extras) addOption(options, extra);
  if (options.size === 0) {
    for (const level of FALLBACK_REASONING_LEVELS) addOption(options, level);
  }
  return Array.from(options, ([value, label]) => ({ value, label }));
}

export function getPreferredCodexReasoningLevel(
  model: CodexModelInfo | null | undefined,
  current: string | null | undefined,
  configured: string | null | undefined,
) {
  const supported = (model?.supported_reasoning_levels || [])
    .map((level) => level.effort?.trim())
    .filter((value): value is string => Boolean(value));
  if (supported.length === 0) {
    return current?.trim() || configured?.trim() || model?.default_reasoning_level || 'medium';
  }
  const currentValue = current?.trim();
  if (currentValue && supported.includes(currentValue)) return currentValue;
  const defaultValue = model?.default_reasoning_level?.trim();
  if (defaultValue && supported.includes(defaultValue)) return defaultValue;
  const configuredValue = configured?.trim();
  if (configuredValue && supported.includes(configuredValue)) return configuredValue;
  return supported[0];
}
