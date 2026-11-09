// Win10 19045, 100% scale: a 300px frameless client has a 316px window rect and 302px DWM frame. Claiming the entire window rect removes the visible border.

// WS_THICKFRAME preserves Snap, resize and animations. Win10 rejects DWMWA_BORDER_COLOR; expanding by one pixel merely moves the stroke. Chromium retains maximized geometry for auto-hide taskbars.

// Chromium children intercept hit tests and button-downs. Subclassing them restores resize routing; rescans cover child recreation. The resize band overlays rendered content.

// GetDpiForWindow / GetSystemMetricsForDpi are Windows 10 1607+ (0x0A00).
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif

#include <windows.h>
#include <commctrl.h>
#include <windowsx.h>  // GET_X_LPARAM / GET_Y_LPARAM
#include <stdio.h>     // fprintf: compositor-drift log
#include <node_api.h>
#include "window_rect.h"

// Arbitrary but stable id for our subclass entry on each HWND.
#define BORDER_SUBCLASS_ID 1

// Logical pixels: narrow edges preserve clickable content; longer corner arms allow diagonal resizing.
#define RESIZE_BAND_LOGICAL_PX 2
#define RESIZE_CORNER_LOGICAL_PX 12

/** Scales logical pixels using this window's DPI; differently scaled displays require per-window metrics. */
static int ScaleForDpi(int logical_px, UINT dpi) {
  int scaled = MulDiv(logical_px, (int)dpi, 96);
  return scaled < 1 ? 1 : scaled;
}

/** HTNOWHERE means outside the resize band; HTERROR preserves the system hit test when GetWindowRect fails. */
static int ResizeBandDirection(HWND top, int x, int y) {
  RECT wr;
  if (!GetWindowRect(top, &wr)) return HTERROR;
  UINT dpi = GetDpiForWindow(top);
  int band_px = ScaleForDpi(RESIZE_BAND_LOGICAL_PX, dpi);
  int arm_px = ScaleForDpi(RESIZE_CORNER_LOGICAL_PX, dpi);

  int on_left = x < wr.left + band_px, on_right = x >= wr.right - band_px;
  int on_top = y < wr.top + band_px, on_bottom = y >= wr.bottom - band_px;
  int near_left = x < wr.left + arm_px, near_right = x >= wr.right - arm_px;
  int near_top = y < wr.top + arm_px, near_bottom = y >= wr.bottom - arm_px;

  // L-shaped corners preserve a long diagonal target without covering buttons with a solid corner square.
  if ((on_top && near_left) || (on_left && near_top)) return HTTOPLEFT;
  if ((on_top && near_right) || (on_right && near_top)) return HTTOPRIGHT;
  if ((on_bottom && near_left) || (on_left && near_bottom)) return HTBOTTOMLEFT;
  if ((on_bottom && near_right) || (on_right && near_bottom)) return HTBOTTOMRIGHT;

  if (on_left) return HTLEFT;
  if (on_right) return HTRIGHT;
  if (on_top) return HTTOP;
  if (on_bottom) return HTBOTTOM;
  return HTNOWHERE;
}

static BOOL IsResizeHitTestCode(int code);

/** The system sizing cursor for a resize hit-test code. */
static LPCTSTR ResizeCursorForHitTest(int code) {
  switch (code) {
    case HTLEFT: case HTRIGHT: return IDC_SIZEWE;
    case HTTOP: case HTBOTTOM: return IDC_SIZENS;
    case HTTOPLEFT: case HTBOTTOMRIGHT: return IDC_SIZENWSE;
    case HTTOPRIGHT: case HTBOTTOMLEFT: return IDC_SIZENESW;
    default: return NULL;
  }
}

/** Chromium children overwrite native sizing cursors; returning TRUE prevents the renderer cursor replacing them. */
static BOOL ApplyResizeCursor(int hit_code) {
  LPCTSTR cursor = ResizeCursorForHitTest(hit_code);
  if (!cursor) return FALSE;
  SetCursor(LoadCursor(NULL, cursor));
  return TRUE;
}


#define CHILD_SUBCLASS_ID 2
#define CHILD_RESCAN_TIMER_ID 3

// Chromium child recreation does not reliably deliver WM_PARENTNOTIFY. A one-second rescan restores subclassing after unannounced swaps.
#define CHILD_RESCAN_INTERVAL_MS 1000

