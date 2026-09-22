// ============================================================================
// AppToast — 全站统一轻量反馈(2026-09-14 UI 一致性整改)
// ----------------------------------------------------------------------------
// 收口三类散落写法:
//   1. SnackBar(content: Text('硬编码中文'))   → 文案必须走 tr(),切语言即时生效
//   2. 各调用点手写 duration/behavior/背景色      → 全部读主题 snackBarTheme
//   3. 连续操作堆叠一长串 toast                  → 内部 clearSnackBars() 只保最新
//
// 用法:
//   AppToast.show(context, 'task.accept_ok');            // 普通
//   AppToast.show(context, 'common.saved');              // 传 key,tr() 内部翻译
//   AppToast.show(context, '任务不存在', raw: true);       // 动态字符串(少用)
//   AppToast.error(context, 'common.failed', error: e);  // 失败态(错误色)
//   AppToast.show(context, 'agent.published',            // 带动作按钮
//       type: AppToastType.success,
//       actionLabel: 'nav.home', onAction: () {...});
//   AppToast.via(messenger, 'common.copied');            // await 之后(async gap)
//
// 约定:
//   - 静态文案一律传 i18n key(如 'task.accept_ok'),禁止传中文字面量;
//     动态拼接文本(含 id/异常消息)才用 raw: true。
//   - 类型色条:左侧 3px 竖条区分 success / warning / error / info。
//   - 动作按钮前景一律走 AppColors.onColor(bg),禁止写死 Colors.white / 主色。
//   - **不要在 await 之后传 context**:取 messenger 走 via(),或用
//     `if (!context.mounted) return;`(State 内用 `if (!mounted) return;`)守卫。
// ============================================================================
import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../theme/app_colors.dart';
import '../theme/app_dimens.dart';

enum AppToastType { info, success, warning, error }

class AppToast {
  AppToast._();

  /// 统一入口。
  ///
  /// [message] 优先按 i18n key 翻译(tr() 缺失时回退原文,即 raw 语义),
  /// 因此直接传中文也能显示 —— 但新代码请养成传 key 的习惯。
  static void show(
    BuildContext context,
    String message, {
    Map<String, String>? args,
    AppToastType type = AppToastType.info,
    Duration duration = const Duration(milliseconds: 2200),
    bool raw = false,
    String? actionLabel,
    VoidCallback? onAction,
  }) =>
      via(
        ScaffoldMessenger.of(context),
        message,
        args: args,
        type: type,
        duration: duration,
        raw: raw,
        actionLabel: actionLabel,
        onAction: onAction,
      );

  /// async gap 之后的入口 —— 传先前捕获的 [messenger]。
  ///
  /// `await` 之后再写 `AppToast.show(context, ...)` 会触发
  /// `use_build_context_synchronously`(页面可能已销毁),所以这种场景
  /// 在 await 之前 `final m = ScaffoldMessenger.of(context);`,await 之后走这里。
  static void via(
    ScaffoldMessengerState messenger,
    String message, {
    Map<String, String>? args,
    AppToastType type = AppToastType.info,
    Duration duration = const Duration(milliseconds: 2200),
    bool raw = false,
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    final text = raw ? message : tr(message, args: args);
    // 连续触发只保留最新一条,不再堆叠
    messenger.clearSnackBars();

    final fg = AppColors.background;
    final accentColor = switch (type) {
      AppToastType.info => AppColors.info,
      AppToastType.success => AppColors.success,
      AppToastType.warning => AppColors.warning,
      AppToastType.error => AppColors.danger,
    };
    final bg = type == AppToastType.error
        ? AppColors.danger
        : AppColors.textPrimary;

    messenger.showSnackBar(
      SnackBar(
        duration: duration,
        backgroundColor: bg,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppColors.cardRadius),
        ),
        action: (actionLabel != null && onAction != null)
            ? SnackBarAction(
                label: tr(actionLabel),
                // 动作按钮压在 toast 底色上 —— 前景必须由底色亮度推导,不能写死白/主色
                textColor: AppColors.onColor(bg),
                onPressed: onAction,
              )
            : null,
        content: Row(
          children: [
            // 类型色条:普通态默认主色底,左侧细竖条给 success/warning/info 区分
            Container(
              width: 3,
              height: 16,
              decoration: BoxDecoration(
                color: type == AppToastType.info ? fg : accentColor,
                borderRadius: BorderRadius.circular(AppColors.tagRadius),
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Text(
                text,
                style: TextStyle(
                  color: fg,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 失败反馈便捷方法(危险色背景 + 自动拼异常消息)
  static void error(BuildContext context, String message, {Object? error}) {
    final detail = error?.toString().replaceFirst('Exception: ', '');
    final text = (detail == null || detail.isEmpty)
        ? message
        : '$message:$detail';
    // 异常消息是动态文本,不做 key 翻译
    show(context, text, type: AppToastType.error, raw: true);
  }

  /// 成功反馈便捷方法
  static void success(BuildContext context, String message) =>
      show(context, message, type: AppToastType.success);
}
