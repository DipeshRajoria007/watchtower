import { describe, expect, it } from 'vitest';
import { looksLikeFixAffirmation } from '../src/router/resumeIntentParser.js';

describe('looksLikeFixAffirmation', () => {
  it.each([
    'yes',
    'Yes',
    'YES',
    'yes please',
    'yes, fix it',
    'yes fix it',
    'yes, go ahead',
    'yes go ahead',
    'yes do it',
    'yes ship it',
    'yes.',
    'yes!',
    'yep',
    'yeah',
    'yup',
    'sure',
    'go ahead',
    'do it',
    'proceed',
    'fix it',
    'ship it',
    'ok',
    'okay',
    '  yes  ',
  ])('matches affirmation: %s', input => {
    expect(looksLikeFixAffirmation(input)).toBe(true);
  });

  it.each([
    '',
    'no',
    'cancel',
    'wait',
    'actually no',
    'yes but wait',
    'yes the bug is real but it might be different',
    'yes please also add a test',
    "yes, but I'm not sure that's the right fix",
    'this looks correct',
    "I'll do it myself",
    'fix it like this: …',
    'do it tomorrow when the freeze ends',
  ])('does not match: %s', input => {
    expect(looksLikeFixAffirmation(input)).toBe(false);
  });
});
