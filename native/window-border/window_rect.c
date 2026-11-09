// Physical pixels round-trip exactly through GetWindowRect and SetWindowPos.
// Electron 44.7.1 on Win10, primary 100% and secondary 150%: frameless DIP bounds over-report after creation and setBounds, growing the window on each restore.

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>
#include <node_api.h>
#include "window_rect.h"

static HWND ReadHwnd(napi_env env, napi_value value) {
  int64_t handle = 0;
  bool lossless = false;
  if (napi_get_value_bigint_int64(env, value, &handle, &lossless) != napi_ok) return NULL;
  HWND hwnd = (HWND)(intptr_t)handle;
  return IsWindow(hwnd) ? hwnd : NULL;
}

static void SetIntProperty(napi_env env, napi_value obj, const char* name, int value) {
  napi_value v;
  napi_create_int32(env, value, &v);
  napi_set_named_property(env, obj, name, v);
}

/** getWindowRect(hwnd: bigint) -> { x, y, width, height } | null, physical px. */
static napi_value GetWindowRectJs(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value out;
  napi_get_null(env, &out);
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return out;

  HWND hwnd = ReadHwnd(env, argv[0]);
  RECT r;
  if (!hwnd || !GetWindowRect(hwnd, &r)) return out;

  napi_create_object(env, &out);
  SetIntProperty(env, out, "x", r.left);
  SetIntProperty(env, out, "y", r.top);
  SetIntProperty(env, out, "width", r.right - r.left);
  SetIntProperty(env, out, "height", r.bottom - r.top);
  return out;
}

/** setWindowRect(hwnd: bigint, x, y, width, height) -> boolean, physical px. Never shows or activates. */
static napi_value SetWindowRectJs(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_value out;
  napi_get_boolean(env, false, &out);
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 5) return out;

  HWND hwnd = ReadHwnd(env, argv[0]);
  int32_t x, y, width, height;
  if (!hwnd ||
      napi_get_value_int32(env, argv[1], &x) != napi_ok ||
      napi_get_value_int32(env, argv[2], &y) != napi_ok ||
      napi_get_value_int32(env, argv[3], &width) != napi_ok ||
      napi_get_value_int32(env, argv[4], &height) != napi_ok ||
      width <= 0 || height <= 0) {
    return out;
  }

  BOOL ok = SetWindowPos(hwnd, NULL, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
  napi_get_boolean(env, ok ? true : false, &out);
  return out;
}

void RegisterWindowRectExports(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, NULL, 0, GetWindowRectJs, NULL, &fn);
  napi_set_named_property(env, exports, "getWindowRect", fn);
  napi_create_function(env, NULL, 0, SetWindowRectJs, NULL, &fn);
  napi_set_named_property(env, exports, "setWindowRect", fn);
}
