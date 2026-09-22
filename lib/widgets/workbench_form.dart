// ============================================================================
// WorkbenchForm - 工作台 App 风表单组件库(2026-08-23)
// ----------------------------------------------------------------------------
// 解决"工作台像 web 表单"的痛点:所有 workbench 页统一用这套组件,
// 把原生 OutlineInputBorder / DropdownButton / Slider 全部换成 App 风。
//
// 设计语言:
//   • 圆角:输入框 16 / 卡片 20 / Chip 999(胶囊)
//   • 层级:白卡 + 0.5px 极轻描边 + 微弱投影,取代粗黑边框
//   • 强调:聚焦时边框/图标/标签统一走 AppColors.primary,
//     主按钮统一品牌 ctaGradient
//   • 反馈:点按 InkWell ripple,聚焦态 color tween,选中态 渐变 + 对勾
//   • 排版:label 在上(13px w600),输入框/控件在下,8px 间距,纵向节奏 16px
//
// 用法:
//   WbTextField(label: '软件名称', hint: '...', controller: c, icon: ...)
//   WbTextArea(label: '描述', controller: c, maxLines: 5)
//   WbDropdown<T>(label: '类型', value: v, items: [...], onChanged: ...)
//   WbChips<T>(label: '风格', options: [...], value: v, onChanged: ...)
//   WbSlider(label: '时长', value: v, min: 5, max: 60, onChanged: ...)
//   WbUploadZone(label: '上传素材', hint: '...', onTap: ...)
//   WbSubmitButton(label: '一键生成', loading: _submitting, onTap: _submit)
// ============================================================================

import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import '../theme/app_dimens.dart';
import '../../i18n/i18n.dart';
export 'workbench_studio.dart';

// ─── 表单字段容器:统一 label + 描述 + 控件的纵向节奏 ──────────────────────

class WbField extends StatelessWidget {
  final String label;
  final String? hint; // label 旁的辅助说明
  final Widget child;
  final bool required;

  const WbField({
    super.key,
    required this.label,
    this.hint,
    this.required = false,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Flexible(child: Text(
              label,
              style: AppTextStyles.labelLarge.copyWith(
                color: AppColors.textPrimary,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.1,
              ),
              maxLines: 1, overflow: TextOverflow.ellipsis)),
            if (required) ...[
              const SizedBox(width: AppSpacing.xs),
              Text(
                '*',
                style: AppTextStyles.labelLarge.copyWith(color: AppColors.danger, fontWeight: FontWeight.w700),
              ),
            ],
            if (hint != null) ...[
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  hint!,
                  style: AppTextStyles.labelSmall.copyWith(
                    color: AppColors.textTertiary,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        child,
      ],
    );
  }
}

// ─── 文本输入框(单行) ─────────────────────────────────────────────────────

class WbTextField extends StatelessWidget {
  final String? label;
  final String? hint;
  final TextEditingController controller;
  final IconData? icon;
  final TextInputType? keyboardType;
  final ValueChanged<String>? onChanged;
  final bool enabled;
  final bool required;

  const WbTextField({
    super.key,
    this.label,
    this.hint,
    required this.controller,
    this.icon,
    this.keyboardType,
    this.onChanged,
    this.enabled = true,
    this.required = false,
  });

  @override
  Widget build(BuildContext context) {
    final field = _InputShell(
      enabled: enabled,
      child: Row(
        children: [
          if (icon != null) ...[
            Icon(icon, size: 17, color: AppColors.textTertiary),
            const SizedBox(width: AppSpacing.sm),
          ],
          Expanded(
            child: TextField(
              controller: controller,
              enabled: enabled,
              keyboardType: keyboardType,
              onChanged: onChanged,
              style: AppTextStyles.bodyMedium.copyWith(
                color: AppColors.textPrimary,
                fontWeight: FontWeight.w500,
              ),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: AppTextStyles.bodyMedium.copyWith(color: AppColors.textTertiary),
                border: InputBorder.none,
                isCollapsed: true,
                contentPadding: EdgeInsets.zero,
              ),
            ),
          ),
        ],
      ),
    );
    if (label == null) return field;
    return WbField(label: label!, required: required, child: field);
  }
}

