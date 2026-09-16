#include "afw.h"

#define PKEY_THEME 1

static int s_theme_light;

void afw_theme_init(void) {
  s_theme_light = persist_exists(PKEY_THEME) && persist_read_int(PKEY_THEME) ? 1 : 0;
}

void afw_theme_set(int light) {
  s_theme_light = light ? 1 : 0;
  persist_write_int(PKEY_THEME, s_theme_light);
}

int afw_theme_is_light(void) {
  return s_theme_light;
}

GColor afw_theme_bg(void) {
  return s_theme_light ? GColorWhite : GColorBlack;
}

GColor afw_theme_fg(void) {
  return s_theme_light ? GColorBlack : GColorWhite;
}

GColor afw_theme_muted(void) {
#if defined(PBL_COLOR)
  return s_theme_light ? GColorDarkGray : GColorLightGray;
#else
  return afw_theme_fg();
#endif
}
