/*
 * Firmware 4.32+ opts third-party apps OUT of touch→button navigation.
 *
 * On PBL_TOUCH (emery/gabbro): swipe-only navigation (no taps). Directions are
 * inverted vs the system enum so gestures match on-screen page flow.
 * Back-swipe (left→right) only works on the Near me list.
 */

#include "afw.h"

#if defined(_PBL_API_EXISTS_app_touch_navigation_enable)
void afw_touch_init(void) {
  app_touch_navigation_enable(true);
}
#else
void afw_touch_init(void) {}
#endif

#if defined(PBL_TOUCH)

static void touch_swipe_handler(const Recognizer *recognizer, RecognizerEvent event) {
  if (event != RecognizerEvent_Completed) {
    return;
  }
  switch (swipe_recognizer_get_direction(recognizer)) {
    case SwipeDirection_Up:
      afw_nav_down();
      break;
    case SwipeDirection_Down:
      afw_nav_up();
      break;
    case SwipeDirection_Left:
      /* right → left = Select (Near me from main) */
      afw_nav_select();
      break;
    case SwipeDirection_Right:
      /* left → right = Back, only on Near me */
      if (afw_ui_current_screen() == SCREEN_LIST_GPS) {
        afw_nav_back();
      }
      break;
    default:
      break;
  }
}

void afw_touch_bind_window(Window *window) {
  if (!window) {
    return;
  }

  window_set_touch_bridge_disabled(window, true);

  Recognizer *swipe = swipe_recognizer_create(
      touch_swipe_handler, NULL,
      SwipeDirection_Up | SwipeDirection_Down | SwipeDirection_Left | SwipeDirection_Right);
  window_attach_recognizer(window, swipe);
}

#else

void afw_touch_bind_window(Window *window) {
  (void)window;
}

#endif
