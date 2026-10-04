import { describe, expect, it } from 'vitest';
import { normalizeAiSettings } from '@shared/aiSettings';

describe('Jev switches', () => {
  it("carries topics' own-question switch over to rules' one", () => {
    expect(normalizeAiSettings({ jev: { customQuestions: true } }).jev.ruleQuestions).toBe(true);
    expect(normalizeAiSettings({ jev: { ruleQuestions: true, customQuestions: false } }).jev.ruleQuestions).toBe(true);
    expect(normalizeAiSettings({ jev: {} }).jev.ruleQuestions).toBe(false);
    expect('customQuestions' in normalizeAiSettings({ jev: { customQuestions: true } }).jev).toBe(false);
  });
});
