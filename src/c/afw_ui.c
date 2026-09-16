#include "afw.h"

/* Use Pebble fixed-point trig instead of libm. */

static Window *s_main_window;
static Window *s_graph_window;
static Window *s_list_window;

static TextLayer *s_title_layer;
static TextLayer *s_dial_label_layer;
static TextLayer *s_best_layer;
static TextLayer *s_compare_layer;
static TextLayer *s_asof_layer;
static Layer *s_dial_layer;
static Layer *s_bar_layer;

static TextLayer *s_graph_title_layer;
static Layer *s_graph_layer;

static TextLayer *s_list_title_layer;
static TextLayer *s_list_body_layer;

static int s_screen = SCREEN_MAIN;
static int s_graph_screen = SCREEN_GRAPH_STATE;
static int s_list_screen = SCREEN_LIST_FAVS;

/* ---- drawing helpers ---- */

static GColor afw_rank_color(int pct) {
#if defined(PBL_COLOR)
  if (pct >= 75) return GColorIslamicGreen;
  if (pct >= 55) return GColorMintGreen;
  if (pct >= 45) return afw_theme_fg();
  if (pct >= 25) return GColorMelon;
  return GColorRed;
#else
  (void)pct;
  return afw_theme_fg();
#endif
}

static int afw_rank_pct(int32_t price, int32_t low, int32_t high) {
  if (price < 0 || high <= low) return 50;
  if (price <= low) return 100;
  if (price >= high) return 0;
  return (int)(((high - price) * 100) / (high - low));
}

/* Dial space: 0° = top, clockwise. Pebble arcs: 0° = 3 o'clock, clockwise. */
static int32_t dial_to_pebble_angle(int dial_deg) {
  return DEG_TO_TRIGANGLE(270 + dial_deg);
}

static void dial_update(Layer *layer, GContext *ctx) {
  AfwState *st = afw_state();
  GRect b = layer_get_bounds(layer);
  const int cx = b.origin.x + b.size.w / 2;
  const int cy = b.origin.y + b.size.h / 2;
  const int r = (b.size.w < b.size.h ? b.size.w : b.size.h) / 2 - 2;
  const int stroke = PBL_IF_ROUND_ELSE(8, 7);
  const int hub_r = (r * 14) / 62;

#if defined(PBL_COLOR)
  GRect ring = GRect(cx - r, cy - r, r * 2, r * 2);
  /* Outer ring: peak (red) at top, then blue → green → yellow clockwise */
  graphics_context_set_fill_color(ctx, GColorRed);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, stroke,
                       dial_to_pebble_angle(-45), dial_to_pebble_angle(45));
  graphics_context_set_fill_color(ctx, GColorVividCerulean);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, stroke,
                       dial_to_pebble_angle(45), dial_to_pebble_angle(135));
  graphics_context_set_fill_color(ctx, GColorIslamicGreen);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, stroke,
                       dial_to_pebble_angle(135), dial_to_pebble_angle(225));
  graphics_context_set_fill_color(ctx, GColorChromeYellow);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, stroke,
                       dial_to_pebble_angle(225), dial_to_pebble_angle(315));
#else
  graphics_context_set_stroke_color(ctx, afw_theme_fg());
  graphics_context_set_stroke_width(ctx, stroke);
  graphics_draw_circle(ctx, GPoint(cx, cy), r);
#endif

  graphics_context_set_stroke_width(ctx, 2);
  graphics_context_set_stroke_color(ctx, afw_theme_muted());
  graphics_draw_circle(ctx, GPoint(cx, cy), hub_r);

  /* Marker: 0° = top, clockwise */
  const int32_t pebble_angle = dial_to_pebble_angle((int)st->dial_angle);
  const int mx = cx + (cos_lookup(pebble_angle) * r / TRIG_MAX_RATIO);
  const int my = cy + (sin_lookup(pebble_angle) * r / TRIG_MAX_RATIO);
  graphics_context_set_fill_color(ctx, afw_theme_fg());
  graphics_fill_circle(ctx, GPoint(mx, my), PBL_IF_ROUND_ELSE(5, 4));
  graphics_context_set_stroke_color(ctx, afw_theme_bg());
  graphics_context_set_stroke_width(ctx, 1);
  graphics_draw_circle(ctx, GPoint(mx, my), PBL_IF_ROUND_ELSE(5, 4));
}

