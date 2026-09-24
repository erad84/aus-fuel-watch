#include "afw.h"

/* graphics_fill_radial / gpoint_from_polar: 0° = top, clockwise. */

static Window *s_main_window;
static Window *s_graph_window;
static Window *s_list_window;

static TextLayer *s_title_layer;
static TextLayer *s_dial_label_layer;
static Layer *s_best_block_layer;
static TextLayer *s_asof_layer;
static Layer *s_dial_layer;
static Layer *s_main_hint_layer;

static TextLayer *s_graph_title_layer;
static Layer *s_graph_layer;
static Layer *s_graph_hint_layer;

static Layer *s_list_title_layer;
static Layer *s_list_body_layer;
static Layer *s_list_hint_layer;
static char s_list_title_buf[AFW_LIST_TITLE_LEN];

static int s_screen = SCREEN_MAIN;
static int s_list_screen = SCREEN_LIST_FAVS;

static bool s_hint_up = false;
static bool s_hint_down = false;
static bool s_hint_select = false;

typedef struct {
  char price[24];
  char win[12]; /* e.g. " 2.3%" — drawn non-bold after price/fuel */
  char name[AFW_LIST_NAME_LEN];
} ListRow;
static ListRow s_list_rows[AFW_LIST_MAX];
static int s_list_row_count = 0;
static AppTimer *s_marquee_timer = NULL;
static int s_marquee_tick = 0;

#if defined(PBL_PLATFORM_EMERY)
#define AFW_FONT_TITLE FONT_KEY_GOTHIC_18_BOLD
#define AFW_FONT_BODY FONT_KEY_GOTHIC_18
#define AFW_FONT_SMALL FONT_KEY_GOTHIC_14
#else
#define AFW_FONT_TITLE FONT_KEY_GOTHIC_14_BOLD
#define AFW_FONT_BODY FONT_KEY_GOTHIC_14
#define AFW_FONT_SMALL FONT_KEY_GOTHIC_14
#endif

static void format_price(char *buf, size_t n, int32_t tenths) {
  if (tenths < 0) {
    snprintf(buf, n, "--");
    return;
  }
  snprintf(buf, n, "%d.%d c", (int)(tenths / 10), (int)(tenths % 10));
}

static void format_price_fuel(char *buf, size_t n, int32_t tenths, const char *fuel) {
  if (tenths < 0) {
    snprintf(buf, n, "--");
    return;
  }
  if (fuel && fuel[0]) {
    snprintf(buf, n, "%d.%d - %s", (int)(tenths / 10), (int)(tenths % 10), fuel);
  } else {
    format_price(buf, n, tenths);
  }
}

static void format_price_cpl(char *buf, size_t n, int32_t tenths) {
  if (tenths < 0) {
    snprintf(buf, n, "-- c/L");
    return;
  }
  snprintf(buf, n, "%d.%d c/L", (int)(tenths / 10), (int)(tenths % 10));
}

static int parse_int(const char *s) {
  int v = 0;
  int neg = 0;
  if (*s == '-') {
    neg = 1;
    s++;
  }
  while (*s >= '0' && *s <= '9') {
    v = v * 10 + (*s - '0');
    s++;
  }
  return neg ? -v : v;
}

static void fill_tri(GContext *ctx, GPoint a, GPoint b, GPoint c) {
  GPoint pts[3] = {a, b, c};
  GPathInfo info = {.num_points = 3, .points = pts};
  GPath *path = gpath_create(&info);
  graphics_context_set_fill_color(ctx, afw_theme_fg());
  gpath_draw_filled(ctx, path);
  gpath_destroy(path);
}

static bool can_nav_up(void) {
  switch (s_screen) {
    case SCREEN_MAIN:
    case SCREEN_LIST_FAVS:
    case SCREEN_LIST_SUBURB:
    case SCREEN_LIST_SCOPE:
      return true;
    default:
      return false;
  }
}

static bool can_nav_down(void) {
  switch (s_screen) {
    case SCREEN_MAIN:
    case SCREEN_LIST_FAVS:
    case SCREEN_LIST_SUBURB:
    case SCREEN_GRAPH:
      return true;
    default:
      return false;
  }
}

static bool can_nav_select(void) {
  return s_screen == SCREEN_MAIN;
}

static void hints_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
#if defined(PBL_ROUND)
  const int cx = b.size.w - 28;
  const int up_y = 28;
  const int down_y = b.size.h - 28;
  const int mid_y = b.size.h / 2;
  const int half = 6;
#else
  const int cx = b.size.w - 14;
  const int up_y = 16;
  const int down_y = b.size.h - 16;
  const int mid_y = b.size.h / 2;
  const int half = 6;
#endif
  if (s_hint_up) {
    fill_tri(ctx, GPoint(cx, up_y - half), GPoint(cx - half, up_y + half),
             GPoint(cx + half, up_y + half));
  }
  if (s_hint_down) {
    fill_tri(ctx, GPoint(cx, down_y + half), GPoint(cx - half, down_y - half),
             GPoint(cx + half, down_y - half));
  }
  if (s_hint_select) {
    /* Right-pointing chevron beside Select */
    fill_tri(ctx, GPoint(cx + half, mid_y), GPoint(cx - half, mid_y - half),
             GPoint(cx - half, mid_y + half));
  }
}

