// ============================================================================
// locale_detector — 自动检测用户语言(浏览器 / 系统)
// ----------------------------------------------------------------------------
// 启动时优先级:
//   1. SharedPreferences 持久化的用户选择(用户手动切过语言)
//   2. 平台系统语言(Web 走 navigator.languages,Native 走 PlatformDispatcher)
//      遍历所有偏好语言,取第一个匹配 kSupportedLocales 的
//   3. 默认中文(kDefaultLocaleCode)
//
// Web 检测:读取 window.navigator.languages 数组(首选在前),
//   依次解析出主语言标签(如 zh-CN → zh,en-US → en),匹配 kSupportedLocales。
//   这比只读 navigator.language 更准确 —— 浏览器 UI 可能是英文但用户
//   把中文设为首选网页语言。
//
// Native 检测:PlatformDispatcher.instance.locale.languageCode,
//   Android/iOS 系统语言设置决定。
// ============================================================================

import 'dart:async';
import 'dart:ui' as ui show PlatformDispatcher;

import 'package:shared_preferences/shared_preferences.dart';

import 'locales.dart';

// 条件导入:Web 端用 dart:js_interop 读 navigator.languages(WASM 兼容),
// Native 端用 PlatformDispatcher.instance.locale
import 'system_locale_reader.dart'
    if (dart.library.js_interop) 'system_locale_reader_web.dart' as reader;

/// SharedPreferences 中持久化用户语言选择的 key。
const _kLocalePrefKey = 'user_locale_code';

/// 检测用户首选语言。
///
/// 返回值是语言代码(如 'zh' / 'en' / 'ja'),不会返回 null。
/// 检测顺序见文件头注释。
Future<String> detectUserLocale() async {
  // 1. 持久化的用户选择(最高优先级)
  try {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(_kLocalePrefKey);
    if (saved != null && saved.isNotEmpty) {
      final match = findLocaleByCode(saved);
      if (match != null) return match.code;
    }
  } catch (_) {
    /* SharedPreferences 读取失败不阻塞 */
  }

  // 2. 平台系统语言(遍历所有偏好语言,取第一个匹配的)
  final systemLang = detectSystemLocale();
  if (systemLang != kDefaultLocaleCode) return systemLang;

  // 3. 默认中文
  return kDefaultLocaleCode;
}

/// 同步检测系统语言:遍历平台偏好语言列表,返回第一个匹配 kSupportedLocales
/// 的语言代码。都不匹配则返回 kDefaultLocaleCode。
///
/// 与 [detectUserLocale] 不同,此函数不读 SharedPreferences,只看系统/浏览器。
/// 用于「跟随系统」模式下监听到系统语言变化时快速切换。
String detectSystemLocale() {
  final langs = reader.readPlatformPreferredLanguages();
  for (final lang in langs) {
    final match = findLocaleByCode(lang);
    if (match != null) return match.code;
  }
  return kDefaultLocaleCode;
}

/// 持久化用户手动选择的语言代码。
Future<void> saveUserLocale(String code) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kLocalePrefKey, code);
  } catch (_) {
    /* 持久化失败不阻塞 UI */
  }
}

/// 清除持久化的语言选择(回到「跟随系统」)。
Future<void> clearUserLocale() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kLocalePrefKey);
  } catch (_) {
    /* ignore */
  }
}

/// 读取当前用户是否手动选择过语言(用于设置页判断「跟随系统」是否选中)。
Future<bool> hasUserOverrideLocale() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(_kLocalePrefKey);
    return saved != null && saved.isNotEmpty;
  } catch (_) {
    return false;
  }
}

/// 监听系统语言变化(Web 端用户改浏览器语言、Native 端改系统语言)。
/// 返回 Stream<String>,每收到一个事件就是新的语言代码(已匹配支持列表)。
/// 调用方可以据此在「跟随系统」模式下实时切换。
Stream<String> get systemLocaleChanges {
  // PlatformDispatcher.onLocaleChanged 是全局回调,这里包成 Stream
  final controller = StreamController<String>.broadcast();
  ui.PlatformDispatcher.instance.onLocaleChanged = () {
    final detected = detectSystemLocale();
    controller.add(detected);
  };
  return controller.stream;
}