// ─── 多行文本框 ───────────────────────────────────────────────────────────

class WbTextArea extends StatelessWidget {
  final String? label;
  final String? hint;
  final TextEditingController controller;
  final int maxLines;
  final int? maxLength;
  final bool required;
  final bool enabled;
  final TextInputType? keyboardType;

  /// 内容变化回调。存在的理由:工作台要在用户粘贴正文时**实时**更新
  /// 「N 字」计数与开跑前预估(集数/镜头/积分)。没有它,那些数字只在
  /// 页面因别的原因重建时才刷新,粘贴完一万字却还显示 0 字。
  final ValueChanged<String>? onChanged;

  const WbTextArea({
    super.key,
    this.label,
    this.hint,
    required this.controller,
    this.maxLines = 5,
    this.maxLength,
    this.required = false,
    this.enabled = true,
    this.keyboardType,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final field = _InputShell(
      enabled: enabled,
      padding:
          const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.md),
      child: TextField(
        controller: controller,
        maxLines: maxLines,
        maxLength: maxLength,
        enabled: enabled,
        keyboardType: keyboardType,
        onChanged: onChanged,
        style: AppTextStyles.bodyMedium.copyWith(
          color: AppColors.textPrimary,
          fontWeight: FontWeight.w500,
          height: 1.5,
        ),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: AppTextStyles.bodyMedium.copyWith(color: AppColors.textTertiary, height: 1.5),
          border: InputBorder.none,
          isCollapsed: true,
          counterStyle: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary),
        ),
      ),
    );
    if (label == null) return field;
    return WbField(label: label!, required: required, child: field);
  }
}

// ─── 输入外壳:圆角白卡 + 细描边 + 聚焦态高亮 ──────────────────────────────

class _InputShell extends StatefulWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final bool enabled;

  const _InputShell({
    required this.child,
    this.padding = const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg, vertical: AppSpacing.md),
    this.enabled = true,
  });

  @override
  State<_InputShell> createState() => _InputShellState();
}

class _InputShellState extends State<_InputShell> {
  final _focusNode = FocusNode();
  bool _focused = false;

  @override
  void initState() {
    super.initState();
    _focusNode.addListener(() {
      if (mounted) setState(() => _focused = _focusNode.hasFocus);
    });
  }

  @override
  void dispose() {
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      focusNode: _focusNode,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
        decoration: BoxDecoration(
          color: widget.enabled
              ? AppColors.cardBg
              : AppColors.surfaceLight.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(AppColors.cardRadius),
          border: Border.all(
            color: _focused
                ? AppColors.primary.withValues(alpha: 0.55)
                : AppColors.border,
            width: _focused ? 1.2 : 0.8,
          ),
          boxShadow: _focused
              ? [
                  BoxShadow(
                    color: AppColors.primary.withValues(alpha: 0.08),
                    blurRadius: 12,
                    offset: const Offset(0, 3),
                  ),
                ]
              : [
                  BoxShadow(
                    color: AppColors.ink
                        .withValues(alpha: 0.03),
                    blurRadius: 6,
                    offset: const Offset(0, 2),
                  ),
                ],
        ),
        padding: widget.padding,
        child: widget.child,
      ),
    );
  }
}

// ─── 下拉选择(App 风) ────────────────────────────────────────────────────

class WbDropdown<T> extends StatelessWidget {
  final String? label;
  final T value;
  final List<WbDropdownItem<T>> items;
  final ValueChanged<T> onChanged;
  final IconData? icon;
  final bool required;

  const WbDropdown({
    super.key,
    this.label,
    required this.value,
    required this.items,
    required this.onChanged,
    this.icon,
    this.required = false,
  });

