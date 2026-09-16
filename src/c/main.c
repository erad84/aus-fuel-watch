#include "afw.h"

static void prv_init(void) {
  afw_theme_init();
  afw_state_init();
  afw_comm_init();
  afw_ui_init();
  afw_comm_request("refresh");
}

static void prv_deinit(void) {
  afw_ui_deinit();
  afw_comm_deinit();
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
