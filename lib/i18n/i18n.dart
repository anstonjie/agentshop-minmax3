// ============================================================================
// I18nStore — 多语言状态管理 + tr() 翻译 API
// ----------------------------------------------------------------------------
// 设计:
//   - 单例 ChangeNotifier,挂到 MaterialApp 上层(用 ListenableBuilder 重建)
//   - 启动时调 init() 加载 JSON 资源 + 自动检测语言
//   - tr(key, args?) 翻译接口,缺失 key 走 zh.json 兜底,再缺失返回 key 本身
//   - 切换语言:changeLocale(code) → 加载对应 JSON → notifyListeners → 全 App 重建
//   - JSON 资源按语言分文件:assets/i18n/zh.json / en.json / ...
//
// tr() 调用约定:
//   Text(tr('home.title'))
//   Text(tr('wallet.balance', args: {'amount': '100.50'}))
//   key 用点分层级:home.title / common.confirm / nav.market
//
// 占位符语法:{name} — 如 "余额: {amount}" → args: {'amount': '100'}
//
// 在 widget 中使用:
//   - 直接调 tr('key') 即可,不需要 context
//   - I18nStore 变化时,main.dart 的 ListenableBuilder 会重建整个 MaterialApp
// ============================================================================

import 'dart:async';
import 'dart:convert';
import 'dart:ui' show Locale;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show rootBundle;

import 'locale_detector.dart';
import 'locales.dart';

class I18nStore extends ChangeNotifier {
  I18nStore._();
  static final I18nStore instance = I18nStore._();

  // ─── 状态 ──────────────────────────────────────────────

  /// 当前语言代码(如 'zh' / 'en' / 'ja')
  String _localeCode = kDefaultLocaleCode;
  String get localeCode => _localeCode;

  /// 当前 Locale 对象(给 MaterialApp.locale 用)
  Locale get locale => Locale(_localeCode);

  /// 当前是否为 RTL
  bool get isRTL => isRtlLocale(_localeCode);

  /// 当前语言的翻译表(扁平 key→value)
  Map<String, String> _messages = const {};

  /// 中文兜底翻译表(任何语言缺失的 key 都回退到这里)
  Map<String, String> _fallbackMessages = const {};

  /// 是否已完成初始化(加载 JSON + 检测语言)
  bool _initialized = false;
  bool get initialized => _initialized;

  /// 是否为「跟随系统」模式(用户未手动选过语言)
  bool _followSystem = true;
  bool get followSystem => _followSystem;

  /// 系统语言变化监听(跟随系统模式下实时切换)
  StreamSubscription<String>? _systemLocaleSub;

  // ─── 初始化 ────────────────────────────────────────────

  /// 启动时调用:加载中文兜底 + 检测系统语言 + 加载对应 JSON。
  /// 必须在 runApp 之前 await 完。
  Future<void> init() async {
    if (_initialized) return;

    // 1. 加载中文兜底(永久驻留内存,任何语言缺失 key 都回退到这里)
    _fallbackMessages = await _loadJson(kDefaultLocaleCode);

    // 2. 检测用户语言(持久化选择 > 系统语言 > 默认中文)
    _localeCode = await detectUserLocale();
    _followSystem = !await hasUserOverrideLocale();

    // 3. 加载当前语言 JSON(如果和中文相同就直接复用)
    if (_localeCode == kDefaultLocaleCode) {
      _messages = _fallbackMessages;
    } else {
      _messages = await _loadJson(_localeCode);
      // 加载失败 → 回退中文
      if (_messages.isEmpty) {
        _messages = _fallbackMessages;
        _localeCode = kDefaultLocaleCode;
      }
    }

    // 4. 订阅系统语言变化 —— 「跟随系统」模式下浏览器/系统语言改了能实时跟
    _systemLocaleSub?.cancel();
    _systemLocaleSub = systemLocaleChanges.listen(_onSystemLocaleChanged);

    _initialized = true;
    if (kDebugMode) {
      debugPrint('[I18n] initialized: locale=$_localeCode, '
          'followSystem=$_followSystem, keys=${_messages.length}');
    }
  }

  /// 系统语言变化回调:仅在「跟随系统」模式下生效。
  void _onSystemLocaleChanged(String newCode) {
    if (!_followSystem) return; // 用户手动选过语言,不跟随系统
    if (newCode == _localeCode) return;
    // 异步加载新语言 JSON 并切换(不持久化)
    _applyLocale(newCode, persist: false);
  }

  /// 内部:加载指定语言 JSON 并切换(不检查 followSystem 标志)。
  Future<void> _applyLocale(String code, {required bool persist}) async {
    final match = findLocaleByCode(code);
    if (match == null) return;
    if (match.code == _localeCode) return;

    Map<String, String> newMessages;
    if (match.code == kDefaultLocaleCode) {
      newMessages = _fallbackMessages;
    } else {
      newMessages = await _loadJson(match.code);
      if (newMessages.isEmpty) {
        newMessages = _fallbackMessages;
      }
    }
    _localeCode = match.code;
    _messages = newMessages;
    _followSystem = !persist;
    notifyListeners();
  }

