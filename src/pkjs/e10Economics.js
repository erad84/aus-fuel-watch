// Mirror of data/lib/e10Economics.js for PebbleKit JS (phone + watch messaging).
// Keep in sync when the rule changes.

var E10_ENERGY_RATIO = 0.97;

var PICK = { E10: 'E10', U91: 'U91', TIE: 'tie' };

function compareE10VsU91(u91Price, e10Price) {
  if (typeof u91Price !== 'number' || typeof e10Price !== 'number' || u91Price <= 0) {
    return { pick: null, priceDiscountPct: null, energyEquivSavingPerL: null, label: 'No data' };
  }

  var priceDiscountPct = ((u91Price - e10Price) / u91Price) * 100;
  var e10EnergyEquiv = e10Price / E10_ENERGY_RATIO;
  var energyEquivSavingPerL = u91Price - e10EnergyEquiv;

  var eps = 0.05;
  var pick;
  if (energyEquivSavingPerL > eps) pick = PICK.E10;
  else if (energyEquivSavingPerL < -eps) pick = PICK.U91;
  else pick = PICK.TIE;

  var label;
  if (pick === PICK.E10) {
    label = 'E10 — ' + priceDiscountPct.toFixed(1) + '% cheaper, beats energy gap';
  } else if (pick === PICK.U91) {
    label =
      priceDiscountPct > 0
        ? 'U91 — E10 only ' + priceDiscountPct.toFixed(1) + '% less (need ~3% for real savings)'
        : 'U91 — same price or cheaper';
  } else {
    label = 'Even — price matches energy difference';
  }

  return {
    pick: pick,
    priceDiscountPct: round(priceDiscountPct, 1),
    energyEquivSavingPerL: round(energyEquivSavingPerL, 1),
    label: label,
    breakEvenDiscountPct: round((1 - E10_ENERGY_RATIO) * 100, 1),
  };
}

function annualSavingsAud(savingPerLitreCents, litresPerFill, fillsPerYear) {
  if (savingPerLitreCents <= 0) return 0;
  return round((savingPerLitreCents / 100) * litresPerFill * fillsPerYear, 0);
}

function round(n, dp) {
  var f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

module.exports = {
  E10_ENERGY_RATIO: E10_ENERGY_RATIO,
  PICK: PICK,
  compareE10VsU91: compareE10VsU91,
  annualSavingsAud: annualSavingsAud,
};
