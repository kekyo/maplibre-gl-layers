// maplibre-gl-layers - MapLibre's layer extension library enabling
// the display, movement, and modification of large numbers of dynamic sprite images
// Copyright (c) Kouji Matsui (@kekyo)
// Under MIT

#pragma once

#ifndef _WORKER_JOBS_H
#define _WORKER_JOBS_H

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <utility>
#include <vector>

#include <emscripten/emscripten.h>

#if defined(__EMSCRIPTEN_PTHREADS__)
#include <thread>
#endif

#if defined(__EMSCRIPTEN_PTHREADS__)
inline std::size_t g_threadPoolLimit = 0;

extern "C" {
EMSCRIPTEN_KEEPALIVE inline void setThreadPoolSize(double value) {
  if (std::isnan(value) || value <= 0.0) {
    g_threadPoolLimit = 0;
    return;
  }
  const double floored = std::floor(value + 0.5);
  if (!std::isfinite(floored)) {
    return;
  }
  const auto converted = static_cast<std::size_t>(floored);
  g_threadPoolLimit = converted > 0 ? converted : 0;
}
}

static inline std::size_t clampToAvailableThreads(std::size_t requested) {
  if (g_threadPoolLimit > 0) {
    return std::min<std::size_t>(requested, g_threadPoolLimit);
  }
  unsigned int hw = std::thread::hardware_concurrency();
  if (hw == 0u) {
    hw = 4u;
  }
  return std::min<std::size_t>(requested, static_cast<std::size_t>(hw));
}
#else
extern "C" {
EMSCRIPTEN_KEEPALIVE inline void setThreadPoolSize(double value) {
  (void)value;
}
}

static inline std::size_t clampToAvailableThreads(std::size_t requested) {
  return requested;
}
#endif

static inline std::size_t determineWorkerCount(std::size_t totalItems,
                                               std::size_t minParallelItems,
                                               std::size_t sliceItems) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  if (totalItems < minParallelItems) {
    return 1;
  }
  unsigned int hw = std::thread::hardware_concurrency();
  if (hw == 0u) {
    hw = 4u;
  }
  const std::size_t maxWorkers =
      clampToAvailableThreads(static_cast<std::size_t>(hw));
  const std::size_t bySize =
      std::max<std::size_t>(1, sliceItems > 0 ? totalItems / sliceItems : 1);
  return std::min<std::size_t>(maxWorkers, bySize);
#else
  (void)totalItems;
  (void)minParallelItems;
  (void)sliceItems;
  return 1;
#endif
}

template <typename Fn>
static inline void runWorkerJobs(std::size_t workerCount,
                                 std::size_t totalItems,
                                 Fn&& fn) {
#if defined(__EMSCRIPTEN_PTHREADS__)
  Fn job = std::forward<Fn>(fn);
  if (workerCount <= 1 || totalItems == 0) {
    job(0, totalItems, 0);
    return;
  }
  const std::size_t sliceSize =
      (totalItems + workerCount - 1) / workerCount;

  std::vector<std::thread> workers;
  workers.reserve(workerCount);
  for (std::size_t workerIndex = 0; workerIndex < workerCount; ++workerIndex) {
    const std::size_t start = workerIndex * sliceSize;
    if (start >= totalItems) {
      break;
    }
    const std::size_t end = std::min(totalItems, start + sliceSize);
    workers.emplace_back(
        [start, end, workerIndex, job]() mutable {
          job(start, end, workerIndex);
        });
  }
  for (std::thread& worker : workers) {
    if (worker.joinable()) {
      worker.join();
    }
  }
#else
  (void)workerCount;
  Fn job = std::forward<Fn>(fn);
  job(0, totalItems, 0);
#endif
}

#endif