  @override
  Widget build(BuildContext context) {
    final body = _InputShell(
      padding:
          const EdgeInsets.symmetric(horizontal: AppSpacing.lg, vertical: AppSpacing.xs),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<T>(
          value: value,
          isExpanded: true,
          icon: Icon(Icons.expand_more_rounded,
              color: AppColors.textTertiary, size: 20),
          style: AppTextStyles.bodyMedium.copyWith(
            color: AppColors.textPrimary,
            fontWeight: FontWeight.w500,
          ),
          borderRadius: BorderRadius.circular(AppColors.cardRadius),
          dropdownColor: AppColors.cardBg,
          items: items.map((it) {
            return DropdownMenuItem<T>(
              value: it.value,
              child: Row(
                children: [
                  if (it.icon != null) ...[
                    Icon(it.icon,
                        size: 16, color: AppColors.textSecondary),
                    const SizedBox(width: AppSpacing.sm),
                  ],
                  Expanded(
                    child: Text(
                      it.label,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            );
          }).toList(),
          onChanged: (v) {
            if (v != null) onChanged(v);
          },
        ),
      ),
    );
    if (label == null) return body;
    return WbField(
      label: label!,
      required: required,
      child: Row(
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16, color: AppColors.textTertiary),
            const SizedBox(width: AppSpacing.sm),
          ],
          Expanded(child: body),
        ],
      ),
    );
  }
}

class WbDropdownItem<T> {
  final T value;
  final String label;
  final IconData? icon;
  const WbDropdownItem({
    required this.value,
    required this.label,
    this.icon,
  });
}

// ─── Chip 单选/多选(替代下拉/单选按钮组) ──────────────────────────────────

class WbChips<T> extends StatelessWidget {
  final String? label;
  final List<WbChipOption<T>> options;
  final T? value; // 单选
  final Set<T>? values; // 多选
  final ValueChanged<T>? onChanged;
  final ValueChanged<Set<T>>? onMultiChanged;
  final bool required;
  final bool scrollable;

  const WbChips({
    super.key,
    this.label,
    required this.options,
    this.value,
    this.values,
    this.onChanged,
    this.onMultiChanged,
    this.required = false,
    this.scrollable = false,
  }) : assert(
          (value != null && onChanged != null) ||
              (values != null && onMultiChanged != null),
          'either single-select (value+onChanged) or multi (values+onMultiChanged)',
        );

  bool _isSelected(T v) {
    if (values != null) return values!.contains(v);
    return value == v;
  }

  void _toggle(T v) {
    if (values != null && onMultiChanged != null) {
      final next = Set<T>.from(values!);
      if (next.contains(v)) {
        next.remove(v);
      } else {
        next.add(v);
      }
      onMultiChanged!(next);
    } else if (onChanged != null) {
      onChanged!(v);
    }
  }

  @override
  Widget build(BuildContext context) {
    final chips = options.map((opt) {
      final selected = _isSelected(opt.value);
      return Padding(
        padding: const EdgeInsets.only(right: AppSpacing.sm),
        child: _WbChip(
          label: opt.label,
          icon: opt.icon,
          selected: selected,
          onTap: () => _toggle(opt.value),
        ),
      );
    }).toList();

    final list = scrollable
        ? SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: chips),
          )
        : Wrap(spacing: 0, runSpacing: 8, children: chips);

    if (label == null) return list;
    return WbField(label: label!, required: required, child: list);
  }
}

class WbChipOption<T> {
  final T value;
  final String label;
  final IconData? icon;
  const WbChipOption({
    required this.value,
    required this.label,
    this.icon,
  });
}

class _WbChip extends StatelessWidget {
  final String label;
  final IconData? icon;
  final bool selected;
  final VoidCallback onTap;

