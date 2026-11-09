#ifndef WINDOW_RECT_H
#define WINDOW_RECT_H

#include <node_api.h>

/** Adds getWindowRect / setWindowRect to the addon's exports. */
void RegisterWindowRectExports(napi_env env, napi_value exports);

#endif
