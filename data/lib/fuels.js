'use strict';

// Canonical fuel codes used everywhere downstream: the published files, the
// fitted params and the watch UI.
const FUELS = ['U91', 'E10', 'P95', 'P98', 'DSL', 'PDSL', 'LPG'];

// Petrolmate /api/summary codes. LPG is absent there (only on robots-disallowed
// /api/widget/prices), so Petrolmate fallback never fills LPG — station adapters do.
const FROM_PETROLMATE = {
  ULP: 'U91',
  E10: 'E10',
  PULP95: 'P95',
  PULP98: 'P98',
  DIESEL: 'DSL',
  PDIESEL: 'PDSL',
};

// Suffix of each seed workbook sheet name, e.g. "VIC PULP95" -> P95.
const FROM_SEED_SHEET = {
  U91: 'U91',
  E10: 'E10',
  PULP95: 'P95',
  PULP98: 'P98',
  DIS: 'DSL',
  LPG: 'LPG',
};

// Human labels for the watch and settings UI.
const LABELS = {
  U91: 'Unleaded 91',
  E10: 'Ethanol 10',
  P95: 'Premium 95',
  P98: 'Premium 98',
  DSL: 'Diesel',
  PDSL: 'Premium Diesel',
  LPG: 'LPG',
};

// The seed workbook has no premium diesel series, so PDSL inherits the cycle
// shape of ordinary diesel until the collector has observed enough of its own.
const PARAM_FALLBACK = { PDSL: 'DSL' };

module.exports = { FUELS, FROM_PETROLMATE, FROM_SEED_SHEET, LABELS, PARAM_FALLBACK };
