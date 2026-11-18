export const POLICY_ACTIONS = Object.freeze(['full', 'partial', 'hold']);
export const DRAFT_UNITS = Object.freeze(['cartons', 'other', 'unknown']);

const ACTION_LABELS = Object.freeze({
  full: 'Full Receipt',
  partial: 'Partial Receipt',
  hold: 'Hold for Review',
});

/**
 * Validates and normalizes a receipt draft against the extraction contract:
 * `{ counts: number[], unit: 'cartons' | 'other' | 'unknown', conflict: boolean }`.
 */
export function validateDraft(draft) {
  const errors = [];

  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return {
      valid: false,
      errors: ['Draft must be a non-null object.'],
      normalized: null,
    };
  }

  let normalizedCounts = [];
  if (!Array.isArray(draft.counts)) {
    errors.push('Draft counts must be an array of numbers.');
  } else {
    for (let index = 0; index < draft.counts.length; index += 1) {
      const value = draft.counts[index];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push(`Count at index ${index} must be a non-negative finite number.`);
      } else {
        normalizedCounts.push(value);
      }
    }
  }

  if (!DRAFT_UNITS.includes(draft.unit)) {
    errors.push("Draft unit must be 'cartons', 'other', or 'unknown'.");
  }

  if (typeof draft.conflict !== 'boolean') {
    errors.push('Draft conflict flag must be a boolean.');
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      normalized: null,
    };
  }

  return {
    valid: true,
    errors: [],
    normalized: {
      counts: normalizedCounts,
      unit: draft.unit,
      conflict: draft.conflict,
    },
  };
}

/**
 * Parses comma- or whitespace-separated numbers from operator input.
 * Returns normalized numbers plus any unparseable tokens so the UI can warn without guessing.
 */
export function parseCountsInput(rawText) {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) {
    return { counts: [], invalidTokens: [] };
  }

  const tokens = trimmed
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const counts = [];
  const invalidTokens = [];

  for (const token of tokens) {
    const parsed = Number(token);
    if (!Number.isFinite(parsed) || parsed < 0) {
      invalidTokens.push(token);
    } else {
      counts.push(parsed);
    }
  }

  return { counts, invalidTokens };
}

/**
 * Formats a draft counts array into a stable comma-separated string.
 */
export function formatCountsInput(counts) {
  if (!Array.isArray(counts) || counts.length === 0) {
    return '';
  }
  return counts.join(', ');
}

/**
 * Builds label-free structured evidence from PO quantity and a receipt draft.
 */
export function buildCaseEvidence(poQty, draft) {
  const poValid = typeof poQty === 'number' && Number.isFinite(poQty) && poQty > 0;
  const validation = validateDraft(draft);
  const holdReasons = [];

  if (!poValid) {
    holdReasons.push({
      code: 'invalid_po',
      message: 'Purchase order quantity must be a positive number.',
    });
  }

  if (!validation.valid) {
    holdReasons.push({
      code: 'malformed_draft',
      message: `Draft failed schema validation: ${validation.errors.join(' ')}`,
    });

    return {
      poQty: poValid ? poQty : null,
      poValid,
      draftValid: false,
      validationErrors: validation.errors,
      counts: [],
      countEntries: 0,
      observedCount: null,
      unit: null,
      conflict: null,
      delta: null,
      fulfillmentRatio: null,
      holdReasons,
    };
  }

  const normalized = validation.normalized;
  const countEntries = normalized.counts.length;
  const observedCount = countEntries === 1 ? normalized.counts[0] : null;

  if (countEntries === 0) {
    holdReasons.push({
      code: 'missing_count',
      message: 'No confirmed physical count is present.',
    });
  } else if (countEntries > 1) {
    holdReasons.push({
      code: 'multiple_counts',
      message: `Multiple unresolved physical counts (${normalized.counts.join(', ')}) require reconciliation.`,
    });
  }

  if (normalized.conflict) {
    holdReasons.push({
      code: 'conflict_flagged',
      message: 'Unresolved count conflict is flagged on the draft.',
    });
  }

  if (normalized.unit === 'other') {
    holdReasons.push({
      code: 'unit_mismatch',
      message: "Unit is 'other', which does not match a carton-based purchase order.",
    });
  } else if (normalized.unit === 'unknown') {
    holdReasons.push({
      code: 'unit_unknown',
      message: "Unit is 'unknown'; carton unit confirmation is required.",
    });
  }

  if (observedCount !== null && observedCount === 0) {
    holdReasons.push({
      code: 'zero_count',
      message: 'Confirmed physical count is zero.',
    });
  }

  if (poValid && observedCount !== null && observedCount > poQty) {
    holdReasons.push({
      code: 'overage',
      message: `Confirmed count (${observedCount}) exceeds PO quantity (${poQty}) by ${observedCount - poQty}.`,
    });
  }

  const delta = poValid && observedCount !== null ? observedCount - poQty : null;
  const fulfillmentRatio = poValid && observedCount !== null ? observedCount / poQty : null;

  return {
    poQty: poValid ? poQty : null,
    poValid,
    draftValid: true,
    validationErrors: [],
    counts: [...normalized.counts],
    countEntries,
    observedCount,
    unit: normalized.unit,
    conflict: normalized.conflict,
    delta,
    fulfillmentRatio,
    holdReasons,
  };
}

