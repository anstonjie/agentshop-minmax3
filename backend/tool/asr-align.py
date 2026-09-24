#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# asr-align.py —— faster-whisper 词级对齐 CLI(被 asr-align.ts 子进程调用)
# ----------------------------------------------------------------------------
# 契约(调用方 asr-align.ts 写死,改这里必须同步改那边):
#   用法: python tool/asr-align.py <媒体文件> [model] --json
#   成功: stdout 最后一行是 JSON {"words":[{"word,startSec,endSec}],language,durationSec}
#   退出码 2 = faster-whisper 未安装(环境不具备,不是本次失败)
#   其余非零 = 本次失败(stderr 尾 3 行会被截进日志)
# 2026-09-24:误删后按契约重建。faster-whisper 侧 stdout 可能混 warnings,
#   调用方只取"最后一个含 words 的 JSON 行",故本脚本只打印一行 JSON。
# ----------------------------------------------------------------------------
import argparse
import json
import sys


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='faster-whisper word-level align')
    ap.add_argument('media', help='audio/video file path')
    ap.add_argument('model', nargs='?', default='tiny',
                    help='tiny/base/small/medium (default: tiny)')
    ap.add_argument('--json', action='store_true',
                    help='print result JSON on stdout')
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print('faster-whisper is not installed', file=sys.stderr)
        return 2

    try:
        model = WhisperModel(args.model, device='auto')
        segments, info = model.transcribe(args.media, word_timestamps=True)
        words = []
        for seg in segments or []:
            for w in (getattr(seg, 'words', None) or []):
                text = (w.word or '').strip()
                if not text:
                    continue
                try:
                    start = float(w.start)
                    end = float(w.end)
                except (TypeError, ValueError):
                    continue
                words.append({'word': text, 'startSec': start, 'endSec': end})
        payload = {
            'words': words,
            'language': getattr(info, 'language', None),
            'durationSec': getattr(info, 'duration', None),
        }
        # 只打一行 JSON:warnings 走 stderr,调用方按行向前找含 words 的行
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001 —— CLI 兜底:任何异常转非零退出
        print(f'asr-align failed: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
