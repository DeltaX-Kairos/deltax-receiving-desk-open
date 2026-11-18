import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POLICY_ACTIONS,
  DRAFT_UNITS,
  validateDraft,
  parseCountsInput,
  formatCountsInput,
  buildCaseEvidence,
  scoreDecisionCandidates,
  evaluateReceivingBaseline,
  diffDrafts,
} from '../src/policy.js';

test('exports expected policy action and unit constants', () => {
  assert.deepEqual(POLICY_ACTIONS, ['full', 'partial', 'hold']);
  assert.deepEqual(DRAFT_UNITS, ['cartons', 'other', 'unknown']);
});

test('validateDraft validates contract and rejects malformed shapes', () => {
  const valid = validateDraft({ counts: [8], unit: 'cartons', conflict: false });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.normalized, { counts: [8], unit: 'cartons', conflict: false });

  assert.equal(validateDraft(null).valid, false);
  assert.equal(validateDraft([]).valid, false);
  assert.equal(validateDraft({ counts: [-1], unit: 'cartons', conflict: false }).valid, false);
  assert.equal(validateDraft({ counts: [Number.NaN], unit: 'cartons', conflict: false }).valid, false);
  assert.equal(validateDraft({ counts: ['8'], unit: 'cartons', conflict: false }).valid, false);
  assert.equal(validateDraft({ counts: [8], unit: 'pallets', conflict: false }).valid, false);
  assert.equal(validateDraft({ counts: [8], unit: 'cartons', conflict: 'no' }).valid, false);
});

test('parseCountsInput and formatCountsInput handle valid and invalid tokens cleanly', () => {
  assert.deepEqual(parseCountsInput(''), { counts: [], invalidTokens: [] });
  assert.deepEqual(parseCountsInput('8'), { counts: [8], invalidTokens: [] });
  assert.deepEqual(parseCountsInput('8, 10'), { counts: [8, 10], invalidTokens: [] });
  assert.deepEqual(parseCountsInput('8  abc -2'), {
    counts: [8],
    invalidTokens: ['abc', '-2'],
  });
  assert.equal(formatCountsInput([8, 10]), '8, 10');
  assert.equal(formatCountsInput([]), '');
});

test('evaluateReceivingBaseline supports full receipt on exact positive carton match', () => {
  const result = evaluateReceivingBaseline(10, {
    counts: [10],
    unit: 'cartons',
    conflict: false,
  });

  assert.equal(result.action, 'full');
  assert.equal(result.support, 1);
  assert.equal(result.evidence.delta, 0);
  assert.equal(result.scope.autoAccept, false);
  assert.equal(result.scope.inventoryMutation, false);
});

test('evaluateReceivingBaseline supports partial receipt on initial sample PO 10 and observed 8', () => {
  const result = evaluateReceivingBaseline(10, {
    counts: [8],
    unit: 'cartons',
    conflict: false,
  });

  assert.equal(result.action, 'partial');
  assert.equal(result.support, 1);
  assert.equal(result.evidence.observedCount, 8);
  assert.equal(result.evidence.delta, -2);
  assert.equal(result.candidates.length, 3);

  const fullCandidate = result.candidates.find((c) => c.action === 'full');
  const partialCandidate = result.candidates.find((c) => c.action === 'partial');
  const holdCandidate = result.candidates.find((c) => c.action === 'hold');

  assert.equal(partialCandidate.supported, true);
  assert.equal(partialCandidate.support, 1);
  assert.equal(fullCandidate.supported, false);
  assert.ok(fullCandidate.support > 0 && fullCandidate.support < 0.35);
  assert.equal(holdCandidate.supported, false);
  assert.equal(holdCandidate.support, 0);
});