/**
 * Scores all three decision candidates ('full', 'partial', 'hold') deterministically
 * from case evidence alone, never accepting or referencing any expected label.
 */
export function scoreDecisionCandidates(poQty, draft) {
  const evidence = buildCaseEvidence(poQty, draft);
  const hasHold = evidence.holdReasons.length > 0;
  const holdMessages = evidence.holdReasons.map((reason) => reason.message);

  let fullCandidate;
  let partialCandidate;
  let holdCandidate;

  if (hasHold) {
    const fullBlockers = [...holdMessages];
    const partialBlockers = [...holdMessages];

    if (evidence.poValid && evidence.observedCount !== null) {
      if (evidence.observedCount < evidence.poQty) {
        fullBlockers.push(
          `Observed count (${evidence.observedCount}) does not equal PO quantity (${evidence.poQty}).`,
        );
      } else if (evidence.observedCount === evidence.poQty) {
        partialBlockers.push(
          `Observed count (${evidence.observedCount}) equals PO quantity (${evidence.poQty}).`,
        );
      }
    }

    fullCandidate = {
      action: 'full',
      label: ACTION_LABELS.full,
      supported: false,
      support: 0,
      reasons: [],
      blockers: fullBlockers,
    };

    partialCandidate = {
      action: 'partial',
      label: ACTION_LABELS.partial,
      supported: false,
      support: 0,
      reasons: [],
      blockers: partialBlockers,
    };

    holdCandidate = {
      action: 'hold',
      label: ACTION_LABELS.hold,
      supported: true,
      support: 1,
      reasons: holdMessages,
      blockers: [],
    };
  } else if (evidence.observedCount === evidence.poQty) {
    fullCandidate = {
      action: 'full',
      label: ACTION_LABELS.full,
      supported: true,
      support: 1,
      reasons: [
        `Confirmed positive carton count (${evidence.observedCount}) matches PO quantity (${evidence.poQty}) with no conflict.`,
      ],
      blockers: [],
    };

    partialCandidate = {
      action: 'partial',
      label: ACTION_LABELS.partial,
      supported: false,
      support: 0,
      reasons: [],
      blockers: [
        `Observed count (${evidence.observedCount}) equals PO quantity (${evidence.poQty}); no shortage exists.`,
      ],
    };

    holdCandidate = {
      action: 'hold',
      label: ACTION_LABELS.hold,
      supported: false,
      support: 0,
      reasons: [],
      blockers: [
        'No hold conditions triggered (valid positive carton count, no conflict, no overage).',
      ],
    };
  } else {
    const shortage = evidence.poQty - evidence.observedCount;
    const partialFulfillmentSupport = Number(
      (0.35 * (evidence.observedCount / evidence.poQty)).toFixed(2),
    );

    fullCandidate = {
      action: 'full',
      label: ACTION_LABELS.full,
      supported: false,
      support: partialFulfillmentSupport,
      reasons: [
        `PO, carton unit, and conflict checks pass (${evidence.observedCount} of ${evidence.poQty} cartons).`,
      ],
      blockers: [
        `Short by ${shortage} carton${shortage === 1 ? '' : 's'} relative to PO quantity (${evidence.poQty}).`,
      ],
    };

    partialCandidate = {
      action: 'partial',
      label: ACTION_LABELS.partial,
      supported: true,
      support: 1,
      reasons: [
        `Confirmed positive carton count (${evidence.observedCount}) is below PO quantity (${evidence.poQty}), short by ${shortage}.`,
      ],
      blockers: [],
    };

    holdCandidate = {
      action: 'hold',
      label: ACTION_LABELS.hold,
      supported: false,
      support: 0,
      reasons: [],
      blockers: [
        'No hold conditions triggered (positive short carton count without conflict or unit mismatch).',
      ],
    };
  }

  return {
    evidence,
    candidates: [fullCandidate, partialCandidate, holdCandidate],
    supportModel: {
      deterministic: true,
      usesExpectedLabel: false,
      note: 'Support scores are computed strictly from PO quantity and draft evidence without any expected label.',
    },
  };
}

