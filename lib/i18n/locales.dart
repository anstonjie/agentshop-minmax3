// ============================================================================
// supportedLocales — 多语言清单(14 种,覆盖全球主要市场)
// ----------------------------------------------------------------------------
//   zh  中文(简体)    — 默认/兜底语言
//   en  English       — 全球通用
//   ja  日本語         — 日本市场
//   ko  한국어          — 韩国市场
//   es  Español       — 西班牙/拉美
//   fr  Français      — 法国/法语非洲
//   de  Deutsch       — 德国/奥地利/瑞士
//   ar  العربية        — 中东(RTL,需布局镜像)
//   th  ไทย            — 泰国
//   vi  Tiếng Việt    — 越南
//   id  Bahasa Indonesia — 印尼
//   ms  Bahasa Melayu — 马来西亚/印尼
//   fil Filipino      — 菲律宾
//   pt  Português     — 葡萄牙/巴西
// ============================================================================

import 'package:flutter/material.dart';

/// 单条语言描述。
class AppLocale {
  final String code;       // 语言代码,如 'zh' / 'en' / 'ja'
  final String displayName; // 用该语言自身书写的名称(展示用)
  final String englishName; // 英文名称(辅助识别)
  final String flag;        // 国旗 emoji
  final bool isRTL;         // 是否从右到左书写

  const AppLocale({
    required this.code,
    required this.displayName,
    required this.englishName,
    required this.flag,
    this.isRTL = false,
  });

  Locale get locale => Locale(code);
}

/// 全局支持的语言清单。顺序即设置页展示顺序。
const List<AppLocale> kSupportedLocales = [
  AppLocale(code: 'zh', displayName: '简体中文', englishName: 'Chinese', flag: '🇨🇳'),
  AppLocale(code: 'en', displayName: 'English', englishName: 'English', flag: '🇬🇧'),
  AppLocale(code: 'ja', displayName: '日本語', englishName: 'Japanese', flag: '🇯🇵'),
  AppLocale(code: 'ko', displayName: '한국어', englishName: 'Korean', flag: '🇰🇷'),
  AppLocale(code: 'es', displayName: 'Español', englishName: 'Spanish', flag: '🇪🇸'),
  AppLocale(code: 'fr', displayName: 'Français', englishName: 'French', flag: '🇫🇷'),
  AppLocale(code: 'de', displayName: 'Deutsch', englishName: 'German', flag: '🇩🇪'),
  AppLocale(code: 'ar', displayName: 'العربية', englishName: 'Arabic', flag: '🇸🇦', isRTL: true),
  AppLocale(code: 'th', displayName: 'ไทย', englishName: 'Thai', flag: '🇹🇭'),
  AppLocale(code: 'vi', displayName: 'Tiếng Việt', englishName: 'Vietnamese', flag: '🇻🇳'),
  AppLocale(code: 'id', displayName: 'Bahasa Indonesia', englishName: 'Indonesian', flag: '🇮🇩'),
  AppLocale(code: 'ms', displayName: 'Bahasa Melayu', englishName: 'Malay', flag: '🇲🇾'),
  AppLocale(code: 'fil', displayName: 'Filipino', englishName: 'Filipino', flag: '🇵🇭'),
  AppLocale(code: 'pt', displayName: 'Português', englishName: 'Portuguese', flag: '🇵🇹'),
];

/// 默认语言(也是翻译缺失时的 fallback)。
const String kDefaultLocaleCode = 'zh';

/// 把 Locale 列表暴露给 MaterialApp.supportedLocales。
List<Locale> get kMaterialSupportedLocales =>
    kSupportedLocales.map((e) => e.locale).toList();

/// 按代码查 AppLocale,找不到返回 null。
AppLocale? findLocaleByCode(String? code) {
  if (code == null || code.isEmpty) return null;
  // 精确匹配
  for (final l in kSupportedLocales) {
    if (l.code == code) return l;
  }
  // 前缀匹配:如 zh-CN → zh,en-US → en
  final prefix = code.split('-').first.split('_').first.toLowerCase();
  for (final l in kSupportedLocales) {
    if (l.code == prefix) return l;
  }
  return null;
}

/// 判断某语言代码是否为 RTL(从右到左)。
bool isRtlLocale(String? code) =>
    findLocaleByCode(code)?.isRTL ?? false;