static void bar_update(Layer *layer, GContext *ctx) {
  AfwState *st = afw_state();
  GRect b = layer_get_bounds(layer);
  const int pad = 4;
  const int y = b.origin.y + b.size.h / 2 - 3;
  const int x0 = b.origin.x + pad;
  const int w = b.size.w - pad * 2;
  graphics_context_set_fill_color(ctx, afw_theme_muted());
  graphics_fill_rect(ctx, GRect(x0, y, w, 6), 2, GCornersAll);

  if (st->bar_price < 0 || st->bar_high <= st->bar_low) return;
  int pct = afw_rank_pct(st->bar_price, st->bar_low, st->bar_high);
  int mx = x0 + (w * pct) / 100;
  graphics_context_set_fill_color(ctx, afw_rank_color(pct));
  graphics_fill_circle(ctx, GPoint(mx, y + 3), 5);
}

static void graph_update(Layer *layer, GContext *ctx) {
  AfwState *st = afw_state();
  GRect b = layer_get_bounds(layer);
  graphics_context_set_stroke_color(ctx, afw_theme_fg());
  graphics_context_set_stroke_width(ctx, 1);
  graphics_draw_rect(ctx, b);

  if (st->graph_n < 2 || st->graph_max <= st->graph_min) return;
  const int pad = 4;
  const int gw = b.size.w - pad * 2;
  const int gh = b.size.h - pad * 2;
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorCyan, afw_theme_fg()));
  graphics_context_set_stroke_width(ctx, 2);
  GPoint prev;
  for (int i = 0; i < st->graph_n; i++) {
    int x = b.origin.x + pad + (i * gw) / (st->graph_n - 1);
    int y = b.origin.y + pad + gh - (st->graph_pts[i] * gh) / 255;
    GPoint p = GPoint(x, y);
    if (i > 0) graphics_draw_line(ctx, prev, p);
    prev = p;
  }
}

static void format_price(char *buf, size_t n, int32_t tenths) {
  if (tenths < 0) {
    snprintf(buf, n, "--");
    return;
  }
  snprintf(buf, n, "%d.%d c", (int)(tenths / 10), (int)(tenths % 10));
}

static int parse_int(const char *s) {
  int v = 0;
  int neg = 0;
  if (*s == '-') { neg = 1; s++; }
  while (*s >= '0' && *s <= '9') {
    v = v * 10 + (*s - '0');
    s++;
  }
  return neg ? -v : v;
}

static void refresh_main_texts(void) {
  AfwState *st = afw_state();
  static char title_buf[AFW_TITLE_LEN];
  snprintf(title_buf, sizeof(title_buf), "%s", st->title);
  text_layer_set_text(s_title_layer, title_buf);

  static char dial_buf[32];
  snprintf(dial_buf, sizeof(dial_buf), "%s", st->dial_label);
  text_layer_set_text(s_dial_label_layer, dial_buf);

  static char best_buf[80];
  char price[24];
  format_price(price, sizeof(price), st->best_price);
  snprintf(best_buf, sizeof(best_buf), "Best %s\n%s", price, st->best_name);
  text_layer_set_text(s_best_layer, best_buf);

  static char cmp_buf[AFW_COMPARE_LEN];
  snprintf(cmp_buf, sizeof(cmp_buf), "%s", st->compare_line);
  text_layer_set_text(s_compare_layer, cmp_buf);

  static char asof_buf[40];
  if (st->stale) {
    snprintf(asof_buf, sizeof(asof_buf), "Cached %s", st->as_of);
  } else {
    snprintf(asof_buf, sizeof(asof_buf), "%s", st->as_of);
  }
  text_layer_set_text(s_asof_layer, asof_buf);

  layer_mark_dirty(s_dial_layer);
  layer_mark_dirty(s_bar_layer);
}

static void refresh_graph_texts(void) {
  AfwState *st = afw_state();
  static char t[48];
  if (s_graph_screen == SCREEN_GRAPH_STATION) {
    snprintf(t, sizeof(t), "Station - %s", st->fuel);
  } else {
    snprintf(t, sizeof(t), "Scope mean - %s", st->fuel);
  }
  text_layer_set_text(s_graph_title_layer, t);
  layer_mark_dirty(s_graph_layer);
}