test('evaluateReceivingBaseline holds zero, overage, missing count, unit mismatch, and unresolved disagreement', () => {
  const zeroCase = evaluateReceivingBaseline(10, {
    counts: [0],
    unit: 'cartons',
    conflict: false,
  });
  assert.equal(zeroCase.action, 'hold');
  assert.ok(zeroCase.evidence.holdReasons.some((r) => r.code === 'zero_count'));

  const overageCase = evaluateReceivingBaseline(10, {
    counts: [12],
    unit: 'cartons',
    conflict: false,
  });
  assert.equal(overageCase.action, 'hold');
  assert.ok(overageCase.evidence.holdReasons.some((r) => r.code === 'overage'));

  const missingCase = evaluateReceivingBaseline(10, {
    counts: [],
    unit: 'cartons',
    conflict: false,
  });
  assert.equal(missingCase.action, 'hold');
  assert.ok(missingCase.evidence.holdReasons.some((r) => r.code === 'missing_count'));

  const otherUnitCase = evaluateReceivingBaseline(10, {
    counts: [10],
    unit: 'other',
    conflict: false,
  });
  assert.equal(otherUnitCase.action, 'hold');
  assert.ok(otherUnitCase.evidence.holdReasons.some((r) => r.code === 'unit_mismatch'));

  const unknownUnitCase = evaluateReceivingBaseline(10, {
    counts: [10],
    unit: 'unknown',
    conflict: false,
  });
  assert.equal(unknownUnitCase.action, 'hold');
  assert.ok(unknownUnitCase.evidence.holdReasons.some((r) => r.code === 'unit_unknown'));

  const conflictFlagCase = evaluateReceivingBaseline(10, {
    counts: [10],
    unit: 'cartons',
    conflict: true,
  });
  assert.equal(conflictFlagCase.action, 'hold');
  assert.ok(conflictFlagCase.evidence.holdReasons.some((r) => r.code === 'conflict_flagged'));

  const multiCountCase = evaluateReceivingBaseline(10, {
    counts: [8, 10],
    unit: 'cartons',
    conflict: false,
  });
  assert.equal(multiCountCase.action, 'hold');
  assert.ok(multiCountCase.evidence.holdReasons.some((r) => r.code === 'multiple_counts'));
});

test('evaluateReceivingBaseline safely holds malformed drafts and invalid PO quantities', () => {
  const badDraft = evaluateReceivingBaseline(10, { counts: 'bad' });
  assert.equal(badDraft.action, 'hold');
  assert.ok(badDraft.evidence.holdReasons.some((r) => r.code === 'malformed_draft'));

  const badPo = evaluateReceivingBaseline(0, {
    counts: [8],
    unit: 'cartons',
    conflict: false,
  });
  assert.equal(badPo.action, 'hold');
  assert.ok(badPo.evidence.holdReasons.some((r) => r.code === 'invalid_po'));
});

test('scoreDecisionCandidates always exports all 3 candidates without expected labels', () => {
  const scored = scoreDecisionCandidates(10, {
    counts: [8],
    unit: 'cartons',
    conflict: false,
  });

  assert.equal(scored.supportModel.deterministic, true);
  assert.equal(scored.supportModel.usesExpectedLabel, false);
  assert.deepEqual(
    scored.candidates.map((c) => c.action),
    ['full', 'partial', 'hold'],
  );

  for (const candidate of scored.candidates) {
    assert.equal(typeof candidate.supported, 'boolean');
    assert.equal(typeof candidate.support, 'number');
    assert.ok(candidate.support >= 0 && candidate.support <= 1);
    assert.ok(Array.isArray(candidate.reasons));
    assert.ok(Array.isArray(candidate.blockers));
  }

  // Verify buildCaseEvidence does not mutate input draft
  const original = { counts: [8], unit: 'cartons', conflict: false };
  const evidence = buildCaseEvidence(10, original);
  evidence.counts.push(99);
  assert.deepEqual(original.counts, [8]);
});

test('diffDrafts detects operator modifications accurately', () => {
  const noBase = diffDrafts(null, { counts: [8], unit: 'cartons', conflict: false });
  assert.equal(noBase.hasBaselineExtraction, false);
  assert.equal(noBase.changed, false);

  const extracted = { counts: [8], unit: 'unknown', conflict: true };
  const identical = diffDrafts(extracted, { counts: [8], unit: 'unknown', conflict: true });
  assert.equal(identical.hasBaselineExtraction, true);
  assert.equal(identical.changed, false);
  assert.equal(identical.changeCount, 0);

  const edited = diffDrafts(extracted, { counts: [10], unit: 'cartons', conflict: false });
  assert.equal(edited.hasBaselineExtraction, true);
  assert.equal(edited.changed, true);
  assert.equal(edited.changeCount, 3);
  assert.deepEqual(
    edited.changes.map((c) => c.field),
    ['counts', 'unit', 'conflict'],
  );
});
