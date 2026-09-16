#pragma once

#include <pebble.h>

enum {
  SCREEN_MAIN = 0,
  SCREEN_GRAPH_STATE,
  SCREEN_GRAPH_STATION,
  SCREEN_LIST_FAVS,
  SCREEN_LIST_SUBURB,
  SCREEN_LIST_SCOPE,
  SCREEN_LIST_GPS,
};

#define AFW_TITLE_LEN 48
#define AFW_FUEL_LEN 16
#define AFW_LABEL_LEN 24
#define AFW_NAME_LEN 40
#define AFW_COMPARE_LEN 48
#define AFW_ASOF_LEN 24
#define AFW_LIST_JSON_LEN 512
#define AFW_GRAPH_MAX_PTS 72
#define AFW_LIST_MAX 5

typedef struct {
  char title[AFW_TITLE_LEN];
  char fuel[AFW_FUEL_LEN];
  char home_ctx[16];
  int32_t dial_angle; /* 0–359, 0 = peak/top */
  char dial_label[AFW_LABEL_LEN];
  int32_t bar_low;   /* tenths c/L */
  int32_t bar_high;
  int32_t bar_price;
  int32_t best_price;
  char best_name[AFW_NAME_LEN];
  char compare_line[AFW_COMPARE_LEN];
  char as_of[AFW_ASOF_LEN];
  bool stale;

  int32_t graph_kind; /* 0=state 1=station */
  int32_t graph_min;
  int32_t graph_max;
  int32_t graph_n;
  uint8_t graph_pts[AFW_GRAPH_MAX_PTS]; /* 0–255 scaled */

  int32_t list_kind;
  char list_json[AFW_LIST_JSON_LEN];
} AfwState;

void afw_state_init(void);
AfwState *afw_state(void);

void afw_ui_init(void);
void afw_ui_deinit(void);
void afw_ui_refresh(void);
void afw_nav_up(void);
void afw_nav_down(void);
void afw_nav_select(void);
void afw_nav_back(void);

void afw_comm_init(void);
void afw_comm_deinit(void);
void afw_comm_request(const char *req);

void afw_theme_init(void);
void afw_theme_set(int light);
int afw_theme_is_light(void);
GColor afw_theme_bg(void);
GColor afw_theme_fg(void);
GColor afw_theme_muted(void);
void afw_ui_apply_theme(void);