/** Chromium input children cover the resize band. Returning the parent's resize code routes input correctly; HTTRANSPARENT leaves Chromium swallowing button-downs. */
static LRESULT CALLBACK ChildSubclassProc(
    HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam,
    UINT_PTR subclass_id, DWORD_PTR ref_data) {
  (void)ref_data;

  if (msg == WM_NCHITTEST) {
    HWND top = GetAncestor(hwnd, GA_ROOT);
    if (top && !IsZoomed(top)) {
      // The parent's own subclass (below) synthesises the resize codes, so this
      // is one hop, not a duplicate of that logic.
      LRESULT parent_hit = SendMessage(top, WM_NCHITTEST, wparam, lparam);
      if (IsResizeHitTestCode((int)parent_hit)) return parent_hit;
    }
  }

  // LOWORD(lparam) is the hit-test code the OS just resolved for this point.
  if (msg == WM_SETCURSOR && ApplyResizeCursor(LOWORD(lparam))) {
    return TRUE;
  }

  // Chromium resets the cursor during WM_NCMOUSEMOVE; reapply after its handler.
  if (msg == WM_NCMOUSEMOVE && IsResizeHitTestCode((int)wparam)) {
    LRESULT moved = DefSubclassProc(hwnd, msg, wparam, lparam);
    ApplyResizeCursor((int)wparam);
    return moved;
  }

  // The child receives non-client button-down; the top-level subclass starts the sizing loop.
  if (msg == WM_NCLBUTTONDOWN && IsResizeHitTestCode((int)wparam)) {
    HWND top = GetAncestor(hwnd, GA_ROOT);
    if (top && !IsZoomed(top)) {
      SendMessage(top, WM_NCLBUTTONDOWN, wparam, lparam);
      return 0;
    }
  }

  if (msg == WM_NCDESTROY) RemoveWindowSubclass(hwnd, ChildSubclassProc, subclass_id);
  return DefSubclassProc(hwnd, msg, wparam, lparam);
}

// Chromium's GPU-process compositor child paints each frame and may retain its original client origin after a frame change.
#define COMPOSITOR_CHILD_CLASS L"Intermediate D3D Window"