  const _WbChip({
    required this.label,
    this.icon,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.pill),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.lg, vertical: AppSpacing.sm),
          decoration: BoxDecoration(
            gradient: selected ? AppColors.ctaGradient : null,
            color: selected ? null : AppColors.cardBg,
            borderRadius: BorderRadius.circular(AppRadius.pill),
            border: Border.all(
              color: selected
                  ? Colors.transparent
                  : AppColors.border,
              width: 0.8,
            ),
            boxShadow: selected
                ? [
                    BoxShadow(
                      color: AppColors.ctaGlow
                          .withValues(alpha: 0.30),
                      blurRadius: 10,
                      offset: const Offset(0, 3),
                    ),
                  ]
                : null,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                Icon(
                  icon,
                  size: 13,
                  color: selected
                      ? AppColors.ctaForeground
                      : AppColors.textSecondary,
                ),
                const SizedBox(width: AppSpacing.xs),
              ],
              Flexible(child: Text(
                label,
                style: AppTextStyles.labelLarge.copyWith(color: selected
                      ? AppColors.ctaForeground
                      : AppColors.textPrimary, letterSpacing: 0.1),
                      maxLines: 1, overflow: TextOverflow.ellipsis)),
              if (selected) ...[
                const SizedBox(width: AppSpacing.xs),
                Icon(Icons.check_rounded,
                    size: 13, color: AppColors.ctaForeground),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

// ─── 滑杆(App 风:细轨 + 大拖头 + 值标签) ──────────────────────────────────

class WbSlider extends StatelessWidget {
  final String? label;
  final double value;
  final double min;
  final double max;
  final int? divisions;
  final ValueChanged<double> onChanged;
  final String Function(double)? formatValue;
  final IconData? icon;

  const WbSlider({
    super.key,
    this.label,
    required this.value,
    required this.min,
    required this.max,
    this.divisions,
    required this.onChanged,
    this.formatValue,
    this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final text =
        formatValue?.call(value) ?? value.toStringAsFixed(0);
    final body = Container(
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg, vertical: AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.border, width: 0.8),
      ),
      child: Row(
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16, color: AppColors.textTertiary),
            const SizedBox(width: AppSpacing.md),
          ],
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 4,
                activeTrackColor: AppColors.primary,
                inactiveTrackColor:
                    AppColors.border.withValues(alpha: 0.5),
                thumbColor: AppColors.primary,
                overlayColor:
                    AppColors.primary.withValues(alpha: 0.15),
                thumbShape: const RoundSliderThumbShape(
                    enabledThumbRadius: 9),
                overlayShape: const RoundSliderOverlayShape(
                    overlayRadius: 18),
              ),
              child: Slider(
                value: value.clamp(min, max),
                min: min,
                max: max,
                divisions: divisions,
                onChanged: onChanged,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Container(
            padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.md, vertical: AppSpacing.xs),
            decoration: BoxDecoration(
              color: AppColors.primary.withValues(alpha: 0.10),
              borderRadius: BorderRadius.circular(AppColors.slotRadius),
            ),
            child: Text(
              text,
              style: AppTextStyles.numberSmall.copyWith(
                color: AppColors.primary,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ],
      ),
    );
    if (label == null) return body;
    return WbField(label: label!, child: body);
  }
}

// ─── 上传区(虚线占位 + 渐变 hover 提示) ────────────────────────────────────

class WbUploadZone extends StatelessWidget {
  final String? label;
  final String hint;
  final String? fileName; // 已选文件名
  final IconData icon;
  final VoidCallback? onTap;
  final VoidCallback? onRemove;

  const WbUploadZone({
    super.key,
    this.label,
    required this.hint,
    this.fileName,
    this.icon = Icons.cloud_upload_outlined,
    this.onTap,
    this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final body = Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        child: Container(
          padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.lg, vertical: AppSpacing.xl),
          decoration: BoxDecoration(
            color: fileName == null
                ? AppColors.surfaceLight.withValues(alpha: 0.4)
                : AppColors.cardBg,
            borderRadius: BorderRadius.circular(AppColors.cardRadius),
            border: Border.all(
              color: fileName == null
                  ? AppColors.border
                  : AppColors.primary.withValues(alpha: 0.4),
              width: fileName == null ? 1 : 1.2,
              style: fileName == null
                  ? BorderStyle.solid
                  : BorderStyle.solid,
            ),
          ),
          child: fileName == null
              ? Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          colors: [
                            AppColors.primary
                                .withValues(alpha: 0.15),
                            AppColors.ctaGlow
                                .withValues(alpha: 0.08),
                          ],
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                        ),
                        borderRadius: BorderRadius.circular(AppColors.cardRadius),
                      ),
                      child: Icon(icon,
                          size: 19, color: AppColors.primary),
                    ),
                    const SizedBox(width: AppSpacing.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment:
                            CrossAxisAlignment.start,
                        children: [
                          Text(
                            tr('workbench_dock.auto_006'),
                            style: AppTextStyles.bodyMedium
                                .copyWith(
                              color: AppColors.primary,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: AppSpacing.xxs),
                          Text(
                            hint,
                            style: AppTextStyles.labelSmall
                                .copyWith(
                              color: AppColors.textTertiary,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Icon(Icons.arrow_forward_ios_rounded,
                        size: 14, color: AppColors.textMuted),
                  ],
                )
              : Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        color: AppColors.success
                            .withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(AppColors.cardRadius),
                      ),
                      child: Icon(Icons.check_circle_rounded,
                          size: 19, color: AppColors.success),
                    ),
                    const SizedBox(width: AppSpacing.md),
                    Expanded(
                      child: Text(
                        fileName!,
                        style:
                            AppTextStyles.bodyMedium.copyWith(
                          color: AppColors.textPrimary,
                          fontWeight: FontWeight.w600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (onRemove != null)
                      GestureDetector(
                        onTap: onRemove,
                        child: Container(
                          padding: const EdgeInsets.all(AppSpacing.xs),
                          child: Icon(Icons.close_rounded,
                              size: 16,
                              color: AppColors.textTertiary),
                        ),
                      ),
                  ],
                ),
        ),
      ),
    );
    if (label == null) return body;
    return WbField(label: label!, child: body);
  }
}

