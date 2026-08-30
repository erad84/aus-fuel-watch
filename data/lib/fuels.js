'use strict';

// Canonical fuel codes used everywhere downstream: the published files, the
// fitted params and the watch UI.
const FUELS = ['U91', 'E10', 'P95', 'P98', 'DSL', 'PDSL'];

// Petrolmate /api/summary codes. LPG is intentionally absent: it exists on
// /api/widget/prices but not on /api/summary, and /api/widget/ is robots-disallowed.
const FROM_PETROLMATE = {
  ULP: 'U91',
  E10: 'E10',
  PULP95: 'P95',
  PULP98: 'P98',
  DIESEL: 'DSL',
  PDIESEL: 'PDSL',
};

// Suffix of each seed workbook sheet name, e.g. "VIC PULP95" -> P95.
// The workbook has LPG sheets but only from 2026-07-15 and not for TAS or NT,
// and there is no matching collector source, so LPG is skipped.
const FROM_SEED_SHEET = {
  U91: 'U91',
  E10: 'E10',
  PULP95: 'P95',
  PULP98: 'P98',
  DIS: 'DSL',
  LPG: null,
};

// Human labels for the watch and settings UI.
const LABELS = {
  U91: 'Unleaded 91',
  E10: 'Ethanol 10',
  P95: 'Premium 95',
  P98: 'Premium 98',
  DSL: 'Diesel',
  PDSL: 'Premium Diesel',
};

// The seed workbook has no premium diesel series, so PDSL inherits the cycle
// shape of ordinary diesel until the collector has observed enough of its own.
const PARAM_FALLBACK = { PDSL: 'DSL' };

module.exports = { FUELS, FROM_PETROLMATE, FROM_SEED_SHEET, LABELS, PARAM_FALLBACK };
