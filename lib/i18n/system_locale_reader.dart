// ============================================================================
// system_locale_reader — 平台系统语言读取(Native 默认实现)
// ----------------------------------------------------------------------------
// Web 端会通过条件导入替换为 system_locale_reader_web.dart(用 dart:html
// 直接读 navigator.languages,解决 PlatformDispatcher 在 Web 上可能不正确
// 反映浏览器语言的问题)。
//
// 接口:
//   readPlatformPreferredLanguages() → 返回用户偏好语言列表,首选在前。
//   调用方依次遍历,取第一个匹配 kSupportedLocales 的语言。
// ============================================================================

import 'dart:ui' as ui;

/// 读取平台偏好语言列表(Native 实现)。
/// Native 端 PlatformDispatcher 只提供单个 locale,包装成单元素列表。
List<String> readPlatformPreferredLanguages() {
  final locale = ui.PlatformDispatcher.instance.locale;
  final code = (locale.countryCode != null && locale.countryCode!.isNotEmpty)
      ? '${locale.languageCode}-${locale.countryCode}'
      : locale.languageCode;
  return [code];
}