/* Minimal list JSON: [{"p":1799,"n":"Name"},...] prices tenths */
static void refresh_list_texts(void) {
  AfwState *st = afw_state();
  static char title[40];
  const char *kind = "List";
  if (s_list_screen == SCREEN_LIST_FAVS) kind = "Favs top 5";
  else if (s_list_screen == SCREEN_LIST_SUBURB) kind = "Suburb top 5";
  else if (s_list_screen == SCREEN_LIST_SCOPE) kind = "Scope top 5";
  else if (s_list_screen == SCREEN_LIST_GPS) kind = "Near me";
  snprintf(title, sizeof(title), "%s", kind);
  text_layer_set_text(s_list_title_layer, title);

  static char body[480];
  body[0] = '\0';
  const char *json = st->list_json;
  if (!json[0]) {
    snprintf(body, sizeof(body), "No stations.\n(Swipe/back)");
  } else {
    /* Very small parser: find "n":" and "p": */
    int count = 0;
    const char *p = json;
    while (count < AFW_LIST_MAX && (p = strstr(p, "\"p\":")) != NULL) {
      int price = parse_int(p + 4);
      const char *np = strstr(p, "\"n\":\"");
      char name[36] = "?";
      if (np) {
        np += 5;
        size_t i = 0;
        while (*np && *np != '"' && i < sizeof(name) - 1) name[i++] = *np++;
        name[i] = '\0';
      }
      char line[64];
      char pr[16];
      format_price(pr, sizeof(pr), price);
      snprintf(line, sizeof(line), "%s  %s\n", pr, name);
      if (strlen(body) + strlen(line) < sizeof(body) - 1) strcat(body, line);
      count++;
      p += 4;
    }
    if (!count) snprintf(body, sizeof(body), "%s", json);
  }
  text_layer_set_text(s_list_body_layer, body);
}

void afw_ui_refresh(void) {
  if (s_screen == SCREEN_MAIN) refresh_main_texts();
  else if (s_screen == SCREEN_GRAPH_STATE || s_screen == SCREEN_GRAPH_STATION) refresh_graph_texts();
  else refresh_list_texts();
}

/* ---- navigation ---- */

static void show_main(void) {
  s_screen = SCREEN_MAIN;
  if (window_stack_contains_window(s_graph_window)) window_stack_remove(s_graph_window, true);
  if (window_stack_contains_window(s_list_window)) window_stack_remove(s_list_window, true);
  if (!window_stack_contains_window(s_main_window)) {
    window_stack_push(s_main_window, true);
  }
  afw_ui_refresh();
}

static void show_graph(int which) {
  s_graph_screen = which;
  s_screen = which;
  afw_comm_request(which == SCREEN_GRAPH_STATION ? "graph_station" : "graph_state");
  if (!window_stack_contains_window(s_graph_window)) {
    window_stack_push(s_graph_window, true);
  }
  afw_ui_refresh();
}

static void show_list(int which) {
  s_list_screen = which;
  s_screen = which;
  const char *req = "list_favs";
  if (which == SCREEN_LIST_SUBURB) req = "list_suburb";
  else if (which == SCREEN_LIST_SCOPE) req = "list_scope";
  else if (which == SCREEN_LIST_GPS) req = "list_gps";
  afw_comm_request(req);
  if (!window_stack_contains_window(s_list_window)) {
    window_stack_push(s_list_window, true);
  }
  afw_ui_refresh();
}

void afw_nav_up(void) {
  if (s_screen == SCREEN_MAIN) {
    show_graph(SCREEN_GRAPH_STATE);
  } else if (s_screen == SCREEN_GRAPH_STATE) {
    show_graph(SCREEN_GRAPH_STATION);
  } else if (s_screen == SCREEN_GRAPH_STATION) {
    /* stay */
  } else {
    afw_nav_back();
  }
}

void afw_nav_down(void) {
  if (s_screen == SCREEN_MAIN) {
    show_list(SCREEN_LIST_FAVS);
  } else if (s_screen == SCREEN_LIST_FAVS) {
    show_list(SCREEN_LIST_SUBURB);
  } else if (s_screen == SCREEN_LIST_SUBURB) {
    show_list(SCREEN_LIST_SCOPE);
  } else if (s_screen == SCREEN_GRAPH_STATE || s_screen == SCREEN_GRAPH_STATION) {
    afw_nav_back();
  }
}

void afw_nav_select(void) {
  if (s_screen == SCREEN_MAIN) {
    show_list(SCREEN_LIST_GPS);
  }
}

