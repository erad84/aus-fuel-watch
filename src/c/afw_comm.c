#include "afw.h"

static void copy_cstr(char *dst, size_t n, const char *src) {
  if (!dst || n == 0) return;
  if (!src) {
    dst[0] = '\0';
    return;
  }
  strncpy(dst, src, n - 1);
  dst[n - 1] = '\0';
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  AfwState *st = afw_state();
  Tuple *t;

  t = dict_find(iter, MESSAGE_KEY_TITLE);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->title, AFW_TITLE_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_FUEL);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->fuel, AFW_FUEL_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_HOME_CTX);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->home_ctx, sizeof(st->home_ctx), t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_DIAL_ANGLE);
  if (t) st->dial_angle = (int32_t)t->value->int32;
  t = dict_find(iter, MESSAGE_KEY_DIAL_LABEL);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->dial_label, AFW_LABEL_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_BAR_LOW);
  if (t) st->bar_low = (int32_t)t->value->int32;
  t = dict_find(iter, MESSAGE_KEY_BAR_HIGH);
  if (t) st->bar_high = (int32_t)t->value->int32;
  t = dict_find(iter, MESSAGE_KEY_BAR_PRICE);
  if (t) st->bar_price = (int32_t)t->value->int32;
  t = dict_find(iter, MESSAGE_KEY_BEST_PRICE);
  if (t) st->best_price = (int32_t)t->value->int32;
  t = dict_find(iter, MESSAGE_KEY_BEST_NAME);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->best_name, AFW_NAME_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_BEST_LINE);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->best_line, AFW_BEST_LINE_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_COMPARE_LINE);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->compare_line, AFW_COMPARE_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_AS_OF);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->as_of, AFW_ASOF_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_STALE);
  if (t) st->stale = t->value->int32 != 0;
  t = dict_find(iter, MESSAGE_KEY_OUTLOOK_DIR);
  if (t) st->outlook_dir = (int32_t)t->value->int32;
  t = dict_find(iter, MESSAGE_KEY_OUTLOOK_STR);
  if (t) st->outlook_str = (int32_t)t->value->int32;

  t = dict_find(iter, MESSAGE_KEY_GRAPH_MIN);
  if (t) st->graph_min = (int32_t)t->value->int32;
  t = dict_find(iter, MESSAGE_KEY_GRAPH_MAX);
  if (t) st->graph_max = (int32_t)t->value->int32;
  t = dict_find(iter, MESSAGE_KEY_GRAPH_N);
  if (t) {
    st->graph_n = (int32_t)t->value->int32;
    if (st->graph_n > AFW_GRAPH_MAX_PTS) st->graph_n = AFW_GRAPH_MAX_PTS;
  }
  t = dict_find(iter, MESSAGE_KEY_GRAPH_PTS);
  if (t && t->type == TUPLE_BYTE_ARRAY) {
    uint32_t n = t->length;
    if (n > AFW_GRAPH_MAX_PTS) n = AFW_GRAPH_MAX_PTS;
    memcpy(st->graph_pts, t->value->data, n);
    if ((int32_t)n < st->graph_n) st->graph_n = (int32_t)n;
  }
  t = dict_find(iter, MESSAGE_KEY_GRAPH_N2);
  if (t) {
    st->graph_n2 = (int32_t)t->value->int32;
    if (st->graph_n2 > AFW_GRAPH_MAX_PTS) st->graph_n2 = AFW_GRAPH_MAX_PTS;
  }
  t = dict_find(iter, MESSAGE_KEY_GRAPH_PTS2);
  if (t && t->type == TUPLE_BYTE_ARRAY) {
    uint32_t n = t->length;
    if (n > AFW_GRAPH_MAX_PTS) n = AFW_GRAPH_MAX_PTS;
    memcpy(st->graph_pts2, t->value->data, n);
    if ((int32_t)n < st->graph_n2) st->graph_n2 = (int32_t)n;
  }
  t = dict_find(iter, MESSAGE_KEY_GRAPH_TITLE);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->graph_title, AFW_GRAPH_TITLE_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_GRAPH_X0);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->graph_x0, AFW_GRAPH_X_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_GRAPH_X1);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->graph_x1, AFW_GRAPH_X_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_GRAPH_LEGEND0);
  if (t && t->type == TUPLE_CSTRING)
    copy_cstr(st->graph_legend0, AFW_GRAPH_LEGEND_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_GRAPH_LEGEND1);
  if (t && t->type == TUPLE_CSTRING)
    copy_cstr(st->graph_legend1, AFW_GRAPH_LEGEND_LEN, t->value->cstring);

  t = dict_find(iter, MESSAGE_KEY_LIST_KIND);
  if (t) st->list_kind = (int32_t)t->value->int32;
  t = dict_find(iter, MESSAGE_KEY_LIST_TITLE);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->list_title, AFW_LIST_TITLE_LEN, t->value->cstring);
  t = dict_find(iter, MESSAGE_KEY_LIST_JSON);
  if (t && t->type == TUPLE_CSTRING) copy_cstr(st->list_json, AFW_LIST_JSON_LEN, t->value->cstring);

  t = dict_find(iter, MESSAGE_KEY_THEME);
  if (t) {
    afw_theme_set((int)t->value->int32);
    afw_ui_apply_theme();
  }

  afw_ui_refresh();
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "inbox dropped %d", (int)reason);
}

void afw_comm_init(void) {
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  const uint32_t inbox = 4096;
  const uint32_t outbox = 256;
  app_message_open(inbox, outbox);
}

void afw_comm_deinit(void) {
  app_message_deregister_callbacks();
}

void afw_comm_request(const char *req) {
  DictionaryIterator *iter;
  AppMessageResult r = app_message_outbox_begin(&iter);
  if (r != APP_MSG_OK || !iter) return;
  dict_write_cstring(iter, MESSAGE_KEY_REQUEST, req);
  app_message_outbox_send();
}