static void update_nav_hints(void) {
  s_hint_up = can_nav_up();
  s_hint_down = can_nav_down();
  s_hint_select = can_nav_select();
  if (s_main_hint_layer) layer_mark_dirty(s_main_hint_layer);
  if (s_graph_hint_layer) layer_mark_dirty(s_graph_hint_layer);
  if (s_list_hint_layer) layer_mark_dirty(s_list_hint_layer);
}

/* Stacked digits for graph Y-axis. */
static void draw_vert_label(GContext *ctx, const char *s, int x, int y_mid, GFont font,
                            bool bottom_to_top) {
  if (!s || !s[0]) return;
  int len = (int)strlen(s);
  const int lh = 11;
  int total = len * lh;
  int y0 = y_mid - total / 2;
  char ch[2] = {0, 0};
  for (int i = 0; i < len; i++) {
    int idx = bottom_to_top ? (len - 1 - i) : i;
    ch[0] = s[idx];
    graphics_draw_text(ctx, ch, font, GRect(x, y0 + i * lh, 11, lh),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
}

static void dial_update(Layer *layer, GContext *ctx) {
  AfwState *st = afw_state();
  GRect b = layer_get_bounds(layer);
  GFont small = fonts_get_system_font(AFW_FONT_SMALL);
  const int label_h = 12;
  const int peak_gap = 8; /* Peak further above the ring */
  const int side_w = 44;   /* horizontal Rising/Falling */

  graphics_context_set_text_color(ctx, afw_theme_is_light() ? GColorBlack : GColorWhite);

  /* Pack Peak + ring + Bottom; Peak sits at top of dial layer */
  const int ring_top = b.origin.y + label_h + peak_gap;
  const int ring_bot = b.origin.y + b.size.h - label_h;
  const int cx = b.origin.x + b.size.w / 2;
  const int cy = (ring_top + ring_bot) / 2;
  const int max_r_w = b.size.w / 2 - side_w - 1;
  const int max_r_h = (ring_bot - ring_top) / 2;
  int r = (max_r_w < max_r_h ? max_r_w : max_r_h);
  r = (r * 90) / 100; /* ~10% smaller */
  if (r < 20) r = 20;
  const int stroke = PBL_IF_ROUND_ELSE(9, 8);
  const int hub_r = (r * 14) / 62;
  GRect ring = GRect(cx - r, cy - r, r * 2, r * 2);

  /* Peak at top of dial layer (further from ring) */
  graphics_draw_text(ctx, "Peak", small, GRect(b.origin.x, b.origin.y, b.size.w, label_h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  /* Bottom just below ring */
  graphics_draw_text(ctx, "Bottom", small, GRect(b.origin.x, cy + r + 1, b.size.w, label_h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

  /* Horizontal side labels tucked against the ring */
  graphics_draw_text(ctx, "Rising", small, GRect(cx - r - side_w, cy - 7, side_w - 2, 14),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  graphics_draw_text(ctx, "Falling", small, GRect(cx + r + 2, cy - 7, side_w - 2, 14),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

#if defined(PBL_COLOR)
  graphics_context_set_fill_color(ctx, GColorRed);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, stroke, DEG_TO_TRIGANGLE(315),
                       DEG_TO_TRIGANGLE(360));
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, stroke, DEG_TO_TRIGANGLE(0),
                       DEG_TO_TRIGANGLE(45));
  graphics_context_set_fill_color(ctx, GColorVividCerulean);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, stroke, DEG_TO_TRIGANGLE(45),
                       DEG_TO_TRIGANGLE(135));
  graphics_context_set_fill_color(ctx, GColorIslamicGreen);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, stroke, DEG_TO_TRIGANGLE(135),
                       DEG_TO_TRIGANGLE(225));
  graphics_context_set_fill_color(ctx, GColorChromeYellow);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, stroke, DEG_TO_TRIGANGLE(225),
                       DEG_TO_TRIGANGLE(315));

  if (st->outlook_dir > 0 && st->outlook_str > 0) {
    const int strength = st->outlook_str > 100 ? 100 : (int)st->outlook_str;
    /* Inner edge of outer ring — fill grows inward from there, not mid-stroke */
    const int r_inner = r - stroke;
    const int gap = r_inner - hub_r;
    const int fill = (gap * strength) / 100;
    if (fill > 1 && r_inner > hub_r) {
      GRect glow = GRect(cx - r_inner, cy - r_inner, r_inner * 2, r_inner * 2);
      /* One shade lighter than outer Rising/Falling ring colours */
      GColor gc = (st->outlook_dir == 1) ? GColorPictonBlue : GColorIcterine;
      graphics_context_set_fill_color(ctx, gc);
      if (st->outlook_dir == 1) {
        graphics_fill_radial(ctx, glow, GOvalScaleModeFitCircle, fill, DEG_TO_TRIGANGLE(45),
                             DEG_TO_TRIGANGLE(135));
      } else {
        graphics_fill_radial(ctx, glow, GOvalScaleModeFitCircle, fill, DEG_TO_TRIGANGLE(225),
                             DEG_TO_TRIGANGLE(315));
      }
    }
  }
#else
  graphics_context_set_stroke_color(ctx, afw_theme_fg());
  graphics_context_set_stroke_width(ctx, stroke);
  graphics_draw_circle(ctx, GPoint(cx, cy), r);
#endif

  graphics_context_set_stroke_width(ctx, 2);
  graphics_context_set_stroke_color(ctx, afw_theme_muted());
  graphics_draw_circle(ctx, GPoint(cx, cy), hub_r);

  int dial_deg = (int)st->dial_angle % 360;
  if (dial_deg < 0) dial_deg += 360;
  /* Pip on stroke mid-radius (outer edge looked too far out) */
  const int r_pip = r - stroke / 2;
  GRect pip_ring = GRect(cx - r_pip, cy - r_pip, r_pip * 2, r_pip * 2);
  GPoint marker = gpoint_from_polar(pip_ring, GOvalScaleModeFitCircle, DEG_TO_TRIGANGLE(dial_deg));
  const int mr = PBL_IF_ROUND_ELSE(5, 4);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_circle(ctx, marker, mr);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_context_set_stroke_width(ctx, 2);
  graphics_draw_circle(ctx, marker, mr);
}

static void draw_series(GContext *ctx, GRect plot, const uint8_t *pts, int n, GColor color) {
  if (n < 2) return;
  graphics_context_set_stroke_color(ctx, color);
  graphics_context_set_stroke_width(ctx, 2);
  GPoint prev;
  bool have = false;
  for (int i = 0; i < n; i++) {
    if (pts[i] == 255) {
      continue; /* join across gaps */
    }
    int x = plot.origin.x + (i * plot.size.w) / (n - 1);
    int y = plot.origin.y + plot.size.h - (pts[i] * plot.size.h) / 254;
    GPoint p = GPoint(x, y);
    if (have) graphics_draw_line(ctx, prev, p);
    prev = p;
    have = true;
  }
}

static int marquee_offset(const char *text, int max_chars) {
  int len = (int)strlen(text);
  if (len <= max_chars) return 0;
  int travel = len - max_chars;
  int cycle = travel * 2 + 24; /* longer pauses than list (was +16) */
  int t = s_marquee_tick % cycle;
  int off;
  if (t < 12)
    off = 0;
  else if (t < 12 + travel)
    off = t - 12;
  else if (t < 12 + travel + 12)
    off = travel;
  else
    off = travel - (t - (12 + travel + 12));
  if (off < 0) off = 0;
  if (off > travel) off = travel;
  return off;
}

static void draw_marqueed_text(GContext *ctx, const char *text, GFont font, GRect box,
                               int max_chars) {
  if (!text || !text[0]) return;
  int len = (int)strlen(text);
  if (max_chars < 4) max_chars = 4;
  if (len <= max_chars) {
    graphics_draw_text(ctx, text, font, box, GTextOverflowModeTrailingEllipsis,
                       GTextAlignmentLeft, NULL);
    return;
  }
  int off = marquee_offset(text, max_chars);
  char slice[48];
  int n = max_chars;
  if (n > (int)sizeof(slice) - 1) n = (int)sizeof(slice) - 1;
  memcpy(slice, text + off, (size_t)n);
  slice[n] = '\0';
  graphics_draw_text(ctx, slice, font, box, GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft,
                     NULL);
}

static int text_pixel_w(GFont font, const char *s) {
  if (!s || !s[0]) return 0;
  GSize sz = graphics_text_layout_get_content_size(
      s, font, GRect(0, 0, 2000, 40), GTextOverflowModeWordWrap, GTextAlignmentLeft);
  return sz.w;
}

/** Longest prefix of text that fits in width (pixel-accurate). */
static int max_chars_fitting(GFont font, const char *text, int width) {
  int len = (int)strlen(text);
  if (len <= 0 || width <= 0) return 0;
  if (text_pixel_w(font, text) <= width) return len;
  int lo = 1, hi = len;
  if (hi > 47) hi = 47;
  char slice[48];
  while (lo < hi) {
    int mid = (lo + hi + 1) / 2;
    memcpy(slice, text, (size_t)mid);
    slice[mid] = '\0';
    if (text_pixel_w(font, slice) <= width)
      lo = mid;
    else
      hi = mid - 1;
  }
  if (lo < 4) lo = 4;
  if (lo > len) lo = len;
  return lo;
}

static void draw_marqueed_text_fit(GContext *ctx, const char *text, GFont font, GRect box,
                                   GTextAlignment align_when_fits) {
  if (!text || !text[0]) return;
  if (text_pixel_w(font, text) <= box.size.w) {
    graphics_draw_text(ctx, text, font, box, GTextOverflowModeTrailingEllipsis, align_when_fits,
                       NULL);
    return;
  }
  int max_chars = max_chars_fitting(font, text, box.size.w);
  draw_marqueed_text(ctx, text, font, box, max_chars);
}

/** Bold price (+ optional fuel), then non-bold win% if present; marquee only if combined overflows. */
static void draw_price_win_row(GContext *ctx, const char *price, const char *win, GFont bold,
                               GFont body, GRect box) {
  if (!price || !price[0]) return;
  int win_w = (win && win[0]) ? text_pixel_w(body, win) : 0;
  int price_w = text_pixel_w(bold, price);
  if (price_w + win_w <= box.size.w) {
    graphics_draw_text(ctx, price, bold, box, GTextOverflowModeTrailingEllipsis,
                       GTextAlignmentLeft, NULL);
    if (win_w > 0) {
      graphics_draw_text(ctx, win, body,
                         GRect(box.origin.x + price_w, box.origin.y, win_w + 2, box.size.h),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    }
    return;
  }
  /* Overflow: marquee the price part in remaining width after win% (keep win visible if possible) */
  int price_box_w = box.size.w - win_w;
  if (price_box_w < 24) price_box_w = box.size.w;
  draw_marqueed_text_fit(ctx, price, bold, GRect(box.origin.x, box.origin.y, price_box_w, box.size.h),
                         GTextAlignmentLeft);
  if (win && win[0] && win_w > 0 && price_box_w < box.size.w) {
    graphics_draw_text(ctx, win, body,
                       GRect(box.origin.x + price_box_w, box.origin.y, win_w + 2, box.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
}

static void graph_update(Layer *layer, GContext *ctx) {
  AfwState *st = afw_state();
  GRect b = layer_get_bounds(layer);
  const int pad_l = 14;
  const int pad_r = 4;
  const int pad_t = 20; /* room for legend */
  const int pad_b = 20; /* dates under plot; room for descenders */
  GRect plot = GRect(b.origin.x + pad_l, b.origin.y + pad_t, b.size.w - pad_l - pad_r,
                     b.size.h - pad_t - pad_b);

  GFont small = fonts_get_system_font(AFW_FONT_SMALL);
  GFont axis = fonts_get_system_font(AFW_FONT_TITLE);
  GColor ink = afw_theme_is_light() ? GColorBlack : GColorWhite;
  graphics_context_set_text_color(ctx, ink);

  /* Legend: state (blue) + station (red); line vertically centered on text */
  int lx = plot.origin.x;
  int ly = b.origin.y + 1;
  const int legend_h = 14;
  const int line_y = ly + legend_h / 2;
  if (st->graph_legend0[0]) {
#if defined(PBL_COLOR)
    graphics_context_set_stroke_color(ctx, GColorOxfordBlue);
#else
    graphics_context_set_stroke_color(ctx, afw_theme_fg());
#endif
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_line(ctx, GPoint(lx, line_y), GPoint(lx + 10, line_y));
    graphics_context_set_text_color(ctx, ink);
    draw_marqueed_text(ctx, st->graph_legend0, small, GRect(lx + 12, ly, 70, legend_h), 10);
    lx += 84;
  }
  if (st->graph_legend1[0]) {
#if defined(PBL_COLOR)
    graphics_context_set_stroke_color(ctx, GColorRed);
#else
    graphics_context_set_stroke_color(ctx, afw_theme_muted());
#endif
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_line(ctx, GPoint(lx, line_y), GPoint(lx + 10, line_y));
    graphics_context_set_text_color(ctx, ink);
    draw_marqueed_text(ctx, st->graph_legend1, small, GRect(lx + 12, ly, 70, legend_h), 10);
  }

  graphics_context_set_stroke_color(ctx, afw_theme_fg());
  graphics_context_set_stroke_width(ctx, 1);
  graphics_draw_rect(ctx, plot);

  if (st->graph_max > st->graph_min) {
    int32_t gmin = st->graph_min;
    int32_t gmax = st->graph_max;
    int32_t first = ((gmin + 99) / 100) * 100;
    graphics_context_set_stroke_color(ctx, afw_theme_muted());
    graphics_context_set_stroke_width(ctx, 1);
    for (int32_t v = first; v < gmax; v += 100) {
      int y = plot.origin.y +
              plot.size.h - (int)(((v - gmin) * plot.size.h) / (gmax - gmin));
      graphics_draw_line(ctx, GPoint(plot.origin.x + 1, y),
                         GPoint(plot.origin.x + plot.size.w - 1, y));
    }
  }

  char ymax[16];
  char ymin[16];
  if (st->graph_max < 0)
    snprintf(ymax, sizeof(ymax), "--");
  else
    snprintf(ymax, sizeof(ymax), "%d", (int)(st->graph_max / 10));
  if (st->graph_min < 0)
    snprintf(ymin, sizeof(ymin), "--");
  else
    snprintf(ymin, sizeof(ymin), "%d", (int)(st->graph_min / 10));
  graphics_context_set_text_color(ctx, ink);
  draw_vert_label(ctx, ymax, b.origin.x, plot.origin.y + 22, axis, false);
  draw_vert_label(ctx, ymin, b.origin.x, plot.origin.y + plot.size.h - 22, axis, false);

  if (st->graph_x0[0]) {
    graphics_draw_text(ctx, st->graph_x0, axis,
                       GRect(plot.origin.x, plot.origin.y + plot.size.h + 1, plot.size.w / 2, 16),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
  if (st->graph_x1[0]) {
    graphics_draw_text(
        ctx, st->graph_x1, axis,
        GRect(plot.origin.x + plot.size.w / 2, plot.origin.y + plot.size.h + 1, plot.size.w / 2, 16),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  }

  if (st->graph_n >= 2 && st->graph_max > st->graph_min) {
#if defined(PBL_COLOR)
    draw_series(ctx, plot, st->graph_pts, (int)st->graph_n, GColorOxfordBlue);
#else
    draw_series(ctx, plot, st->graph_pts, (int)st->graph_n, afw_theme_fg());
#endif
  }
  if (st->graph_n2 >= 2 && st->graph_max > st->graph_min) {
#if defined(PBL_COLOR)
    draw_series(ctx, plot, st->graph_pts2, (int)st->graph_n2, GColorRed);
#else
    draw_series(ctx, plot, st->graph_pts2, (int)st->graph_n2, afw_theme_muted());
#endif
  }
}

/* Measure text width for mixed-font header centering. */
static int text_w(GFont font, const char *s, int max_w) {
  if (!s || !s[0]) return 0;
  GSize sz = graphics_text_layout_get_content_size(
      s, font, GRect(0, 0, max_w, 24), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);
  return sz.w;
}

static void best_block_update(Layer *layer, GContext *ctx) {
  AfwState *st = afw_state();
  GRect b = layer_get_bounds(layer);
  GFont bold = fonts_get_system_font(AFW_FONT_TITLE);
  GFont body = fonts_get_system_font(AFW_FONT_BODY);
  graphics_context_set_text_color(ctx, afw_theme_fg());

  const int line_h = PBL_IF_ROUND_ELSE(20, 16);
  int y = b.origin.y;
  int max_w = b.size.w;

  /* Header: "{zone} Best Buy:" */
  char header[72];
  if (st->compare_line[0]) {
    snprintf(header, sizeof(header), "%s Best Buy:", st->compare_line);
  } else {
    snprintf(header, sizeof(header), "Best Buy:");
  }
  graphics_draw_text(ctx, header, bold, GRect(b.origin.x, y, max_w, line_h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  y += line_h;

  /* Price row: bold fuel, optional non-bold " 2.3%", middot, bold price */
  char fuel[12] = "";
  char pct[24] = "";
  if (st->best_line[0]) {
    if (strncmp(st->best_line, "Even", 4) == 0) {
      strncpy(fuel, "Even", sizeof(fuel) - 1);
      fuel[sizeof(fuel) - 1] = '\0';
    } else {
      const char *sp = strchr(st->best_line, ' ');
      if (sp && strchr(sp, '%')) {
        size_t fl = (size_t)(sp - st->best_line);
        if (fl >= sizeof(fuel)) fl = sizeof(fuel) - 1;
        memcpy(fuel, st->best_line, fl);
        fuel[fl] = '\0';
        /* Keep leading space so " 2.3%" sits tight after fuel */
        snprintf(pct, sizeof(pct), "%s", sp);
      } else {
        strncpy(fuel, st->best_line, sizeof(fuel) - 1);
        fuel[sizeof(fuel) - 1] = '\0';
      }
    }
  }

  char price_buf[24];
  format_price_cpl(price_buf, sizeof(price_buf), st->best_price);

  const char *dot = " \xC2\xB7 "; /* UTF-8 middle dot */
  int w_fuel = fuel[0] ? text_w(bold, fuel, max_w) : 0;
  int w_pct = pct[0] ? text_w(body, pct, max_w) : 0;
  int w_dot = fuel[0] ? text_w(body, dot, max_w) : 0;
  int w_price = text_w(bold, price_buf, max_w);
  int total = w_fuel + w_pct + w_dot + w_price;
  int x = b.origin.x + (max_w - total) / 2;
  if (x < b.origin.x) x = b.origin.x;

  if (fuel[0]) {
    graphics_draw_text(ctx, fuel, bold, GRect(x, y, w_fuel + 2, line_h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    x += w_fuel;
  }
  if (pct[0]) {
    graphics_draw_text(ctx, pct, body, GRect(x, y, w_pct + 2, line_h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    x += w_pct;
  }
  if (w_dot > 0) {
    graphics_draw_text(ctx, dot, body, GRect(x, y, w_dot + 2, line_h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    x += w_dot;
  }
  graphics_draw_text(ctx, price_buf, bold, GRect(x, y, max_w - (x - b.origin.x), line_h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  y += line_h;

  const char *name = st->best_name[0] ? st->best_name : "--";
  graphics_draw_text(ctx, name, bold, GRect(b.origin.x, y, max_w, line_h + 2),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void refresh_main_texts(void) {
  AfwState *st = afw_state();
  static char title_buf[AFW_TITLE_LEN];
  strncpy(title_buf, st->title, sizeof(title_buf) - 1);
  title_buf[sizeof(title_buf) - 1] = '\0';
  text_layer_set_text(s_title_layer, title_buf);

  static char dial_buf[AFW_LABEL_LEN];
  strncpy(dial_buf, st->dial_label, sizeof(dial_buf) - 1);
  dial_buf[sizeof(dial_buf) - 1] = '\0';
  text_layer_set_text(s_dial_label_layer, dial_buf);

  static char asof_buf[40];
  if (st->stale) {
    snprintf(asof_buf, sizeof(asof_buf), "Cached %s", st->as_of[0] ? st->as_of : "--");
  } else if (st->as_of[0]) {
    snprintf(asof_buf, sizeof(asof_buf), "%s", st->as_of);
  } else {
    snprintf(asof_buf, sizeof(asof_buf), "Data time --");
  }
  text_layer_set_text(s_asof_layer, asof_buf);

  layer_mark_dirty(s_dial_layer);
  if (s_best_block_layer) layer_mark_dirty(s_best_block_layer);
}

static void marquee_stop(void);
static void marquee_start(void);

static void refresh_graph_texts(void) {
  AfwState *st = afw_state();
  static char t[AFW_GRAPH_TITLE_LEN];
  if (st->graph_title[0]) {
    strncpy(t, st->graph_title, sizeof(t) - 1);
    t[sizeof(t) - 1] = '\0';
  } else {
    snprintf(t, sizeof(t), "%s", st->fuel);
  }
  text_layer_set_text(s_graph_title_layer, t);
  layer_mark_dirty(s_graph_layer);
  if (st->graph_legend0[0] || st->graph_legend1[0])
    marquee_start();
}

static void parse_list_rows(void) {
  AfwState *st = afw_state();
  s_list_row_count = 0;
  const char *json = st->list_json;
  if (!json[0]) return;
  const char *p = json;
  while (s_list_row_count < AFW_LIST_MAX && (p = strstr(p, "\"p\":")) != NULL) {
    int price = parse_int(p + 4);
    /* Object spans back to '{' before this "p" through closing '}' */
    const char *obj_start = p;
    while (obj_start > json && *obj_start != '{') obj_start--;
    const char *obj_end = strchr(p, '}');
    const char *np = strstr(obj_start, "\"n\":\"");
    char name[AFW_LIST_NAME_LEN] = "?";
    if (np && (!obj_end || np < obj_end)) {
      np += 5;
      size_t i = 0;
      while (*np && *np != '"' && i < sizeof(name) - 1) name[i++] = *np++;
      name[i] = '\0';
    }
    char fuel[8] = "";
    const char *fp = strstr(obj_start, "\"f\":\"");
    if (fp && (!obj_end || fp < obj_end)) {
      fp += 5;
      size_t i = 0;
      while (*fp && *fp != '"' && i < sizeof(fuel) - 1) fuel[i++] = *fp++;
      fuel[i] = '\0';
    }
    s_list_rows[s_list_row_count].win[0] = '\0';
    const char *wp = strstr(obj_start, "\"w\":");
    if (wp && (!obj_end || wp < obj_end)) {
      /* w is win percent in tenths, e.g. 23 => 2.3% */
      int wt = parse_int(wp + 4);
      if (wt > 0) {
        snprintf(s_list_rows[s_list_row_count].win, sizeof(s_list_rows[0].win), " %d.%d%%",
                 wt / 10, wt % 10);
      }
    }
    format_price_fuel(s_list_rows[s_list_row_count].price, sizeof(s_list_rows[0].price), price,
                      fuel);
    strncpy(s_list_rows[s_list_row_count].name, name, AFW_LIST_NAME_LEN - 1);
    s_list_rows[s_list_row_count].name[AFW_LIST_NAME_LEN - 1] = '\0';
    s_list_row_count++;
    p += 4;
  }
}

static void list_title_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  GFont bold = fonts_get_system_font(AFW_FONT_TITLE);
  graphics_context_set_text_color(ctx, afw_theme_fg());
  draw_marqueed_text_fit(ctx, s_list_title_buf, bold, b, GTextAlignmentCenter);
}

static void list_body_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  GFont bold = fonts_get_system_font(AFW_FONT_TITLE);
  GFont body = fonts_get_system_font(AFW_FONT_BODY);
  graphics_context_set_text_color(ctx, afw_theme_fg());

  if (s_list_row_count <= 0) {
    graphics_draw_text(ctx, "No stations.\n(Back)", body, b, GTextOverflowModeWordWrap,
                       GTextAlignmentLeft, NULL);
    return;
  }

  const int price_h = PBL_IF_ROUND_ELSE(18, 16);
  const int name_h = PBL_IF_ROUND_ELSE(16, 14);
  const int row_gap = 6; /* space before next station's price */
  const int row_h = price_h + name_h + row_gap;
  for (int i = 0; i < s_list_row_count; i++) {
    int y = b.origin.y + i * row_h;
    if (y + price_h > b.origin.y + b.size.h) break;
    draw_price_win_row(ctx, s_list_rows[i].price, s_list_rows[i].win, bold, body,
                       GRect(b.origin.x, y, b.size.w, price_h));

    if (y + price_h + name_h > b.origin.y + b.size.h) break;
    draw_marqueed_text_fit(ctx, s_list_rows[i].name, body,
                           GRect(b.origin.x, y + price_h, b.size.w, name_h), GTextAlignmentLeft);
  }
}

static void marquee_tick(void *data) {
  (void)data;
  s_marquee_tick++;
  if (s_list_title_layer) layer_mark_dirty(s_list_title_layer);
  if (s_list_body_layer) layer_mark_dirty(s_list_body_layer);
  if (s_graph_layer) layer_mark_dirty(s_graph_layer);
  s_marquee_timer = app_timer_register(140, marquee_tick, NULL);
}

static void marquee_start(void) {
  if (s_marquee_timer) return;
  s_marquee_tick = 0;
  s_marquee_timer = app_timer_register(140, marquee_tick, NULL);
}

static void marquee_stop(void) {
  if (s_marquee_timer) {
    app_timer_cancel(s_marquee_timer);
    s_marquee_timer = NULL;
  }
}

static void refresh_list_texts(void) {
  AfwState *st = afw_state();
  if (st->list_title[0]) {
    strncpy(s_list_title_buf, st->list_title, sizeof(s_list_title_buf) - 1);
    s_list_title_buf[sizeof(s_list_title_buf) - 1] = '\0';
  } else {
    const char *kind = "List";
    if (s_list_screen == SCREEN_LIST_FAVS) kind = "Favs top 5";
    else if (s_list_screen == SCREEN_LIST_SUBURB) kind = "Suburb top 5";
    else if (s_list_screen == SCREEN_LIST_SCOPE) kind = "Scope top 5";
    else if (s_list_screen == SCREEN_LIST_GPS) kind = "Near me (GPS)";
    strncpy(s_list_title_buf, kind, sizeof(s_list_title_buf) - 1);
    s_list_title_buf[sizeof(s_list_title_buf) - 1] = '\0';
  }
  parse_list_rows();
  if (s_list_title_layer) layer_mark_dirty(s_list_title_layer);
  if (s_list_body_layer) layer_mark_dirty(s_list_body_layer);
  marquee_start();
}

void afw_ui_refresh(void) {
  if (s_screen == SCREEN_MAIN)
    refresh_main_texts();
  else if (s_screen == SCREEN_GRAPH)
    refresh_graph_texts();
  else
    refresh_list_texts();
  update_nav_hints();
}

int afw_ui_current_screen(void) {
  return s_screen;
}

static void show_main(void) {
  s_screen = SCREEN_MAIN;
  marquee_stop();
  if (window_stack_contains_window(s_graph_window)) window_stack_remove(s_graph_window, true);
  if (window_stack_contains_window(s_list_window)) window_stack_remove(s_list_window, true);
  if (!window_stack_contains_window(s_main_window)) {
    window_stack_push(s_main_window, true);
  }
  afw_ui_refresh();
}

static void show_graph(void) {
  s_screen = SCREEN_GRAPH;
  marquee_stop();
  afw_comm_request("graph");
  if (!window_stack_contains_window(s_graph_window)) {
    window_stack_push(s_graph_window, true);
  }
  afw_ui_refresh();
}

static void show_list(int which) {
  s_list_screen = which;
  s_screen = which;
  const char *req = "list_favs";
  if (which == SCREEN_LIST_SUBURB)
    req = "list_suburb";
  else if (which == SCREEN_LIST_SCOPE)
    req = "list_scope";
  else if (which == SCREEN_LIST_GPS)
    req = "list_gps";
  afw_comm_request(req);
  if (!window_stack_contains_window(s_list_window)) {
    window_stack_push(s_list_window, true);
  }
  afw_ui_refresh();
}

void afw_nav_up(void) {
  if (s_screen == SCREEN_MAIN) {
    show_graph();
  } else if (s_screen == SCREEN_LIST_SCOPE) {
    show_list(SCREEN_LIST_SUBURB);
  } else if (s_screen == SCREEN_LIST_SUBURB) {
    show_list(SCREEN_LIST_FAVS);
  } else if (s_screen == SCREEN_LIST_FAVS) {
    show_main();
  }
  /* Near me / graph: no up */
}

void afw_nav_down(void) {
  if (s_screen == SCREEN_MAIN) {
    show_list(SCREEN_LIST_FAVS);
  } else if (s_screen == SCREEN_LIST_FAVS) {
    show_list(SCREEN_LIST_SUBURB);
  } else if (s_screen == SCREEN_LIST_SUBURB) {
    show_list(SCREEN_LIST_SCOPE);
  } else if (s_screen == SCREEN_GRAPH) {
    show_main();
  }
  /* Near me: no down */
}

void afw_nav_select(void) {
  if (s_screen == SCREEN_MAIN) {
    show_list(SCREEN_LIST_GPS);
  }
}

void afw_nav_back(void) {
  if (s_screen == SCREEN_MAIN) {
    window_stack_pop_all(true);
  } else {
    show_main();
  }
}

static void click_up(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  (void)context;
  afw_nav_up();
}
static void click_down(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  (void)context;
  afw_nav_down();
}
static void click_select(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  (void)context;
  afw_nav_select();
}
static void click_back(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  (void)context;
  afw_nav_back();
}

static void click_config(void *context) {
  (void)context;
  window_single_click_subscribe(BUTTON_ID_UP, click_up);
  window_single_click_subscribe(BUTTON_ID_DOWN, click_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, click_select);
  window_single_click_subscribe(BUTTON_ID_BACK, click_back);
}

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

static Layer *make_hint_layer(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  Layer *hint = layer_create(b);
  layer_set_update_proc(hint, hints_update);
  layer_add_child(root, hint);
  return hint;
}

static void main_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
#if defined(PBL_ROUND)
  const int top = 22;
  const int title_h = 26; /* gothic 18 descenders need room */
  const int gutter = 4;
  const int asof_h = 14;
  const int best_h = 54; /* header + price + station */
#else
  const int top = 0;
  const int title_h = 22; /* gothic 14 descenders (y/g) clip if shorter */
  const int gutter = 8;
  const int asof_h = 14;
  const int best_h = 50;
#endif
  const int content_w = b.size.w - gutter;
  const int dial_y = top + title_h + 1;
  const int asof_y = b.size.h - asof_h - 1;
  /* Reserve best-buy height first so station row isn't clipped; dial gets the rest */
  int dial_h = asof_y - best_h - dial_y;
  if (dial_h < 64) dial_h = 64;
  const int best_y_adj = dial_y + dial_h;
  const int best_h_adj = asof_y - best_y_adj;

  s_title_layer = make_text(window, GRect(2, top, content_w - 4, title_h), AFW_FONT_TITLE,
                            GTextAlignmentCenter);
  s_dial_layer = layer_create(GRect(0, dial_y, content_w, dial_h));
  layer_set_update_proc(s_dial_layer, dial_update);
  layer_add_child(root, s_dial_layer);

  s_dial_label_layer =
      make_text(window, GRect(4, dial_y + dial_h - 2, content_w - 8, 1), AFW_FONT_SMALL,
                GTextAlignmentCenter);
  layer_set_hidden(text_layer_get_layer(s_dial_label_layer), true);

  s_best_block_layer = layer_create(GRect(2, best_y_adj, content_w - 4, best_h_adj));
  layer_set_update_proc(s_best_block_layer, best_block_update);
  layer_add_child(root, s_best_block_layer);

  s_asof_layer = make_text(window, GRect(4, asof_y, content_w - 8, asof_h), AFW_FONT_SMALL,
                           GTextAlignmentCenter);

  s_main_hint_layer = make_hint_layer(window);
  refresh_main_texts();
  update_nav_hints();
}

void afw_ui_apply_theme(void) {
  GColor bg = afw_theme_bg();
  GColor fg = afw_theme_fg();
  if (s_main_window) window_set_background_color(s_main_window, bg);
  if (s_graph_window) window_set_background_color(s_graph_window, bg);
  if (s_list_window) window_set_background_color(s_list_window, bg);
  if (s_title_layer) text_layer_set_text_color(s_title_layer, fg);
  if (s_dial_label_layer) text_layer_set_text_color(s_dial_label_layer, fg);
  if (s_asof_layer) text_layer_set_text_color(s_asof_layer, afw_theme_muted());
  if (s_graph_title_layer) text_layer_set_text_color(s_graph_title_layer, fg);
  if (s_list_title_layer) layer_mark_dirty(s_list_title_layer);
  if (s_dial_layer) layer_mark_dirty(s_dial_layer);
  if (s_best_block_layer) layer_mark_dirty(s_best_block_layer);
  if (s_graph_layer) layer_mark_dirty(s_graph_layer);
  if (s_list_body_layer) layer_mark_dirty(s_list_body_layer);
  if (s_main_hint_layer) layer_mark_dirty(s_main_hint_layer);
  if (s_graph_hint_layer) layer_mark_dirty(s_graph_hint_layer);
  if (s_list_hint_layer) layer_mark_dirty(s_list_hint_layer);
}

static void main_unload(Window *window) {
  (void)window;
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_dial_label_layer);
  text_layer_destroy(s_asof_layer);
  layer_destroy(s_best_block_layer);
  s_best_block_layer = NULL;
  layer_destroy(s_dial_layer);
  layer_destroy(s_main_hint_layer);
  s_main_hint_layer = NULL;
}

static void graph_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
#if defined(PBL_ROUND)
  const int gutter = 4;
  const int top = 18;
  const int title_h = 24; /* room for descenders (e.g. "y" in "days") */
#else
  const int gutter = 12;
  const int top = 0;
  const int title_h = 22;
#endif
  const int content_w = b.size.w - gutter;
  s_graph_title_layer =
      make_text(window, GRect(4, top, content_w - 8, title_h), AFW_FONT_TITLE, GTextAlignmentCenter);
  /* Leave 20px bezel so plot base + date labels are not clipped (raised 10px) */
  s_graph_layer =
      layer_create(GRect(4, top + title_h, content_w - 8, b.size.h - top - title_h - 20));
  layer_set_update_proc(s_graph_layer, graph_update);
  layer_add_child(root, s_graph_layer);
  s_graph_hint_layer = make_hint_layer(window);
  refresh_graph_texts();
  update_nav_hints();
}

static void graph_unload(Window *window) {
  (void)window;
  text_layer_destroy(s_graph_title_layer);
  layer_destroy(s_graph_layer);
  layer_destroy(s_graph_hint_layer);
  s_graph_hint_layer = NULL;
}

static void list_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
#if defined(PBL_ROUND)
  const int side = 10; /* clear round bezel */
#else
  const int side = 4; /* use nearly full width before marquee */
#endif
  const int title_y = PBL_IF_ROUND_ELSE(20, 2);
  const int title_h = 20;
  s_list_title_layer = layer_create(GRect(side, title_y, b.size.w - 2 * side, title_h));
  layer_set_update_proc(s_list_title_layer, list_title_update);
  layer_add_child(root, s_list_title_layer);
  s_list_body_layer =
      layer_create(GRect(side, PBL_IF_ROUND_ELSE(48, 26), b.size.w - 2 * side,
                         b.size.h - PBL_IF_ROUND_ELSE(64, 34)));
  layer_set_update_proc(s_list_body_layer, list_body_update);
  layer_add_child(root, s_list_body_layer);
  s_list_hint_layer = make_hint_layer(window);
  refresh_list_texts();
  update_nav_hints();
}

static void list_unload(Window *window) {
  (void)window;
  marquee_stop();
  layer_destroy(s_list_title_layer);
  s_list_title_layer = NULL;
  layer_destroy(s_list_body_layer);
  s_list_body_layer = NULL;
  layer_destroy(s_list_hint_layer);
  s_list_hint_layer = NULL;
}

void afw_ui_init(void) {
  s_main_window = window_create();
  window_set_background_color(s_main_window, afw_theme_bg());
  window_set_window_handlers(s_main_window, (WindowHandlers){
                                                .load = main_load,
                                                .unload = main_unload,
                                            });
  window_set_click_config_provider(s_main_window, click_config);
  afw_touch_bind_window(s_main_window);

  s_graph_window = window_create();
  window_set_background_color(s_graph_window, afw_theme_bg());
  window_set_window_handlers(s_graph_window, (WindowHandlers){
                                                 .load = graph_load,
                                                 .unload = graph_unload,
                                             });
  window_set_click_config_provider(s_graph_window, click_config);
  afw_touch_bind_window(s_graph_window);

  s_list_window = window_create();
  window_set_background_color(s_list_window, afw_theme_bg());
  window_set_window_handlers(s_list_window, (WindowHandlers){
                                                .load = list_load,
                                                .unload = list_unload,
                                            });
  window_set_click_config_provider(s_list_window, click_config);
  afw_touch_bind_window(s_list_window);

  window_stack_push(s_main_window, true);
}

void afw_ui_deinit(void) {
  marquee_stop();
  window_destroy(s_main_window);
  window_destroy(s_graph_window);
  window_destroy(s_list_window);
}
