import 'dart:async';

import 'package:flutter/widgets.dart';

/// PollTimer —— 生命周期感知的轮询定时器(2026-08-25)
///
/// 背景:全项目曾散落 20+ 处裸 `Timer.periodic` 轮询(任务进度 / 支付
/// 状态 / 沙箱测试等),App 退后台 / Web 切走标签页后仍在固定频率打接口,
/// 浪费电量与后端 QPS。
///
/// 用法与 `Timer.periodic` 完全兼容(实现 [Timer] 接口):
/// ```dart
/// Timer? _pollTimer;
/// _pollTimer = PollTimer(const Duration(seconds: 3), (t) async { ... });
/// // dispose 里照旧:_pollTimer?.cancel();
/// ```
///
/// 行为:
/// - App 进入 paused/hidden(Web 标签页隐藏)→ 暂停 tick;
/// - 回到 resumed → 立即补一次 tick 并恢复周期;
/// - cancel() 幂等,自动摘除生命周期观察。
class PollTimer with WidgetsBindingObserver implements Timer {
  PollTimer(Duration duration, void Function(Timer) callback)
      : _duration = duration,
        _callback = callback {
    WidgetsBinding.instance.addObserver(this);
    _arm();
  }

  final Duration _duration;
  final void Function(Timer) _callback;

  Timer? _inner;
  bool _backgroundPaused = false;

  void _arm() {
    _inner?.cancel();
    _inner = Timer.periodic(_duration, (_) {
      if (!_backgroundPaused) _callback(this);
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.inactive) {
      _backgroundPaused = true;
    } else if (state == AppLifecycleState.resumed) {
      final wasPaused = _backgroundPaused;
      _backgroundPaused = false;
      // 后台期间数据可能已变,回到前台立即补一次
      if (wasPaused && isActive) _callback(this);
    }
  }

  @override
  void cancel() {
    _inner?.cancel();
    _inner = null;
    WidgetsBinding.instance.removeObserver(this);
  }

  @override
  bool get isActive => _inner?.isActive ?? false;

  @override
  int get tick => _inner?.tick ?? 0;
}