void afw_nav_back(void) {
  if (s_screen == SCREEN_GRAPH_STATION) {
    show_graph(SCREEN_GRAPH_STATE);
  } else if (s_screen == SCREEN_GRAPH_STATE || s_screen == SCREEN_LIST_GPS ||
             s_screen == SCREEN_LIST_SCOPE || s_screen == SCREEN_LIST_SUBURB ||
             s_screen == SCREEN_LIST_FAVS) {
    show_main();
  }
}

static void click_up(ClickRecognizerRef recognizer, void *context) { afw_nav_up(); }
static void click_down(ClickRecognizerRef recognizer, void *context) { afw_nav_down(); }
static void click_select(ClickRecognizerRef recognizer, void *context) { afw_nav_select(); }
static void click_back(ClickRecognizerRef recognizer, void *context) { afw_nav_back(); }

static void click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, click_up);
  window_single_click_subscribe(BUTTON_ID_DOWN, click_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, click_select);
  window_single_click_subscribe(BUTTON_ID_BACK, click_back);
}

/* Touch parity on Round (chalk): tap=Select, swipe up/down=Up/Down, swipe left=Back.
 * SDK 4.33 stubs touch_service_*; handlers stay wired for when the API is live. */
#if defined(PBL_PLATFORM_CHALK)
static GPoint s_touch_start;
static bool s_touch_armed;

static void touch_handler(const TouchEvent *event, void *context) {
  (void)context;
  if (!event) return;
  if (event->type == TouchEvent_Touchdown) {
    s_touch_start = GPoint(event->x, event->y);
    s_touch_armed = true;
    return;
  }
  if (event->type != TouchEvent_Liftoff || !s_touch_armed) return;
  s_touch_armed = false;
  if (event->non_navigational) return;
  const int dx = (int)event->x - s_touch_start.x;
  const int dy = (int)event->y - s_touch_start.y;
  const int adx = dx < 0 ? -dx : dx;
  const int ady = dy < 0 ? -dy : dy;
  if (adx < 12 && ady < 12) {
    afw_nav_select();
    return;
  }
  if (ady >= adx) {
    if (dy < 0) afw_nav_up();
    else afw_nav_down();
  } else if (dx < 0) {
    afw_nav_back();
  } else {
    afw_nav_select();
  }
}
#endif

static TextLayer *make_text(Window *w, GRect r, const char *font, GTextAlignment a) {
  TextLayer *tl = text_layer_create(r);
  text_layer_set_text_color(tl, afw_theme_fg());
  text_layer_set_background_color(tl, GColorClear);
  text_layer_set_font(tl, fonts_get_system_font(font));
  text_layer_set_text_alignment(tl, a);
  text_layer_set_overflow_mode(tl, GTextOverflowModeTrailingEllipsis);
  layer_add_child(window_get_root_layer(w), text_layer_get_layer(tl));
  return tl;
}

void afw_ui_apply_theme(void) {
  GColor bg = afw_theme_bg();
  GColor fg = afw_theme_fg();
  if (s_main_window) window_set_background_color(s_main_window, bg);
  if (s_graph_window) window_set_background_color(s_graph_window, bg);
  if (s_list_window) window_set_background_color(s_list_window, bg);
  if (s_title_layer) text_layer_set_text_color(s_title_layer, fg);
  if (s_dial_label_layer) text_layer_set_text_color(s_dial_label_layer, fg);
  if (s_best_layer) text_layer_set_text_color(s_best_layer, fg);
  if (s_compare_layer) text_layer_set_text_color(s_compare_layer, fg);
  if (s_asof_layer) text_layer_set_text_color(s_asof_layer, fg);
  if (s_graph_title_layer) text_layer_set_text_color(s_graph_title_layer, fg);
  if (s_list_title_layer) text_layer_set_text_color(s_list_title_layer, fg);
  if (s_list_body_layer) text_layer_set_text_color(s_list_body_layer, fg);
  if (s_dial_layer) layer_mark_dirty(s_dial_layer);
  if (s_bar_layer) layer_mark_dirty(s_bar_layer);
  if (s_graph_layer) layer_mark_dirty(s_graph_layer);
}

static void main_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
#if defined(PBL_ROUND)
  const int top = 22;
  const int dial_h = 90;
#else
  const int top = 2;
  const int dial_h = 78;