  // ─── 切换语言 ──────────────────────────────────────────

  /// 切换到指定语言代码。
  /// [persist] 为 true 时持久化用户选择(用户手动切换时传 true)。
  Future<void> changeLocale(String code, {bool persist = true}) async {
    final match = findLocaleByCode(code);
    if (match == null) {
      debugPrint('[I18n] unsupported locale: $code');
      return;
    }
    if (match.code == _localeCode) return;

    // 加载新语言 JSON
    Map<String, String> newMessages;
    if (match.code == kDefaultLocaleCode) {
      newMessages = _fallbackMessages;
    } else {
      newMessages = await _loadJson(match.code);
      if (newMessages.isEmpty) {
        debugPrint('[I18n] failed to load JSON for $code, fallback to zh');
        newMessages = _fallbackMessages;
      }
    }

    _localeCode = match.code;
    _messages = newMessages;
    _followSystem = !persist;

    if (persist) {
      await saveUserLocale(match.code);
    }

    notifyListeners();
    if (kDebugMode) {
      debugPrint('[I18n] changed locale to: $code, keys=${_messages.length}');
    }
  }

  /// 切回「跟随系统」模式:清除持久化选择,重新检测系统语言。
  Future<void> followSystemLocale() async {
    await clearUserLocale();
    final detected = await detectUserLocale();
    _followSystem = true;

    // 加载检测到的语言(不持久化)
    Map<String, String> newMessages;
    if (detected == kDefaultLocaleCode) {
      newMessages = _fallbackMessages;
    } else {
      newMessages = await _loadJson(detected);
      if (newMessages.isEmpty) {
        newMessages = _fallbackMessages;
      }
    }
    _localeCode = detected;
    _messages = newMessages;

    notifyListeners();
    if (kDebugMode) {
      debugPrint('[I18n] follow system: locale=$detected');
    }
  }

  // ─── 翻译 API ──────────────────────────────────────────

  /// 翻译 key 到当前语言。
  ///
  /// [args] 用于替换占位符:JSON 中 "余额: {amount}" + args={'amount':'100'} → "余额: 100"
  /// 缺失 key 走中文兜底,再缺失返回 key 本身(便于发现遗漏)。
  String tr(String key, {Map<String, String>? args}) {
    var value = _messages[key];
    if (value == null) {
      value = _fallbackMessages[key];
      if (value == null) {
        // 兜底:返回 key 本身,方便发现未翻译的项
        if (kDebugMode) {
          debugPrint('[I18n] missing key: $key');
        }
        return key;
      }
    }
    if (args != null && args.isNotEmpty) {
      for (final entry in args.entries) {
        value = value!.replaceAll('{${entry.key}}', entry.value);
      }
    }
    return value!;
  }

  /// 判断某 key 是否已翻译(用于条件渲染)。
  bool hasKey(String key) =>
      _messages.containsKey(key) || _fallbackMessages.containsKey(key);

  // ─── JSON 加载 ─────────────────────────────────────────

  /// 从 assets/i18n/{code}.json 加载翻译表。
  /// 失败返回空 Map(调用方走中文兜底)。
  Future<Map<String, String>> _loadJson(String code) async {
    try {
      final raw = await rootBundle.loadString('assets/i18n/$code.json');
      final decoded = json.decode(raw);
      if (decoded is! Map) return const {};
      // 扁平化:JSON 嵌套结构 {home:{title:'x'}} → {'home.title':'x'}
      final flat = <String, String>{};
      _flatten(decoded.cast<String, dynamic>(), '', flat);
      return flat;
    } catch (e) {
      debugPrint('[I18n] failed to load $code.json: $e');
      return const {};
    }
  }

  /// 把嵌套 Map 扁平化成点分 key。
  void _flatten(
      Map<String, dynamic> source, String prefix, Map<String, String> target) {
    for (final entry in source.entries) {
      final key = prefix.isEmpty ? entry.key : '$prefix.${entry.key}';
      final value = entry.value;
      if (value is Map) {
        _flatten(value.cast<String, dynamic>(), key, target);
      } else if (value is String) {
        target[key] = value;
      } else if (value != null) {
        target[key] = value.toString();
      }
    }
  }
}

// ─── 全局便捷函数 ──────────────────────────────────────────

/// 翻译便捷函数。直接调用 I18nStore 单例。
///
/// ```dart
/// Text(tr('home.title'))
/// Text(tr('wallet.balance', args: {'amount': '100.50'}))
/// ```
String tr(String key, {Map<String, String>? args}) =>
    I18nStore.instance.tr(key, args: args);