/**
 * Deterministic receiving baseline selector built on top of `scoreDecisionCandidates`.
 */
export function evaluateReceivingBaseline(poQty, draft) {
  const scored = scoreDecisionCandidates(poQty, draft);
  const supported = scored.candidates.filter((candidate) => candidate.supported);

  let selected;
  if (supported.length === 1) {
    selected = supported[0];
  } else {
    selected =
      scored.candidates.find((candidate) => candidate.action === 'hold') ||
      scored.candidates[2];
  }

  return {
    action: selected.action,
    label: selected.label,
    support: selected.support,
    summary: selected.reasons[0] || 'Hold for receiver review.',
    reasons: [...selected.reasons],
    evidence: scored.evidence,
    candidates: scored.candidates,
    supportModel: scored.supportModel,
    scope: {
      autoAccept: false,
      inventoryMutation: false,
      note: 'Policy assessment provides receiving guidance only and never auto-accepts or mutates inventory.',
    },
  };
}

/**
 * Compares the raw extracted draft against the operator-edited working draft
 * and returns field-level changes for auditability.
 */
export function diffDrafts(extractedDraft, workingDraft) {
  const extractedValidation = validateDraft(extractedDraft);
  const workingValidation = validateDraft(workingDraft);

  if (!extractedValidation.valid) {
    return {
      hasBaselineExtraction: false,
      changed: false,
      changeCount: 0,
      changes: [],
    };
  }

  if (!workingValidation.valid) {
    return {
      hasBaselineExtraction: true,
      changed: true,
      changeCount: 1,
      changes: [
        {
          field: 'draft',
          label: 'Draft Validity',
          before: 'Valid extraction',
          after: workingValidation.errors.join(' '),
        },
      ],
    };
  }

  const base = extractedValidation.normalized;
  const current = workingValidation.normalized;
  const changes = [];

  const countsEqual =
    base.counts.length === current.counts.length &&
    base.counts.every((value, idx) => value === current.counts[idx]);

  if (!countsEqual) {
    changes.push({
      field: 'counts',
      label: 'Confirmed Counts',
      before: base.counts.length > 0 ? `[${base.counts.join(', ')}]` : '[] (none)',
      after: current.counts.length > 0 ? `[${current.counts.join(', ')}]` : '[] (none)',
    });
  }

  if (base.unit !== current.unit) {
    changes.push({
      field: 'unit',
      label: 'Unit',
      before: base.unit,
      after: current.unit,
    });
  }

  if (base.conflict !== current.conflict) {
    changes.push({
      field: 'conflict',
      label: 'Conflict Flag',
      before: String(base.conflict),
      after: String(current.conflict),
    });
  }

  return {
    hasBaselineExtraction: true,
    changed: changes.length > 0,
    changeCount: changes.length,
    changes,
  };
}