#endif
  s_title_layer = make_text(window, GRect(4, top, b.size.w - 8, 36),
                            FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter);
  s_dial_layer = layer_create(GRect(0, top + 34, b.size.w, dial_h));
  layer_set_update_proc(s_dial_layer, dial_update);
  layer_add_child(root, s_dial_layer);

  s_dial_label_layer = make_text(window, GRect(4, top + 34 + dial_h - 2, b.size.w - 8, 18),
                                 FONT_KEY_GOTHIC_14, GTextAlignmentCenter);
  s_bar_layer = layer_create(GRect(8, top + 34 + dial_h + 16, b.size.w - 16, 14));
  layer_set_update_proc(s_bar_layer, bar_update);
  layer_add_child(root, s_bar_layer);

  s_best_layer = make_text(window, GRect(4, top + 34 + dial_h + 30, b.size.w - 8, 36),
                           FONT_KEY_GOTHIC_14, GTextAlignmentCenter);
  s_compare_layer = make_text(window, GRect(4, top + 34 + dial_h + 64, b.size.w - 8, 18),
                              FONT_KEY_GOTHIC_14, GTextAlignmentCenter);
  s_asof_layer = make_text(window, GRect(4, b.size.h - 18, b.size.w - 8, 16),
                           FONT_KEY_GOTHIC_14, GTextAlignmentCenter);

  refresh_main_texts();
}

static void main_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_dial_label_layer);
  text_layer_destroy(s_best_layer);
  text_layer_destroy(s_compare_layer);
  text_layer_destroy(s_asof_layer);
  layer_destroy(s_dial_layer);
  layer_destroy(s_bar_layer);
}

static void graph_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  s_graph_title_layer = make_text(window, GRect(4, PBL_IF_ROUND_ELSE(20, 2), b.size.w - 8, 22),
                                  FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter);
  s_graph_layer = layer_create(GRect(8, PBL_IF_ROUND_ELSE(48, 28), b.size.w - 16, b.size.h - PBL_IF_ROUND_ELSE(70, 40)));
  layer_set_update_proc(s_graph_layer, graph_update);
  layer_add_child(root, s_graph_layer);
  refresh_graph_texts();
}

static void graph_unload(Window *window) {
  text_layer_destroy(s_graph_title_layer);
  layer_destroy(s_graph_layer);
}

static void list_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  s_list_title_layer = make_text(window, GRect(4, PBL_IF_ROUND_ELSE(20, 2), b.size.w - 8, 22),
                                 FONT_KEY_GOTHIC_18_BOLD, GTextAlignmentCenter);
  s_list_body_layer = make_text(window, GRect(6, PBL_IF_ROUND_ELSE(48, 28), b.size.w - 12, b.size.h - PBL_IF_ROUND_ELSE(64, 36)),
                                FONT_KEY_GOTHIC_14, GTextAlignmentLeft);
  refresh_list_texts();
}

static void list_unload(Window *window) {
  text_layer_destroy(s_list_title_layer);
  text_layer_destroy(s_list_body_layer);
}

void afw_ui_init(void) {
  s_main_window = window_create();
  window_set_background_color(s_main_window, afw_theme_bg());
  window_set_window_handlers(s_main_window, (WindowHandlers){
    .load = main_load,
    .unload = main_unload,
  });
  window_set_click_config_provider(s_main_window, click_config);

  s_graph_window = window_create();
  window_set_background_color(s_graph_window, afw_theme_bg());
  window_set_window_handlers(s_graph_window, (WindowHandlers){
    .load = graph_load,
    .unload = graph_unload,
  });
  window_set_click_config_provider(s_graph_window, click_config);

  s_list_window = window_create();
  window_set_background_color(s_list_window, afw_theme_bg());
  window_set_window_handlers(s_list_window, (WindowHandlers){
    .load = list_load,
    .unload = list_unload,
  });
  window_set_click_config_provider(s_list_window, click_config);

#if defined(PBL_PLATFORM_CHALK)
  /* Keep handler referenced even when touch_service_subscribe is a stub macro. */
  TouchServiceHandler touch_cb = touch_handler;
  (void)touch_service_subscribe(touch_cb, NULL);
  (void)touch_cb;
#endif

  window_stack_push(s_main_window, true);
}

void afw_ui_deinit(void) {
#if defined(PBL_PLATFORM_CHALK)
  (void)touch_service_unsubscribe();
#endif
  window_destroy(s_main_window);
  window_destroy(s_graph_window);
  window_destroy(s_list_window);
}
