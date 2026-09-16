// Mirror of data/lib/fuelEconomics.js for PebbleKit JS (phone + watch messaging).
// Keep in sync when the rule changes.

var E10_ENERGY_RATIO = 0.97;
var LPG_ENERGY_RATIO = 0.75;

function compareAltVsU91(u91Price, altPrice, energyRatio, altLabel) {
  if (
    typeof u91Price !== 'number' ||
    typeof altPrice !== 'number' ||
    !(u91Price > 0) ||
    !(energyRatio > 0)
  ) {
    return {
      pick: null,
      priceDiscountPct: null,
      energyEquivSavingPerL: null,
      winPct: null,
      label: 'No data',
    };
  }

  var priceDiscountPct = ((u91Price - altPrice) / u91Price) * 100;
  var altEffective = altPrice / energyRatio;
  var energyEquivSavingPerL = u91Price - altEffective;
  var eps = 0.05;
  var pick;
  var winPct = 0;
  if (energyEquivSavingPerL > eps) {
    pick = altLabel;
    winPct = ((u91Price - altEffective) / u91Price) * 100;
  } else if (energyEquivSavingPerL < -eps) {
    pick = 'U91';
    winPct = ((altEffective - u91Price) / altEffective) * 100;
  } else {
    pick = 'tie';
  }

  var label;
  if (pick === altLabel) {
    label =
      altLabel +
      ' — ' +
      priceDiscountPct.toFixed(1) +
      '% cheaper at pump, wins energy-adjusted';
  } else if (pick === 'U91') {
    label =
      priceDiscountPct > 0
        ? 'U91 — ' + altLabel + ' only ' + priceDiscountPct.toFixed(1) + '% less at pump'
        : 'U91 — same price or cheaper';
  } else {
    label = 'Even — price matches energy difference';
  }

  return {
    pick: pick,
    priceDiscountPct: round(priceDiscountPct, 1),
    energyEquivSavingPerL: round(energyEquivSavingPerL, 1),
    winPct: round(Math.abs(winPct), 1),
    label: label,
    breakEvenDiscountPct: round((1 - energyRatio) * 100, 1),
  };
}

function compareE10VsU91(u91Price, e10Price) {
  return compareAltVsU91(u91Price, e10Price, E10_ENERGY_RATIO, 'E10');
}

function compareLpgVsU91(u91Price, lpgPrice) {
  return compareAltVsU91(u91Price, lpgPrice, LPG_ENERGY_RATIO, 'LPG');
}

function compareBlob(cmp) {
  if (!cmp || !cmp.pick) return null;
  return {
    pick: cmp.pick,
    winPct: cmp.winPct,
    priceDiscountPct: cmp.priceDiscountPct,
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
  LPG_ENERGY_RATIO: LPG_ENERGY_RATIO,
  compareAltVsU91: compareAltVsU91,
  compareE10VsU91: compareE10VsU91,
  compareLpgVsU91: compareLpgVsU91,
  compareBlob: compareBlob,
  annualSavingsAud: annualSavingsAud,
};
