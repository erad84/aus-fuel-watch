#include "afw.h"

static AfwState s_state;

void afw_state_init(void) {
  memset(&s_state, 0, sizeof(s_state));
  strncpy(s_state.title, "Aus Fuel Watch", AFW_TITLE_LEN - 1);
  strncpy(s_state.fuel, "U91", AFW_FUEL_LEN - 1);
  strncpy(s_state.dial_label, "--", AFW_LABEL_LEN - 1);
  strncpy(s_state.best_name, "Loading...", AFW_NAME_LEN - 1);
  s_state.dial_angle = 0;
  s_state.bar_low = 0;
  s_state.bar_high = 1000;
  s_state.bar_price = -1;
  s_state.best_price = -1;
}

AfwState *afw_state(void) {
  return &s_state;
}
