#include "projection_host.h"

#include <emscripten/emscripten.h>

//////////////////////////////////////////////////////////////////////////////////////

// TODO:
static inline bool _todo(double lng, double lat, double altitude, double* out) {
  return false;
}

//////////////////////////////////////////////////////////////////////////////////////

extern "C" {

// TODO:
EMSCRIPTEN_KEEPALIVE bool todo(double lng,
                               double lat,
                               double altitude,
                               double* out) {
  // Input guards
  if (out == nullptr) {
    return false;
  }

  // TODO: Invoke main body
  return _todo(lng, lat, altitude, out);
}

} // extern "C"