/** A dev restart showed the compositor at (-1073,-281), exposing stale pixels. Restore its client origin without moving the top-level window. */
static void PinCompositorChild(HWND top, HWND child) {
  WCHAR cls[64];
  if (GetParent(child) != top) return;
  if (!GetClassNameW(child, cls, ARRAYSIZE(cls))) return;
  if (lstrcmpW(cls, COMPOSITOR_CHILD_CLASS) != 0) return;

  RECT r;
  if (!GetWindowRect(child, &r)) return;
  POINT origin = { r.left, r.top };
  if (!ScreenToClient(top, &origin)) return;
  if (origin.x == 0 && origin.y == 0) return;

  // Async posts the move to the GPU thread; a correction that does not land
  // shows up as this line repeating on the next rescan.
  BOOL posted = SetWindowPos(child, NULL, 0, 0, 0, 0,
                             SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER |
                             SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
  fprintf(stderr,
          "[window-border] compositor surface drifted to client (%ld,%ld) on hwnd %p; move to (0,0) %s (err %lu)\n",
          origin.x, origin.y, (void*)top, posted ? "posted" : "FAILED",
          posted ? 0UL : GetLastError());
  fflush(stderr);
}

static BOOL CALLBACK SubclassChild(HWND child, LPARAM l) {
  // SetWindowSubclass cannot cross threads; the GPU-process compositor child
  // would fail silently. Chromium's input children live on this UI thread.
  if (GetWindowThreadProcessId(child, NULL) == GetCurrentThreadId()) {
    SetWindowSubclass(child, ChildSubclassProc, CHILD_SUBCLASS_ID, 0);
  }
  PinCompositorChild((HWND)l, child);
  return TRUE;
}

/** Re-subclasses input children and re-pins the compositor. Moving the top-level window during rescans interferes with the active sizing loop. */
static void RescanChildren(HWND hwnd) {
  EnumChildWindows(hwnd, SubclassChild, (LPARAM)hwnd);
}

/** True for the eight edge/corner resize hit-test codes. */
static BOOL IsResizeHitTestCode(int code) {
  return code == HTLEFT || code == HTRIGHT || code == HTTOP || code == HTBOTTOM ||
         code == HTTOPLEFT || code == HTTOPRIGHT ||
         code == HTBOTTOMLEFT || code == HTBOTTOMRIGHT;
}

static LRESULT CALLBACK BorderSubclassProc(
    HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam,
    UINT_PTR subclass_id, DWORD_PTR ref_data) {
  (void)ref_data;

  if (msg == WM_NCCALCSIZE && wparam == TRUE) {
    NCCALCSIZE_PARAMS* params = (NCCALCSIZE_PARAMS*)lparam;

    // rgrc[0] enters as the proposed window rect and leaves as the client rect.
    RECT proposed_window_rect = params->rgrc[0];

    // Chromium's maximized geometry leaves the sliver required to reveal an auto-hide taskbar.
    LRESULT result = DefSubclassProc(hwnd, msg, wparam, lparam);

    // Maximized / minimized: keep Chromium's computed rect verbatim (see above).
    // Restored is the only state that shows the border, and the only one we
    // override.
    if (!IsZoomed(hwnd) && !IsIconic(hwnd)) {
      params->rgrc[0] = proposed_window_rect;
    }

    // Preserve Chromium's return value — it may carry WVR_* client-preservation
    // flags, and inventing our own would change repaint behaviour.
    return result;
  }

  if (msg == WM_NCHITTEST) {
    // Full-client geometry removes native resize hit tests; synthesize them over the narrow outer band.
    LRESULT hit = DefSubclassProc(hwnd, msg, wparam, lparam);
    if (IsZoomed(hwnd)) return hit;

    // Every edge and child uses the same resize-band geometry.
    int band = ResizeBandDirection(hwnd, GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam));
    if (band == HTERROR) return hit;  // rect unreadable — keep the system's answer

    // Override Chromium's wider sizing codes and HTCLIENT; preserve caption, button and menu hit tests.
    if (IsResizeHitTestCode((int)hit) || hit == HTCLIENT) {
      return band == HTNOWHERE ? HTCLIENT : band;
    }
    return hit;
  }

  // Chromium consumes non-client button-down. DefWindowProc starts the sizing loop for resize codes; caption dragging stays with Chromium.
  if (msg == WM_SETCURSOR && ApplyResizeCursor(LOWORD(lparam))) {
    return TRUE;
  }

  // Corner hit tests reach the top-level window and need the same cursor reapplication as child hit tests.
  if (msg == WM_NCMOUSEMOVE && IsResizeHitTestCode((int)wparam)) {
    LRESULT moved = DefSubclassProc(hwnd, msg, wparam, lparam);
    ApplyResizeCursor((int)wparam);
    return moved;
  }

  // Fast paths: both fire when Chromium has just rebuilt its child windows
  // (navigation, renderer respawn, HMR reload, resize).
  if ((msg == WM_PARENTNOTIFY && LOWORD(wparam) == WM_CREATE) ||
      msg == WM_WINDOWPOSCHANGED) {
    RescanChildren(hwnd);
  }
  // Self-heal for the swaps that announce themselves through neither hook.
  if (msg == WM_TIMER && wparam == CHILD_RESCAN_TIMER_ID) {
    RescanChildren(hwnd);
    return 0;
  }
  if (msg == WM_NCLBUTTONDOWN && IsResizeHitTestCode((int)wparam) && !IsZoomed(hwnd)) {
    return DefWindowProc(hwnd, msg, wparam, lparam);
  }

  // Remove ourselves before the window dies so the subclass chain isn't left
  // pointing at this module after it could be unloaded.
  if (msg == WM_NCDESTROY) {
    KillTimer(hwnd, CHILD_RESCAN_TIMER_ID);
    RemoveWindowSubclass(hwnd, BorderSubclassProc, subclass_id);
  }

  return DefSubclassProc(hwnd, msg, wparam, lparam);
}

/** stripVisibleFrameBorder(hwnd: bigint) -> boolean */
static napi_value StripVisibleFrameBorder(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value out;
  if (argc < 1) {
    napi_get_boolean(env, false, &out);
    return out;
  }

  int64_t handle = 0;
  bool lossless = false;
  if (napi_get_value_bigint_int64(env, argv[0], &handle, &lossless) != napi_ok) {
    napi_get_boolean(env, false, &out);
    return out;
  }

  HWND hwnd = (HWND)(intptr_t)handle;
  if (!IsWindow(hwnd)) {
    napi_get_boolean(env, false, &out);
    return out;
  }

  BOOL ok = SetWindowSubclass(hwnd, BorderSubclassProc, BORDER_SUBCLASS_ID, 0);
  if (ok) {
    RescanChildren(hwnd);
    SetTimer(hwnd, CHILD_RESCAN_TIMER_ID, CHILD_RESCAN_INTERVAL_MS, NULL);
    // Force a fresh WM_NCCALCSIZE so the new client rect applies immediately
    // instead of waiting for the next resize.
    SetWindowPos(hwnd, NULL, 0, 0, 0, 0,
                 SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE |
                 SWP_NOZORDER | SWP_NOACTIVATE);
  }

  napi_get_boolean(env, ok ? true : false, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, NULL, 0, StripVisibleFrameBorder, NULL, &fn);
  napi_set_named_property(env, exports, "stripVisibleFrameBorder", fn);
  RegisterWindowRectExports(env, exports);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
