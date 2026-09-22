// ============================================================================
// system_locale_reader_web — Web 端系统语言读取(WASM 兼容)
// ----------------------------------------------------------------------------
// 用 dart:js_interop 直接读 navigator.languages(用户偏好语言数组,首选在前),
// 而非 PlatformDispatcher.instance.locale —— 后者在 Web 上可能不正确反映
// 浏览器实际语言设置(尤其当 <html lang> 属性缺失或浏览器 UI 语言与
// 网页语言偏好不同时)。
//
// dart:js_interop 是 WASM 兼容的,在 dart2js 和 dart2wasm 编译模式下都能工作。
//
// navigator.languages 返回如 ['zh-CN', 'zh', 'en-US', 'en'],
// 调用方遍历取第一个匹配 kSupportedLocales 的语言。
// ============================================================================

import 'dart:js_interop';

/// 读取浏览器偏好语言列表(Web 实现)。
/// navigator.languages 是用户在浏览器设置中配置的语言偏好(首选在前)。
List<String> readPlatformPreferredLanguages() {
  try {
    // 用 dart:js_interop 读 navigator.languages(WASM 兼容)
    final langs = _getNavigatorLanguages();
    if (langs != null && langs.isNotEmpty) {
      return langs;
    }
    // 回退到 navigator.language(单个字符串)
    final single = _getNavigatorLanguage();
    if (single != null && single.isNotEmpty) return [single];
  } catch (_) {
    // JS interop 调用失败,返回默认
  }
  return ['zh'];
}

/// 通过 JS interop 读取 navigator.languages
@JS('navigator.languages')
external JSArray<JSString>? get _navigatorLanguagesJS;

/// 通过 JS interop 读取 navigator.language
@JS('navigator.language')
external JSString? get _navigatorLanguageJS;

List<String>? _getNavigatorLanguages() {
  try {
    final jsArray = _navigatorLanguagesJS;
    if (jsArray == null) return null;
    final list = jsArray.toDart;
    if (list.isEmpty) return null;
    return list.map((e) => e.toDart).toList();
  } catch (_) {
    return null;
  }
}

String? _getNavigatorLanguage() {
  try {
    final jsStr = _navigatorLanguageJS;
    if (jsStr == null) return null;
    return jsStr.toDart;
  } catch (_) {
    return null;
  }
}