// ─── 主提交按钮(渐变 + 光晕 + loading 态) ──────────────────────────────────

class WbSubmitButton extends StatelessWidget {
  final String label;
  final String? loadingLabel;
  final IconData? icon;
  final bool loading;
  final bool disabled;
  final VoidCallback? onTap;

  const WbSubmitButton({
    super.key,
    required this.label,
    this.loadingLabel,
    this.icon,
    this.loading = false,
    this.disabled = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final active = !disabled && !loading && onTap != null;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: active ? onTap : null,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        child: AnimatedOpacity(
          duration: const Duration(milliseconds: 180),
          opacity: active ? 1 : 0.55,
          child: Container(
            height: 54,
            decoration: BoxDecoration(
              gradient: AppColors.ctaGradient,
              borderRadius: BorderRadius.circular(AppColors.cardRadius),
              boxShadow: [
                BoxShadow(
                  color: AppColors.ctaGlow.withValues(alpha: 0.35),
                  blurRadius: 18,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: Center(
              child: loading
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: AppSpacing.xl,
                          height: AppSpacing.xl,
                          child: CircularProgressIndicator(
                            strokeWidth: 2.4,
                            color: AppColors.ctaForeground,
                          ),
                        ),
                        const SizedBox(width: AppSpacing.md),
                        Flexible(child: Text(
                          loadingLabel ?? tr('paywall.processing'),
                          style: AppTextStyles.titleMedium.copyWith(color: AppColors.ctaForeground, letterSpacing: 0.5, fontWeight: FontWeight.w700),
                          maxLines: 1, overflow: TextOverflow.ellipsis)),
                      ],
                    )
                  : Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (icon != null) ...[
                          Icon(icon,
                              color: AppColors.ctaForeground,
                              size: 18),
                          const SizedBox(width: AppSpacing.sm),
                        ],
                        Flexible(child: Text(
                          label,
                          style: AppTextStyles.titleMedium.copyWith(color: AppColors.ctaForeground, letterSpacing: 0.5, fontWeight: FontWeight.w800),
                          maxLines: 1, overflow: TextOverflow.ellipsis)),
                      ],
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

// ─── 说明/提示卡(替代生硬的 Alert) ─────────────────────────────────────────

class WbInfoCard extends StatelessWidget {
  final IconData icon;
  final String text;
  final Color? accent;

  const WbInfoCard({
    super.key,
    required this.icon,
    required this.text,
    this.accent,
  });

  @override
  Widget build(BuildContext context) {
    final c = accent ?? AppColors.primary;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            c.withValues(alpha: 0.08),
            c.withValues(alpha: 0.03),
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: c.withValues(alpha: 0.20)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: c.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(AppColors.slotRadius),
            ),
            child: Icon(icon, size: 16, color: c),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Text(
              text,
              style: AppTextStyles.bodySmall.copyWith(
                color: AppColors.textSecondary,
                height: 1.55,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ─── 宽屏约束:工作台表单主体的可读宽度上限 ────────────────────────────────

/// 工作台表单主体的宽屏约束 —— 窄屏(<= maxWidth)铺满,超宽屏限制
/// 可读宽度并居中。
///
/// 为什么需要:工作台页的 body 结构统一是
/// `Column([WorkbenchProgressDock, Expanded(滚动表单)])`,主场景是手机宽度
/// (320~430)。但在平板 / 桌面浏览器下,单列表单会被拉到 1400px+ ——
/// label 与它下面的输入框相距半米,一行正文横跨整个屏幕,可读性与可点性
/// 一起崩。这里只做一件事:内容超过 [maxWidth] 时收窄并居中。
///
/// 窄屏**完全无影响**:maxWidth 大于可用宽度时直接返回原 child,不引入
/// 任何额外层级;这也是 workbench_visual_regression_test(320/360) 不会
/// 因为本组件产生溢出的原因。
class WbFormBody extends StatelessWidget {
  final Widget child;

  /// 内容最大宽度。760 ≈ 45~55 个中文字符 / 行,是单列表单的经验上限。
  final double maxWidth;

  const WbFormBody({
    super.key,
    required this.child,
    this.maxWidth = 760,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (ctx, c) {
      if (c.maxWidth <= maxWidth) return child;
      return Center(
        child: SizedBox(
          width: maxWidth,
          // Expanded 内高度有界;显式撑满避免 Center 把内容垂直居中
          height: c.maxHeight.isFinite ? c.maxHeight : null,
          child: child,
        ),
      );
    });
  }
}

// ─── 页面容器:统一卡片化包裹表单 ────────────────────────────────────────────

class WbCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final EdgeInsetsGeometry? margin;

  /// 底色覆盖。默认 [AppColors.cardBg];只有「语义态卡片」才传
  /// (如成功提示卡走 success 淡底),不要用它做普通装饰。
  final Color? color;

  const WbCard({
    super.key,
    required this.child,
    this.padding,
    this.margin,
    this.color,
  });

  /// 无外边距变体 —— 外层容器已有 padding、或本卡是列表项时使用。
  /// 默认 [WbCard] 带 16px 水平外边距,在已缩进的容器里会二次缩进。
  const WbCard.flat({
    super.key,
    required this.child,
    this.padding,
    this.color,
  }) : margin = EdgeInsets.zero;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: margin ?? const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.md, AppSpacing.lg, 0),
      padding: padding ?? const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: color ?? AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.border, width: 0.6),
        boxShadow: [
          BoxShadow(
            color: AppColors.ink.withValues(alpha: 0.04),
            blurRadius: 20,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: child,
    );
  }
}

/// 只读状态胶囊 —— 语义色淡底 + 同色文字。
///
/// **不要和 `WbChips` 混用**:那个是「可点选的选项组」,本组件是「只读的结果展示」。
///
/// 2026-09-17 收敛自 `episode_step_views._Tag` 与 `drama_list_page._StatusChip`
/// —— 两者逐字雷同,仅差一圈描边,故把描边做成参数而不是留两份实现。
///
/// ⚠️ 圆角走 `AppColors.tagRadius`。`novel_drama_workbench_page._GateStatusChip`
/// 仍是独立的 `AppRadius.pill` 实现,**未并入** —— 那是「要不要统一成 tagRadius」
/// 的设计取舍,需要单独拍板,不能顺手改掉。
class WbStatusTag extends StatelessWidget {
  final String label;
  final Color color;

  /// 是否需要同色描边。`_StatusChip` 原来有、`_Tag` 原来没有,故做成开关。
  final bool bordered;

  const WbStatusTag({
    super.key,
    required this.label,
    required this.color,
    this.bordered = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.sm, vertical: AppSpacing.xxs),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppColors.tagRadius),
        border: bordered ? Border.all(color: color.withValues(alpha: 0.5)) : null,
      ),
      child: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: AppTextStyles.labelSmall
            .copyWith(color: color, fontWeight: FontWeight.w600),
      ),
    );
  }
}
