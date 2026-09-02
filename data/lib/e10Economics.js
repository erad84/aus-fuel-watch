'use strict';

// E10 vs U91 money comparison for the watch UI.
//
// E10 is ~3% less energy-dense per litre than U91. A lower pump price is not
// automatically a better buy. Break-even: E10 price equals U91 × 0.97. Above
// that gap E10 wins on cost per distance; below it U91 wins.
//
// Prices may be tenths of c/L (2056) or whole cents (205.6) — only ratios matter.

/** E10 energy content relative to U91 per litre (≈3% lower). */
const E10_ENERGY_RATIO = 0.97;

const PICK = { E10: 'E10', U91: 'U91', TIE: 'tie' };

/**
 * @param {number} u91Price same units as e10Price (tenths or cents)
 * @param {number} e10Price
 * @returns {{ pick, priceDiscountPct, energyEquivSavingPerL, label }}
 */
function compareE10VsU91(u91Price, e10Price) {
  if (typeof u91Price !== 'number' || typeof e10Price !== 'number' || u91Price <= 0) {
    return { pick: null, priceDiscountPct: null, energyEquivSavingPerL: null, label: 'No data' };
  }

  const priceDiscountPct = ((u91Price - e10Price) / u91Price) * 100;
  const breakEvenE10 = u91Price * E10_ENERGY_RATIO;
  const e10EnergyEquiv = e10Price / E10_ENERGY_RATIO;
  const energyEquivSavingPerL = u91Price - e10EnergyEquiv;

  const eps = 0.05;
  let pick;
  if (energyEquivSavingPerL > eps) pick = PICK.E10;
  else if (energyEquivSavingPerL < -eps) pick = PICK.U91;
  else pick = PICK.TIE;

  let label;
  if (pick === PICK.E10) {
    label = `E10 — ${priceDiscountPct.toFixed(1)}% cheaper, beats energy gap`;
  } else if (pick === PICK.U91) {
    label =
      priceDiscountPct > 0
        ? `U91 — E10 only ${priceDiscountPct.toFixed(1)}% less (need ~3% for real savings)`
        : 'U91 — same price or cheaper';
  } else {
    label = 'Even — price matches energy difference';
  }

  return {
    pick,
    priceDiscountPct: round(priceDiscountPct, 1),
    energyEquivSavingPerL: round(energyEquivSavingPerL, 1),
    label,
    breakEvenDiscountPct: round((1 - E10_ENERGY_RATIO) * 100, 1),
  };
}

/** Rough annual savings (AUD) for a fill habit when E10 wins. */
function annualSavingsAud(savingPerLitreCents, litresPerFill, fillsPerYear) {
  if (savingPerLitreCents <= 0) return 0;
  return round((savingPerLitreCents / 100) * litresPerFill * fillsPerYear, 0);
}

function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

module.exports = {
  E10_ENERGY_RATIO,
  PICK,
  compareE10VsU91,
  annualSavingsAud,
};
