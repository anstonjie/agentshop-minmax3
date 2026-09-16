// ============================================================================
// NovelDramaWorkbenchPage —— 全新短视频一键生成 工作台(Novel2Drama)
// ----------------------------------------------------------------------------
// 双入口(最终方案 v6.0 §1:两路汇合于对齐引擎):
//   入口 A「AI 生成小说」:标题 → POST /api/dramas/novel-gen/start
//     → 轮询 GET /api/dramas/novel-gen/tasks/:uuid(五级瀑布 L1-L5 逐章推进)
//     → 完成后自动 建剧 + ingest(source='generated')进对齐链路
//   入口 B「我有小说」:粘贴/上传 .txt → 建剧 + ingest(source='uploaded')
//
// 汇合后的共用链路:
//   POST /api/dramas                          建剧 { agentId, title }
//   POST /api/dramas/:uuid/novel/ingest       入库+建账本+建三道门
//   GET  /api/dramas/:uuid/novel/ledger       读账本(含 gates)
//   POST /api/dramas/:uuid/novel/gates/:gate/decide  审批门决策
//   POST /api/dramas/:uuid/novel/gates/:gate/retry   重拉设定/剧本/生产阶段
//
// 门状态机:waiting → passed/rejected(不通过不烧钱)
//   gate1_budget 报价门 | gate2_design 设定门 | gate3_script 剧本门
//
// 2026-09-14(Stage 2 接线):门决策驱动后端 NovelPipelineService 流水线 ——
//   ①过 → 自动生成角色/场景/画风设定(产物进 gate2.payload,本页轮询展示)
//   ②过 → 自动逐集生成承接大纲(剧本)
//   ③过 → 自动入队连集批次(分镜/关键帧/视频/成片),进度看
//         GET /api/dramas/batches/:uuid,精细管理走剧集详情页。
//   payload 状态机:{} → generating → ready/failed;③过成功后 producing。
// ============================================================================

import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../main.dart' show AppRoute;
import '../services/api_client.dart';
import '../theme/app_colors.dart';
import '../widgets/workbench_icons.dart';
import '../theme/app_text_styles.dart';
import '../utils/web_file_picker.dart';
import '../utils/web_download.dart';
import '../widgets/agent_cost_banner.dart';
import '../widgets/workbench_form.dart';
import '../theme/app_dimens.dart';
import '../utils/app_toast.dart';

class NovelDramaWorkbenchPage extends StatefulWidget {
  /// 发起新生成 / 新建剧时用得到;按 dramaUuid 恢复旧项目时可以为 0。
  final int agentId;
  final String? agentName;

  /// 非空 = 一进页面直接恢复到这部剧的账本视图(报价门 / 三道门 / 生产进度)。
  /// 2026-09-15:此前本页所有进度态都是纯内存字段,离开页面即全丢,
  /// 而 gates / batches 的续跑接口早就有 —— 缺的只是把 dramaUuid 交回前端。
  final String? dramaUuid;

  const NovelDramaWorkbenchPage({
    super.key,
    this.agentId = 0,
    this.agentName,
    this.dramaUuid,
  });

  @override
  State<NovelDramaWorkbenchPage> createState() =>
      _NovelDramaWorkbenchPageState();
}

class _NovelDramaWorkbenchPageState extends State<NovelDramaWorkbenchPage>
    with SingleTickerProviderStateMixin {
  final ApiClient _api = ApiClient();

  late final TabController _tabs;
  final _genTitleCtrl = TextEditingController();
  final _titleCtrl = TextEditingController();
  final _novelCtrl = TextEditingController();
  String _epTarget = '120';
  String _tier = 'demo'; // demo 2万 / novella 20万 / full 80万
  String _genGenre = '';

  // 生成任务态(入口 A)
  Map<String, dynamic>? _genTask;
  Timer? _pollTimer;
  bool _genStarting = false;

  // 账本态(两入口汇合)
  bool _submitting = false;
  bool _deciding = false;
  bool _ingesting = false;
  Map<String, dynamic>? _ledger;
  String? _dramaUuid;
  String? _error;

  // 断点续跑态(2026-09-15):进页面时从 GET /dramas/novel/active 认领的现场
  List<Map<String, dynamic>> _activeProjects = [];
  bool _restoring = true;

  /// 失败/中断的小说生成任务。进页面**不自动显示**(否则一进来就糊一张
  /// 「生成失败」红卡,用户还没操作就被甩一脸错误),只列进「未完成的项目」
  /// 成可点行;用户点哪条才把哪条设成 _genTask 显示失败卡 + 「从断点重试」。
  List<Map<String, dynamic>> _pausedGenTasks = [];

  // Stage 2 流水线态(2026-09-14):设定/剧本生成与连集生产进度轮询
  Timer? _stageTimer;
  Map<String, dynamic>? _batch; // /dramas/batches/:uuid 最新一次响应
  int _idlePolls = 0; // payload 迟迟未落 generating 的容错轮询计数

  // 工作台就地控制(2026-09-15):以前「暂停/取消/看成片/删项目」只能跳去
  // 剧集详情页或剧集列表页做,而工作台正是用户盯着进度的那一屏 —— 想暂停
  // 得先离开正在看的进度。这里把最常用的四个动作拉回来。
  bool _playing = false; // 拉剧集列表找成片 URL 的过程中
  bool _projectBusy = false; // 暂停/取消/删除这类会改状态的操作

  // 门② 定妆情况(2026-09-14):资产 `refs` 里没有可用图 = 还没定妆。
  // 没定妆就放行进剧本 → 每集关键帧全部 degraded(退化纯文生图),主角跨镜换脸。
  List<Map<String, dynamic>> _assets = [];
  bool _assetsLoaded = false;
  bool _assetsLoading = false;

  // 批量定妆(2026-09-15):门②通过后后端自动开跑,这里只负责把进度如实显示出来。
  // 状态源 GET /dramas/:uuid/assets/portrait-batch,后端每迁移一次就落库一次,
  // 所以刷新页面、换端、从资产库回来都能看到同一个 x/N,不会只剩一个转圈。
  Map<String, dynamic> _portrait = const {'status': 'idle'};
  bool _wasPortraitRunning = false;
  /// 一次性自重排(不用 Timer.periodic):跑批到终态后自然就不再排下一次
  Timer? _portraitTimer;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _tabs.addListener(() {
      // 切 Tab 清错误,保留各自表单与进行中状态
      if (!_tabs.indexIsChanging) setState(() => _error = null);
    });
    // 2026-09-15:进页面先认领现场。以前这里什么都没有 —— 所有进度态是纯内存字段,
    // 离开页面或刷新浏览器就回到空白表单,而库里正有任务在跑、项目正卡在门上。
    WidgetsBinding.instance.addPostFrameCallback((_) => _restore());
  }

  /// 恢复现场:① 入参带 dramaUuid → 直接打开那部剧的账本;
  /// ② 否则拉未完成清单,进行中的小说生成任务直接接管轮询,项目列成可点卡片。
  ///
  /// 任何失败都只记日志不拦人 —— 恢复不出来也得让人能正常新建,
  /// 所以 finally 里一定把 _restoring 关掉。
  Future<void> _restore() async {
    final seed = widget.dramaUuid;
    try {
      if (seed != null && seed.isNotEmpty) {
        _dramaUuid = seed;
        await _refreshLedger();
        if (_ledger == null) {
          _dramaUuid = null; // 账本不存在/不属于我 → 回空白表单
        } else {
          // 恢复出来若正停在「设定生成中 / 剧本生成中 / 连集生产中」,
          // 不开轮询就会看着一个不动的进度条 —— 与 _openProject 同一套收尾。
          _syncStagePolling();
        }
        return;
      }
      final r = _unwrap(await _api.dio
          .get('/dramas/novel/active', options: _fresh));
      if (r is! Map) return;
      _activeProjects = ((r['projects'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      final tasks = ((r['genTasks'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      if (tasks.isEmpty) return;
      // 2026-09-15:进页面**只接管正在跑的**任务(开轮询看实时进度)。
      //   失败/中断的任务不再自动认领 —— 旧逻辑 `running.isNotEmpty ? … : tasks.first`
      //   会在没有 running 时把最近一个 failed 任务直接设成 _genTask,导致用户一进
      //   页面就看到一张「生成失败 99%」红卡(实测投诉:还没做任何操作就被甩错误)。
      //   现在它们进 _pausedGenTasks,列在「未完成的项目」里等用户点。
      final running = tasks.where((t) => t['status'] == 'running').toList();
      _pausedGenTasks =
          tasks.where((t) => t['status'] != 'running').toList();
      if (running.isNotEmpty) {
        _genTask = running.first;
        _startPolling();
      }
    } catch (_) {
      // 静默:恢复失败退回空白表单,不影响新建
    } finally {
      if (mounted) setState(() => _restoring = false);
    }
  }

  /// 打开某个未完成项目(清单 / 书架「继续做剧」共用)
  Future<void> _openProject(String dramaUuid) async {
    if (dramaUuid.isEmpty) return;
    _pollTimer?.cancel();
    _stageTimer?.cancel();
    setState(() {
      _dramaUuid = dramaUuid;
      _ledger = null;
      _batch = null;
      _genTask = null;
      _error = null;
      _assets = [];
      _assetsLoaded = false;
      _resetPortraitView();
    });
    await _refreshLedger();
    if (!mounted) return;
    if (_ledger == null) {
      setState(() => _dramaUuid = null);
      _toast('这个项目没有对齐账本,可能已被删除', error: true);
      return;
    }
    _syncStagePolling();
  }

  /// 只刷「未完成的项目」清单(不动当前打开的剧)。
  ///
  /// 回到起点后要调一次:不然刚选择「保留」的项目得等下次进页面才出现在清单里,
  /// 用户会以为它被顺手删了。
  Future<void> _refreshActiveProjects() async {
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/novel/active', options: _fresh));
      if (r is! Map) return;
      final list = ((r['projects'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      if (mounted) setState(() => _activeProjects = list);
    } catch (_) {
      // 静默:清单拉不到不影响新建
    }
  }

  /// 清掉批量定妆态(换剧 / 回到起点共用)。轮询不停就会拿着上一部剧的进度
  /// 继续往新剧的卡片上写 —— 与今天门③ producing 假活是同一类事故。
  void _resetPortraitView() {
    _portraitTimer?.cancel();
    _portraitTimer = null;
    _portrait = const {'status': 'idle'};
    _wasPortraitRunning = false;
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _stageTimer?.cancel();
    _portraitTimer?.cancel();
    _tabs.dispose();
    _genTitleCtrl.dispose();
    _titleCtrl.dispose();
    _novelCtrl.dispose();
    super.dispose();
  }

  dynamic _unwrap(Response r) {
    final d = r.data;
    if (d is Map && d.containsKey('data')) return d['data'];
    return d;
  }

  /// 轮询 / 写后回读专用:绕开 ApiClient 的 GET 15s 响应缓存 + in-flight 去重。
  ///
  /// ⚠ 不加这个会踩「点两下才生效」:
  /// 账本每 4s 轮询一次 GET,响应被 ApiClient 缓存 15s;
  /// 用户点「确认设定,生成剧本」→ POST 成功 → 紧接着 `_refreshLedger()`
  /// 命中 15 秒前的旧缓存 → 旧账本(gate 仍 waiting)盖回内存 →
  /// UI 退化回「待确认」+ 按钮还在,看起来像没点;
  /// 等到缓存过期(15s)后再点一次,才看到真实状态。
  /// 进度轮询同理会被缓存拖慢最多 ~20s。
  Options get _fresh =>
      Options(extra: {'cache': false, 'dedup': false});

  String _errMsg(dynamic e) =>
      e is DioException ? ApiClient.describeError(e) : e.toString();

  // ── 入口 A:标题 → 生成小说 → 自动 ingest ────────────────────────────
  Future<void> _startGen() async {
    final title = _genTitleCtrl.text.trim();
    if (title.length < 2) {
      _toast('标题至少 2 个字', error: true);
      return;
    }
    setState(() { _genStarting = true; _error = null; });
    try {
      final r = _unwrap(await _api.dio.post('/dramas/novel-gen/start', data: {
        'agentId': widget.agentId,
        'title': title,
        'tier': _tier,
        if (_genGenre.isNotEmpty) 'genre': _genGenre,
      }));
      if (!mounted) return;
      setState(() {
        _genTask = (r is Map) ? Map<String, dynamic>.from(r) : null;
      });
      _startPolling();
      _toast('小说生成已启动,AI 正在构建世界观');
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _errMsg(e));
    } finally {
      if (mounted) setState(() => _genStarting = false);
    }
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 5), (_) => _pollGen());
  }

  Future<void> _pollGen() async {
    final uuid = _genTask?['uuid']?.toString();
    if (uuid == null || uuid.isEmpty) return;
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/novel-gen/tasks/$uuid', options: _fresh));
      if (!mounted || r is! Map) return;
      final status = r['status']?.toString();
      setState(() => _genTask = Map<String, dynamic>.from(r));
      if (status == 'completed') {
        _pollTimer?.cancel();
        _toast('小说生成完成,正在进入对齐引擎…');
        await _ingestGenerated(Map<String, dynamic>.from(r));
      } else if (status == 'failed') {
        _pollTimer?.cancel();
        setState(() => _error =
            '生成失败:${r['error'] ?? '未知原因'}(可换个标题或缩小规模重试)');
      }
    } catch (_) {
      // 轮询失败不打断,下个周期重试
    }
  }

  /// 小说完成 → 建剧 → ingest(source='generated' + novelGenTaskUuid,服务端按 key 读产物)
  ///
  /// ⚠ 必须防重入:_pollGen 是 Timer.periodic(5s) 且不挡重叠,两次轮询都读到
  /// status=completed 就会连发两次「建剧 + ingest」。实测代价就写在库里 ——
  /// 同名剧被重复建出 6~7 份(2026-09-14 22:51:11 同一秒 4 条)。
  Future<void> _ingestGenerated(Map<String, dynamic> task) async {
    if (_ingesting) return;
    _ingesting = true;
    try {
      final created = _unwrap(await _api.dio.post('/dramas', data: {
        'agentId': widget.agentId,
        'title': task['title'],
        'topic': 'novel-to-drama',
      }));
      final uuid = (created is Map) ? created['uuid']?.toString() : null;
      if (uuid == null) throw Exception('建剧失败:返回体缺 uuid');
      final ingest = _unwrap(await _api.dio.post(
        '/dramas/$uuid/novel/ingest',
        data: {
          'title': task['title'],
          'source': 'generated',
          'epTargetSec': int.tryParse(_epTarget) ?? 120,
          'novelGenTaskUuid': task['uuid'],
        },
      ));
      if (!mounted) return;
      setState(() {
        _dramaUuid = uuid;
        _ledger = (ingest is Map) ? Map<String, dynamic>.from(ingest) : null;
      });
      _toast('对齐账本已生成,请确认报价单');
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _errMsg(e));
    } finally {
      // 失败也必须放闸,否则一次报错就把「建剧 + ingest」永久锁死
      _ingesting = false;
    }
  }

  // ── 入口 B:粘贴/上传 → ingest ────────────────────────────────────────
  Future<void> _submit() async {
    final novel = _novelCtrl.text.trim();
    final title = _titleCtrl.text.trim();
    if (title.isEmpty) {
      _toast('请填写作品名', error: true);
      return;
    }
    if (novel.length < 50) {
      _toast('小说正文太短(至少 50 字)', error: true);
      return;
    }
    setState(() { _submitting = true; _error = null; });
    try {
      final created = _unwrap(await _api.dio.post('/dramas', data: {
        'agentId': widget.agentId,
        'title': title,
        'topic': 'novel-to-drama',
      }));
      final uuid = (created is Map) ? created['uuid']?.toString() : null;
      if (uuid == null || uuid.isEmpty) {
        throw Exception('建剧失败:返回体缺 uuid');
      }
      final ledger = _unwrap(await _api.dio.post(
        '/dramas/$uuid/novel/ingest',
        data: {
          'novelText': novel,
          'title': title,
          'source': 'uploaded',
          'epTargetSec': int.tryParse(_epTarget) ?? 120,
        },
      ));
      if (!mounted) return;
      setState(() {
        _dramaUuid = uuid;
        _ledger = (ledger is Map) ? Map<String, dynamic>.from(ledger) : null;
      });
      AgentCostBanner.refreshAllFor(widget.agentId);
      _toast('对齐账本已生成,请确认报价单');
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _errMsg(e));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // ── 门决策(共用) ─────────────────────────────────────────────────────
  Future<void> _decideGate(String gate, bool pass) async {
    if (_dramaUuid == null) return;
    setState(() => _deciding = true);
    try {
      final r = _unwrap(await _api.dio.post(
        '/dramas/$_dramaUuid/novel/gates/$gate/decide',
        data: {'decision': pass ? 'passed' : 'rejected'},
      ));
      // 写后失效:否则紧随其后的 _refreshLedger 会命中「写之前」的缓存,
      // 把刚落库的 gate 状态盖回 waiting(前端表现为"点了没反应")。
      _api.invalidate('/dramas/$_dramaUuid/novel/ledger');
      if (!mounted) return;
      setState(() {
        _ledger = (r is Map) ? Map<String, dynamic>.from(r) : _ledger;
      });
      _toast(pass ? '已通过' : '已驳回,可调整后重报');
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _deciding = false);
    }
    await _refreshLedger();
    _syncStagePolling();
  }

  /// 重拉门②/③对应的生成阶段(失败重试;或后端升级前已过门的历史剧恢复)
  Future<void> _retryGate(String gate) async {
    if (_dramaUuid == null) return;
    setState(() => _deciding = true);
    try {
      await _api.dio.post('/dramas/$_dramaUuid/novel/gates/$gate/retry');
      _api.invalidate('/dramas/$_dramaUuid/novel/ledger');
      await _refreshLedger();
      _toast('已重新拉起生成,进度稍后刷新');
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _deciding = false);
    }
    _syncStagePolling();
  }

  /// 把「已驳回」的门改回「待确认」—— 解除驳回。
  ///
  /// 为什么必须有它(2026-09-15):后端 decideGate 对非 waiting 状态直接抛
  /// ConflictException,而全链路没有任何 un-reject 入口,于是「驳回」实际是
  /// **终态** —— 用户手滑点一次,整部剧连同账本、已生成的角色/场景资产一起废掉,
  /// 唯一出路是删掉项目从零重来。实测剧 42 停在 gate2_design=rejected,救不回来。
  /// 而"驳回"的本意只是"这次不满意,我调一下再来"。
  ///
  /// 与 [_retryGate] 正交,别混:
  ///   retry  = 门的状态不动,把**生成阶段**重跑一遍(失败重试)
  ///   reopen = 门退回 waiting,让用户可以**重新决策**(驳回后悔)
  /// 驳回后想重新生成,顺序是先 reopen 再 retry。
  Future<void> _reopenGate(String gate) async {
    if (_dramaUuid == null) return;
    setState(() => _deciding = true);
    try {
      final r = _unwrap(await _api.dio.post(
        '/dramas/$_dramaUuid/novel/gates/$gate/reopen',
        data: const <String, dynamic>{},
      ));
      // 与 _decideGate 同理:不失效缓存的话紧随的 _refreshLedger 会把
      // "写之前"的旧账本(rejected)盖回内存,界面看起来像没点。
      _api.invalidate('/dramas/$_dramaUuid/novel/ledger');
      if (!mounted) return;
      setState(() {
        _ledger = (r is Map) ? Map<String, dynamic>.from(r) : _ledger;
      });
      _toast('已改回待确认,可重新决策');
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _deciding = false);
    }
    await _refreshLedger();
    _syncStagePolling();
  }

  /// 当前批次号。优先用批次详情的 uuid;轮询还没回来时退回账本 payload 上的
  /// batchUuid,否则用户第一次点会误报"没找到批次号"。
  String? get _batchUuid {
    final bu = _batch?['uuid']?.toString() ??
        _gatePayload('gate3_script')?['batchUuid']?.toString();
    return (bu == null || bu.isEmpty) ? null : bu;
  }

  /// 暂停 / 取消连集批次。
  ///
  /// 后端 worker 在**每集、每一步开始前**读一次 DB 状态,所以这两个动作都是
  /// 优雅的:在跑的那一步会跑完并落库,不会留下半成品。
  ///   paused    —— 可续跑,断点就是批次自己的 cursorEp/cursorStep
  ///   cancelled —— 终态,不再续跑;已生成的集与成片都保留
  Future<void> _setBatchStatus(String status, String okMsg) async {
    final bu = _batchUuid;
    if (bu == null) {
      _toast('没找到批次号,请到剧集详情页操作', error: true);
      return;
    }
    setState(() => _projectBusy = true);
    try {
      final r = _unwrap(await _api.dio.post(
        '/dramas/batches/$bu/status',
        data: {'status': status},
        options: _fresh,
      ));
      if (r is Map) setState(() => _batch = Map<String, dynamic>.from(r));
      _toast(okMsg);
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _projectBusy = false);
    }
    await _pollStage();
  }

  /// 打开成片播放(从最后一集往回找第一个已产出的 finalUrl)。
  ///
  /// 懒加载:只有用户真点了才去拉剧集列表 —— 工作台主循环本来每 4 秒轮询一次
  /// 账本,再挂一份剧集列表轮询纯属浪费。最后一集最可能是刚跑完的那一集,
  /// 所以从尾部往前找。
  Future<void> _playFinal() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    setState(() => _playing = true);
    try {
      final r = await _api.dio.get('/dramas/$uuid/episodes', options: _fresh);
      final list = (_unwrap(r) as List?)?.whereType<Map>().toList() ?? const [];
      Map? hit;
      for (final e in list.reversed) {
        if ((e['finalUrl'] ?? '').toString().isNotEmpty) {
          hit = e;
          break;
        }
      }
      final url = (hit?['finalUrl'] ?? '').toString();
      if (url.isEmpty) {
        _toast('还没有可播放的成片', error: true);
        return;
      }
      await webOpenInNewTab(Uri.parse(ApiClient.resolveUrl(url)));
      if (!mounted) return;
      _toast('已在新标签页打开 EP${hit?['epNo'] ?? ''} 成片');
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _playing = false);
    }
  }

  /// 删除整个项目(剧 + 账本 + 资产 + 已生成成片),不可恢复。
  ///
  /// 此前唯一的删除入口在剧集列表页 —— 用户在工作台发现"这部剧彻底废了"
  /// (比如门被驳回、剧本完全跑偏),却要先退出去、在列表里找到它、再删。
  /// 这里补一个就地入口,但**必须二次确认**:删除会连带 OSS 上的成片,
  /// 没有任何回收站。
  Future<void> _deleteProject() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    final title = _ledger?['novelTitle']?.toString() ?? '这个项目';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除项目'),
        content: Text('将永久删除「$title」:小说账本、已生成的角色/场景资产、'
            '全部逐集产物与成片都会一并清掉,无法恢复。\n\n确定删除吗?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: const Text('永久删除'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _projectBusy = true);
    try {
      await _api.dio.delete('/dramas/$uuid', options: _fresh);
      _api.invalidate('/dramas/novel/active');
      if (!mounted) return;
      _toast('项目已删除');
      _backToStart();
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _projectBusy = false);
    }
  }

  /// 重新拉起连集批次(与剧集详情页「续跑」同一个接口)。
  ///
  /// 批次执行者活在**后端进程内存**里:进程一重启,正在跑的那一轮就没了,
  /// 而 DB 里状态还写着 running —— 用户看到进度条一动不动。
  /// 更坑的是队列里残留的旧任务(jobId = batchUuid)会占着 active 锁最长 90 分钟,
  /// 这期间连"续跑"都会被 BullMQ 静默忽略。后端已改为 force 入队,这里直接调即可。
  Future<void> _resumeBatch() async {
    final bu = _batchUuid;
    if (bu == null) {
      _toast('没找到批次号,请到剧集详情页续跑', error: true);
      return;
    }
    setState(() => _deciding = true);
    try {
      final r = _unwrap(await _api.dio.post(
        '/dramas/batches/$bu/resume',
        data: const <String, dynamic>{},
        options: _fresh,
      ));
      if (r is Map && r['enqueued'] == false) {
        _toast('未能续跑:${r['reason'] ?? '队列不可用'}', error: true);
      } else {
        _toast('已重新入队,从断点续跑');
      }
      if (r is Map) setState(() => _batch = Map<String, dynamic>.from(r));
    } catch (e) {
      if (!mounted) return;
      _toast(_errMsg(e), error: true);
    } finally {
      if (mounted) setState(() => _deciding = false);
    }
    await _pollStage();
  }

  // ── 门② 定妆守门(2026-09-14) ─────────────────────────────────────────
  // 背景:门②「确认设定,生成剧本」通过后会自动连跑剧本 + 连集生产,但定妆图
  // 必须由用户在资产库逐项手动生成(设定阶段只建 pending、refs 为空的资产)。
  // 一旦没定妆就冲过去,后端 keyframe-plan 会把每一镜降级成纯文生图
  // (degraded=true),十几张图各画各的 → 主角跨镜换脸、场景漂移。
  // 所以在放行前拦一道,并把「去资产库定妆」的入口放在用户真正看得见的地方。

  /// 资产是否已有可用定妆图(refs 里有落地图或远端图,且没被标死)
  static bool _hasRefImage(Map<String, dynamic> a) {
    final refs = a['refs'];
    if (refs is! List) return false;
    for (final r in refs.whereType<Map>()) {
      final url = (r['url'] ?? '').toString();
      final remote = (r['remoteUrl'] ?? '').toString();
      if ((url.isNotEmpty || remote.isNotEmpty) && r['alive'] != false) {
        return true;
      }
    }
    return false;
  }

  /// 「待定妆」= 非软删(deprecated)且 refs 里没有可用图的资产。
  /// 判据与后端 `refAssetIndex` 逐字对齐:alive !== false 且 url/remoteUrl 非空。
  List<Map<String, dynamic>> get _undressedAssets => _assets
      .where((a) => a['status']?.toString() != 'deprecated')
      .where((a) => !_hasRefImage(a))
      .toList();

  /// 需不需要关心定妆进度。门② 通过后更要看 —— 后端自动批量定妆正是在
  /// 「确认设定」之后才开跑的,与剧本阶段并行;只盯 waiting 就会在最关键的
  /// 那几分钟里什么进度都不显示(用户上一轮投诉的「看不到进度」)。
  bool get _portraitRelevant {
    if (_dramaUuid == null) return false;
    final g2 = _gateOf('gate2_design')?['status']?.toString();
    if (g2 == 'passed') return true;
    return g2 == 'waiting' &&
        _gatePayload('gate2_design')?['state'] == 'ready';
  }

  /// 按需拉一次资产 + 批量定妆进度(从资产库回来会重置 _assetsLoaded 再拉)
  void _maybeLoadAssets() {
    if (_portraitRelevant && !_assetsLoaded && !_assetsLoading) {
      _loadAssets();
      _loadPortrait();
    }
  }

  Future<void> _loadAssets() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    setState(() => _assetsLoading = true);
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/$uuid/assets', options: _fresh));
      if (!mounted) return;
      setState(() {
        _assets = (r is List ? r : const [])
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        _assetsLoading = false;
        _assetsLoaded = true;
      });
    } catch (_) {
      // 拉失败不锁死流程,但标记「已尝试」,避免每轮轮询都重拉;
      // 此时 _assets 为空 → 守门按"无待定妆"处理,不会误拦。
      if (mounted) {
        setState(() {
          _assetsLoading = false;
          _assetsLoaded = true;
        });
      }
    }
  }

  /// 拉批量定妆进度。running 时用**一次性 Timer 自重排**(不是 periodic):
  /// 到终态自然不再排下一次,不会留下一个永远停不下来的轮询。
  Future<void> _loadPortrait() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    Map<String, dynamic> next = const {'status': 'idle'};
    try {
      final r = _unwrap(
          await _api.dio.get('/dramas/$uuid/assets/portrait-batch', options: _fresh));
      if (r is Map) next = Map<String, dynamic>.from(r);
    } catch (_) {
      // 拉不到就退回 idle:提示条会退化成「确认设定后自动定妆」的说明文案,
      // 不该因为一个进度接口挂掉就把整张门② 卡片变成错误态。
    }
    if (!mounted) return;
    final wasRunning = _wasPortraitRunning;
    final running = next['status'] == 'running';
    setState(() {
      _portrait = next;
      _wasPortraitRunning = running;
    });
    _portraitTimer?.cancel();
    _portraitTimer = null;
    if (running) {
      _portraitTimer = Timer(const Duration(seconds: 4), _loadPortrait);
    } else if (wasRunning) {
      // 刚跑完:重拉资产,让卡片上的「已定妆」与守门判据立刻对上
      _assetsLoaded = false;
      await _loadAssets();
    }
  }

  /// 跳资产库 Tab(0 概览 / 1 资产库 / 2 分集);回来重算定妆情况
  Future<void> _openAssetsTab() async {
    final uuid = _dramaUuid;
    if (uuid == null) return;
    await Navigator.pushNamed(context, AppRoute.dramaDetail, arguments: {
      'uuid': uuid,
      'agentName': widget.agentName,
      'initialTab': 1,
    });
    if (!mounted) return;
    _assetsLoaded = false;
    await _loadAssets();
  }

  /// 门②「确认设定,生成剧本」。
  ///
  /// 2026-09-15:以前这里会弹「先去定妆 / 仍然继续」的拦截框 —— 因为定妆只能在
  /// 资产库逐项手动点,而那颗按钮藏在卡片详情抽屉最底部,多数人找不到入口。
  /// 现在门② 通过 = 后端自动开跑批量定妆(与剧本阶段并行),拦截已无意义:
  /// 拦下来反而让用户以为还得自己去找那颗按钮。进度与失败项由门② 卡片的
  /// 提示条如实显示,想单独补某一项的人仍可从提示条上的入口进资产库。
  Future<void> _confirmGate2() async {
    await _decideGate('gate2_design', true);
  }

  /// 跳剧集详情页(分集 Tab):连集生产的精细管理(暂停/续跑/预算/单集重做)
  void _openDramaDetail() {
    if (_dramaUuid == null) return;
    Navigator.pushNamed(context, AppRoute.dramaDetail, arguments: {
      'uuid': _dramaUuid,
      'agentName': widget.agentName,
      'initialTab': 2,
    });
  }

  Future<void> _refreshLedger() async {
    if (_dramaUuid == null) return;
    try {
      final r = _unwrap(await _api.dio.get('/dramas/$_dramaUuid/novel/ledger',
          options: _fresh));
      if (mounted && r is Map) {
        setState(() => _ledger = Map<String, dynamic>.from(r));
        // 门② 出设定后,顺手把资产定妆情况拉一次(用于守门提示)
        _maybeLoadAssets();
      }
    } catch (_) {}
  }

  // ── Stage 2 流水线轮询 ────────────────────────────────────────────────

  Map<String, dynamic>? _gatePayload(String gate) {
    final p = _gateOf(gate)?['payload'];
    return (p is Map) ? Map<String, dynamic>.from(p) : null;
  }

  int? _asInt(dynamic v) => v is num ? v.toInt() : int.tryParse('$v');

  /// 某条记录最后落库到现在过了多少分钟。
  ///
  /// ⚠ 只能喂**后端用 JS 写的**时间戳(payload 里的 progressAt/startedAt、
  /// 批次日志的 at)—— 它们是真 UTC。**不要喂 DB 的 updatedAt**:那些列是
  /// MySQL `NOW(3)` 写的本地时间(GMT+8),经 Prisma/JSON 出来却带 `Z`,
  /// 前端按 UTC 解析会得到"8 小时后"的时间,相减恒为负,判断全部失效。
  int? _minutesSince(dynamic iso) {
    final raw = iso?.toString();
    if (raw == null || raw.isEmpty) return null;
    final t = DateTime.tryParse(raw);
    if (t == null) return null;
    final mins = DateTime.now().difference(t.toLocal()).inMinutes;
    return mins < 0 ? null : mins; // 未来时间 = 时钟/时区有问题,宁可不显示
  }

  /// 生成态的逃生口:显示"已 N 分钟无进展"+ 重新拉起按钮。
  /// 以前这个按钮只在 payload 为空的分支里出现,一旦阶段死在中途(状态是
  /// generating 而不是 failed),用户就只能看着转圈、没有任何可点的东西。
  Widget _stageEscapeHatch(String gateKey, Map<String, dynamic>? gate) {
    // progressAt 每写完一集刷新一次,最能代表"最后有进展的时刻";
    // 老 payload 没有它时退回 startedAt(阶段启动时刻,只会更悲观,不会误报)。
    final mins = _minutesSince(gate?['progressAt'] ?? gate?['startedAt']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (mins != null && mins >= 2) ...[
          Text(
            '已经 $mins 分钟没有新进展 · 后端进程重启会丢掉生成循环,可重新拉起',
            style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning),
          ),
          const SizedBox(height: AppSpacing.sm),
        ],
        _GateMiniButton(
          label: '长时间无响应?点此重新拉起',
          icon: Icons.refresh_rounded,
          color: AppColors.textSecondary,
          busy: _deciding,
          onTap: () => _retryGate(gateKey),
        ),
      ],
    );
  }

  /// 是否有需要持续轮询的阶段(设定/剧本生成中、生产未终态、或门已过但
  /// payload 还没落 generating 的短暂空窗)
  bool get _stageActive {
    if (_ledger == null) return false;
    if (_gateOf('gate1_budget')?['status'] != 'passed') return false;
    final g2 = _gateOf('gate2_design')?['status']?.toString();
    final g3 = _gateOf('gate3_script')?['status']?.toString();
    final p2 = _gatePayload('gate2_design');
    final p3 = _gatePayload('gate3_script');
    if (p2?['state'] == 'generating' || p3?['state'] == 'generating') {
      return true;
    }
    if (p3?['state'] == 'producing') {
      // 批次到终态就停轮询(卡片保留终态展示)。
      // 后端在批次收尾时会把 batchStatus 写回门 payload,所以刷新页面后
      // 不必先拉一次批次详情才知道该不该继续轮询。
      final bs = _batch?['status']?.toString() ??
          p3?['batchStatus']?.toString();
      return bs == null || !['done', 'failed', 'cancelled'].contains(bs);
    }
    // 空窗容错:决策刚落地、后台还没写 payload,允许有限次轮询
    if (_idlePolls < 15) {
      if (g2 == 'waiting' && p2?['state'] == null) return true;
      if (g2 == 'passed' && g3 == 'waiting' && p3?['state'] == null) return true;
    }
    return false;
  }

  void _syncStagePolling() {
    if (!mounted) return;
    if (_stageActive) {
      if (_payloadEmpty) _idlePolls++;
      _stageTimer?.cancel();
      _stageTimer = Timer.periodic(const Duration(seconds: 4), (_) => _pollStage());
    } else {
      _idlePolls = 0;
      _stageTimer?.cancel();
      _stageTimer = null;
    }
  }

  bool get _payloadEmpty {
    final p2 = _gatePayload('gate2_design');
    final p3 = _gatePayload('gate3_script');
    return (p2?['state'] == null) && (p3?['state'] == null);
  }

  Future<void> _pollStage() async {
    await _refreshLedger();
    final p3 = _gatePayload('gate3_script');
    final bu = p3?['batchUuid']?.toString();
    if (p3?['state'] == 'producing' && bu != null && bu.isNotEmpty) {
      try {
        final r = _unwrap(
            await _api.dio.get('/dramas/batches/$bu', options: _fresh));
        if (mounted && r is Map) {
          setState(() => _batch = Map<String, dynamic>.from(r));
        }
      } catch (_) {}
    }
    _syncStagePolling();
  }

  // ── 上传 .txt(入口 B) ────────────────────────────────────────────────
  Future<void> _pickNovelFile() async {
    final picked = await pickKnowledgeFileViaWebInput();
    if (picked == null) return;
    final bytes = picked['bytes'] as List<int>;
    final name = picked['name']?.toString() ?? 'novel.txt';
    var text = utf8.decode(bytes, allowMalformed: true);
    if (text.startsWith('﻿')) text = text.substring(1);
    if (!mounted) return;
    setState(() {
      _novelCtrl.text = text;
      if (_titleCtrl.text.trim().isEmpty) {
        _titleCtrl.text =
            name.replaceAll(RegExp(r'\.txt$', caseSensitive: false), '');
      }
    });
    _toast('已读入 $name(共 ${text.length} 字)');
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    AppToast.success(context, msg);
  }

  // ── UI ────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    final hasLedger = _ledger != null;
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.surface,
        title: Text(
          widget.agentName ?? '全新短视频一键生成',
          style: AppTextStyles.titleMedium,
        ),
        actions: [
          // 2026-09-14:全部小说书架入口(含历史生成,不依赖当前页状态)
          IconButton(
            tooltip: '我的小说',
            onPressed: () =>
                Navigator.pushNamed(context, AppRoute.novelLibrary),
            icon: const Icon(Icons.local_library_rounded),
          ),
          // 2026-09-15:账本之后的整条链路(三道门 → 连集生产)以前在全 App 内
          // 没有任何入口能回到某部剧,库里 20+ 个项目因此卡在门上打不开。
          // 这里补「我的剧集」,与「我的小说」一前一后覆盖两个阶段。
          IconButton(
            tooltip: '我的剧集',
            onPressed: () => Navigator.pushNamed(context, AppRoute.dramaList,
                arguments: {
                  'agentId': widget.agentId,
                  'agentName': widget.agentName,
                }),
            icon: const Icon(Icons.movie_filter_rounded),
          ),
        ],
        bottom: hasLedger
            ? null
            : TabBar(
                controller: _tabs,
                labelColor: AppColors.primary,
                unselectedLabelColor: AppColors.textSecondary,
                indicatorColor: AppColors.primary,
                tabs: const [
                  Tab(icon: Icon(Icons.auto_awesome_rounded, size: 18),
                      text: 'AI 生成小说'),
                  Tab(icon: Icon(Icons.menu_book_rounded, size: 18),
                      text: '我有小说'),
                ],
              ),
      ),
      body: _restoring
          ? const Center(child: CircularProgressIndicator())
          : hasLedger
              ? _buildLedgerView()
              : Column(
                  children: [
                    const SizedBox(height: AppSpacing.md),
                    const WbInfoCard(
                      icon: Icons.auto_stories_rounded,
                      text:
                          '从一个标题或一本完整小说出发,一键产出可发布的完整竖屏短剧。'
                          '小说有多长,短剧就有多长 —— 先给你报价单,确认了才开做。',
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    // 2026-09-15:未完成项目清单。放在 TabBarView 之外,
                    // 两个 Tab 都能看到 —— 断点续跑不该取决于你停在哪个入口。
                    // (不能塞进 SingleChildScrollView:TabBarView 要的是有界高度)
                    _buildActiveProjectsCard(),
                    Expanded(
                      child: TabBarView(
                        controller: _tabs,
                        children: [
                          _buildGenTab(),
                          _buildUploadTab(),
                        ],
                      ),
                    ),
                  ],
                ),
    );
  }

  // ── 未完成项目清单(2026-09-15 断点续跑) ───────────────────────────────

  static const _gateNames = {
    'gate1_budget': '① 报价单',
    'gate2_design': '② 角色场景设定',
    'gate3_script': '③ 分集剧本',
  };

  String _gateNameOf(String? gate) => _gateNames[gate] ?? '生产';

  /// 后端 listActiveProjects 的 reason → 一句人话(说清卡在哪、能干什么)
  String _reasonOf(Map<String, dynamic> p) {
    final gate = _gateNameOf(p['currentGate']?.toString());
    switch (p['reason']?.toString()) {
      case 'generating':
        return '$gate 正在生成中';
      case 'failed':
        return '$gate 生成中断,可重拉';
      case 'producing':
        final b = p['batch'];
        final cur = b is Map ? _asInt(b['cursorEp']) : null;
        final to = b is Map ? _asInt(b['toEp']) : null;
        return cur != null && to != null && to > 0
            ? '连集生产中 · 已到第 $cur/$to 集'
            : '连集生产中';
      case 'rejected':
        // 别说"可重做":retry 只重跑生成阶段,不会把门从 rejected 拉回来
        // (后端 decideGate 对非 waiting 直接抛 Conflict)。真正要做的是
        // 「重新打开此门」,所以文案必须指那一个动作,否则用户点进去只会碰壁。
        return '$gate 已驳回,可重新打开';
      case 'stopped':
        return '生产已停止,可续跑';
      case 'not_started':
        return '三道门已过,生产未启动';
      default:
        return p['currentGate']?.toString() == 'gate1_budget'
            ? '$gate 等你确认'
            : '$gate 已生成,等你过门';
    }
  }

  Widget _buildActiveProjectsCard() {
    final currentUuid = _genTask?['uuid']?.toString();
    final paused = _pausedGenTasks
        .where((t) => t['uuid']?.toString() != currentUuid)
        .toList();
    if (_activeProjects.isEmpty && paused.isEmpty) {
      return const SizedBox.shrink();
    }
    final shown = _activeProjects.take(3).toList();
    final totalCount = _activeProjects.length + paused.length;
    return Container(
      margin: const EdgeInsets.fromLTRB(AppSpacing.lg, 0, AppSpacing.lg, AppSpacing.sm),
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, AppSpacing.sm),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.history_rounded, size: 18, color: AppColors.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text('未完成的项目($totalCount)',
                    style: AppTextStyles.titleSmall),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            '上次没做完的都在这儿,点一下直接回到当时那一步接着做。',
            style: AppTextStyles.caption
                .copyWith(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.sm),
          for (final p in shown) _activeProjectRow(p),
          for (final t in paused) _pausedGenRow(t),
          if (_activeProjects.length > shown.length)
            Padding(
              padding: const EdgeInsets.fromLTRB(AppSpacing.xxs, AppSpacing.xxs, 0, AppSpacing.sm),
              child: Text(
                '还有 ${_activeProjects.length - shown.length} 个 · '
                '点右上角「我的剧集」看全部',
                style: AppTextStyles.caption
                    .copyWith(color: AppColors.textTertiary),
              ),
            ),
        ],
      ),
    );
  }

  /// 「未完成的项目」里的失败/中断小说生成任务行。
  /// 点击才把该任务设成 _genTask(显示失败卡 + 「从断点重试」/「换个标题重来」),
  /// 进页面时不自动显示 —— 与 _restore 的「只接管 running」配套。
  Widget _pausedGenRow(Map<String, dynamic> t) {
    final title = t['title']?.toString() ?? '未命名小说';
    final failed = t['status'] == 'failed';
    final chDone = t['chaptersDone'] ?? 0;
    final chTotal = t['chaptersTotal'] ?? 0;
    return InkWell(
      borderRadius: BorderRadius.circular(AppColors.slotRadius),
      onTap: () => setState(() => _genTask = Map<String, dynamic>.from(t)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.xxs, AppSpacing.sm, AppSpacing.xxs, AppSpacing.sm),
        child: Row(
          children: [
            Icon(
              failed ? Icons.error_outline_rounded : Icons.pause_circle_outline_rounded,
              size: 18,
              color: failed ? AppColors.danger : AppColors.textSecondary,
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.bodySmall
                        .copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(
                    '${failed ? '生成失败' : '已中断'} · 第 $chDone/$chTotal 章 · '
                    '点查看原因 / 从断点重试',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.caption
                        .copyWith(color: AppColors.textSecondary),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, color: AppColors.textTertiary),
          ],
        ),
      ),
    );
  }

  Widget _activeProjectRow(Map<String, dynamic> p) {
    final dramaUuid = p['dramaUuid']?.toString() ?? '';
    final chars = _asInt(p['totalChars']) ?? 0;
    final eps = _asInt(p['episodeCount']) ?? 0;
    return InkWell(
      borderRadius: BorderRadius.circular(AppColors.slotRadius),
      onTap: () => _openProject(dramaUuid),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.xxs, AppSpacing.sm, AppSpacing.xxs, AppSpacing.sm),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    p['title']?.toString() ?? '未命名项目',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.bodySmall
                        .copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    '${_reasonOf(p)}'
                    '${chars > 0 ? ' · $chars 字' : ''}'
                    '${eps > 0 ? ' · $eps 集' : ''}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.caption
                        .copyWith(color: AppColors.textTertiary),
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Text('继续',
                style: AppTextStyles.caption.copyWith(
                    color: AppColors.primary, fontWeight: FontWeight.w800)),
            const SizedBox(width: AppSpacing.xxs),
            Icon(Icons.arrow_forward_ios,
                size: 10, color: AppColors.primary),
          ],
        ),
      ),
    );
  }

  // ── 入口 A:AI 生成小说 Tab ────────────────────────────────────────────
  Widget _buildGenTab() {
    final task = _genTask;
    final running = task != null && task['status'] == 'running';
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, AppSpacing.xxl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (task == null || !running) ...[
            WbTextField(
              label: '小说标题',
              hint: '如:斗破苍穹之绝世丹帝',
              controller: _genTitleCtrl,
              icon: Icons.drive_file_rename_outline_rounded,
              required: true,
            ),
            const SizedBox(height: AppSpacing.md),
            WbTextField(
              label: '类型(可选)',
              hint: '玄幻 / 都市 / 悬疑 / 古言 / 科幻…留空由 AI 判断',
              controller: TextEditingController(text: _genGenre),
              icon: Icons.category_rounded,
              onChanged: (v) => _genGenre = v.trim(),
            ),
            const SizedBox(height: AppSpacing.md),
            WbDropdown<String>(
              label: '小说规模',
              value: _tier,
              items: const [
                WbDropdownItem(
                    value: 'demo', label: '试写 2 万字(约 10 章,先看效果)'),
                WbDropdownItem(
                    value: 'novella', label: '中篇 20 万字(约 80 章)'),
                WbDropdownItem(
                    value: 'full', label: '长篇 80 万字(约 267 章,数小时)'),
              ],
              onChanged: (v) => setState(() => _tier = v),
              icon: Icons.library_books_rounded,
            ),
            const SizedBox(height: AppSpacing.md),
            WbDropdown<String>(
              label: '单集目标时长',
              value: _epTarget,
              items: const [
                WbDropdownItem(value: '60', label: '60 秒(快节奏)'),
                WbDropdownItem(value: '90', label: '90 秒'),
                WbDropdownItem(value: '120', label: '120 秒(推荐)'),
                WbDropdownItem(value: '180', label: '180 秒(慢热)'),
              ],
              onChanged: (v) => setState(() => _epTarget = v),
              icon: Icons.timer_outlined,
            ),
            const SizedBox(height: AppSpacing.md),
            // 入口 A 的字数是档位目标值(小说还没生成,拿不到实数)
            _buildEstimateCard(_tierChars[_tier] ?? 20000, _epTarget),
            const SizedBox(height: AppSpacing.md),
            if (_error != null) ...[
              WbInfoCard(
                icon: Icons.error_outline_rounded,
                text: _error!,
                accent: AppColors.danger,
              ),
              const SizedBox(height: AppSpacing.md),
            ],
            AgentCostBanner.compact(agentId: widget.agentId),
            const SizedBox(height: AppSpacing.md),
            WbSubmitButton(
              label: '一键生成小说 + 短剧',
              loadingLabel: '正在启动生成引擎…',
              icon: Icons.auto_awesome_rounded,
              loading: _genStarting,
              disabled: _genStarting,
              onTap: _startGen,
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              'AI 五级瀑布:解析题材 → 构建世界观 → 规划分卷 → 排章纲 → 逐章写作;'
              '写完自动进入对齐引擎出报价单,全程可试读。',
              style: AppTextStyles.labelSmall
                  .copyWith(color: AppColors.textTertiary),
            ),
          ],
          if (task != null) _buildGenProgress(task),
        ],
      ),
    );
  }

  Widget _buildGenProgress(Map<String, dynamic> task) {
    final stage =
        task['stageLabel']?.toString() ?? task['stage']?.toString() ?? '';
    final percent = (task['percent'] as num?)?.toInt() ?? 0;
    final chDone = task['chaptersDone'] ?? 0;
    final chTotal = task['chaptersTotal'] ?? 0;
    final chars = task['charsDone'] ?? 0;
    final preview = task['preview']?.toString();
    final failed = task['status'] == 'failed';

    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.md),
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(
            color: failed
                ? AppColors.danger.withValues(alpha: 0.4)
                : AppColors.primary.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                  failed
                      ? Icons.error_outline_rounded
                      : Icons.auto_awesome_rounded,
                  size: 20,
                  color: failed ? AppColors.danger : AppColors.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  failed ? '生成失败' : '「${task['title']}」生成中',
                  style: AppTextStyles.titleSmall,
                ),
              ),
              Text('$percent%',
                  style: AppTextStyles.titleSmall.copyWith(
                      color: AppColors.primary,
                      fontWeight: FontWeight.w900)),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppColors.thumbRadius),
            child: LinearProgressIndicator(
              value: percent / 100,
              minHeight: 8,
              backgroundColor: AppColors.surfaceLight,
              color: failed ? AppColors.danger : AppColors.primary,
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            '$stage · 第 $chDone/$chTotal 章 · 已写 $chars 字',
            style: AppTextStyles.bodySmall
                .copyWith(color: AppColors.textSecondary),
          ),
          if (task['bible']?['logline'] != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              '${task['bible']['logline']}',
              style: AppTextStyles.bodySmall
                  .copyWith(color: AppColors.textPrimary),
            ),
          ],
          if (preview != null && preview.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.md),
            Container(
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(
                color: AppColors.surfaceLight,
                borderRadius: BorderRadius.circular(AppColors.slotRadius),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('试读(最新一章结尾)',
                      style: AppTextStyles.labelSmall
                          .copyWith(color: AppColors.textTertiary)),
                  const SizedBox(height: AppSpacing.sm),
                  Text(preview,
                      maxLines: 6,
                      overflow: TextOverflow.ellipsis,
                      style:
                          AppTextStyles.bodySmall.copyWith(height: 1.6)),
                ],
              ),
            ),
          ],
          // 2026-09-14:全文入口 —— 生成中/失败/完成都能读(正文逐章 append,
          //   不用等 100%)。阅读器里可切 Markdown 排版 / TXT 原文、改正文、下载。
          if (task['uuid'] != null) ...[
            const SizedBox(height: AppSpacing.md),
            WbSubmitButton(
              label: '阅读全文(Markdown 排版)',
              icon: Icons.menu_book_rounded,
              onTap: _openReader,
            ),
          ],
          if (failed) ...[
            const SizedBox(height: AppSpacing.lg),
            if (task['error'] != null && task['error'].toString().isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.md),
                child: Text(
                  '失败原因:${task['error']}',
                  style: AppTextStyles.bodySmall
                      .copyWith(color: AppColors.danger),
                ),
              ),
            Row(
              children: [
                Expanded(
                  child: WbSubmitButton(
                    label: '换个标题重来',
                    icon: Icons.refresh_rounded,
                    disabled: _genStarting,
                    onTap: () => setState(() {
                      _genTask = null;
                      _error = null;
                    }),
                  ),
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  flex: 2,
                  child: WbSubmitButton(
                    label: '从断点重试(已完成 $chDone 章不重写)',
                    loadingLabel: '正在恢复生成…',
                    icon: Icons.play_arrow_rounded,
                    loading: _genStarting,
                    disabled: _genStarting,
                    onTap: _resumeGen,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  /// 打开阅读器(当前生成任务的全文;生成中也能读已写完部分)
  void _openReader() {
    final uuid = _genTask?['uuid']?.toString();
    if (uuid == null || uuid.isEmpty) return;
    Navigator.pushNamed(context, AppRoute.novelReader, arguments: {
      'uuid': uuid,
      'title': _genTask?['title']?.toString(),
    });
  }

  /// 失败任务从断点重拉(已完成章保留,失败章重写)
  Future<void> _resumeGen() async {
    final uuid = _genTask?['uuid']?.toString();
    if (uuid == null || uuid.isEmpty) return;
    setState(() => _genStarting = true);
    try {
      final r = _unwrap(
          await _api.dio.post('/dramas/novel-gen/tasks/$uuid/resume'));
      if (!mounted) return;
      if (r is Map) {
        setState(() => _genTask = Map<String, dynamic>.from(r));
        _startPolling();
        _toast('已从断点恢复,继续生成');
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _errMsg(e));
    } finally {
      if (mounted) setState(() => _genStarting = false);
    }
  }

  // ── 入口 B:粘贴/上传 Tab ─────────────────────────────────────────────
  Widget _buildUploadTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.sm, AppSpacing.lg, AppSpacing.xxl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WbTextField(
            label: '作品名',
            hint: '如:斗破苍穹之绝世丹帝',
            controller: _titleCtrl,
            icon: Icons.drive_file_rename_outline_rounded,
            required: true,
          ),
          const SizedBox(height: AppSpacing.md),
          WbTextArea(
            label: '小说正文(粘贴或上传)',
            hint: '粘贴完本小说正文,任意长度;一个字都不丢,每一集都能对回到原文',
            controller: _novelCtrl,
            maxLines: 8,
            required: true,
            // 让「N 字」计数与下面的开跑前预估随输入实时更新
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              // Flexible(loose) + spaceBetween 与原来的「按钮 + Spacer + 计数」
              // 完全等价(按钮贴左、计数贴右),但窄屏时计数会省略而不是撑破。
              Flexible(
                child: TextButton.icon(
                  onPressed: _pickNovelFile,
                  icon: const Icon(Icons.upload_file_rounded, size: 18),
                  label: const Text('上传 .txt 文件'),
                ),
              ),
              Text(
                '${_novelCtrl.text.length} 字',
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: AppTextStyles.labelSmall
                    .copyWith(color: AppColors.textTertiary),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          WbDropdown<String>(
            label: '单集目标时长',
            value: _epTarget,
            items: const [
              WbDropdownItem(value: '60', label: '60 秒(快节奏)'),
              WbDropdownItem(value: '90', label: '90 秒'),
              WbDropdownItem(value: '120', label: '120 秒(推荐)'),
              WbDropdownItem(value: '180', label: '180 秒(慢热)'),
            ],
            onChanged: (v) => setState(() => _epTarget = v),
            icon: Icons.timer_outlined,
          ),
          const SizedBox(height: AppSpacing.md),
          // 入口 B 的字数是粘贴框里的真实字数,预估直接用它
          _buildEstimateCard(_novelCtrl.text.length, _epTarget),
          const SizedBox(height: AppSpacing.md),
          if (_error != null) ...[
            WbInfoCard(
              icon: Icons.error_outline_rounded,
              text: _error!,
              accent: AppColors.danger,
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          AgentCostBanner.compact(agentId: widget.agentId),
          const SizedBox(height: AppSpacing.md),
          WbSubmitButton(
            label: '生成对齐账本',
            loadingLabel: 'AI 正在逐章建账本…',
            icon: Icons.auto_awesome_rounded,
            loading: _submitting,
            disabled: _submitting,
            onTap: _submit,
          ),
        ],
      ),
    );
  }

  // ── 账本视图(两入口汇合后共用) ────────────────────────────────────────
  Widget _buildLedgerView() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 2026-09-15:能恢复就得能退出。以前「离开页面再重进」是回到起始表单的
          // 唯一途径,现在重进会被自动恢复抢掉 —— 必须给一个显式重置入口。
          _buildBackToStartRow(),
          const SizedBox(height: AppSpacing.md),
          // 2026-09-14:小说原文入口 —— 页面切到账本/报价单视图后,生成卡片连同
          //   它的「阅读全文」按钮一起消失,完本的小说就再也读不到了。这里补一个
          //   常驻入口,走账本快照接口(只读),入口 A(生成)和入口 B(上传)都覆盖。
          _buildNovelSourceCard(),
          const SizedBox(height: AppSpacing.lg),
          _buildQuoteCard(),
          const SizedBox(height: AppSpacing.lg),
          _buildGatesPanel(),
          const SizedBox(height: AppSpacing.lg),
          _buildActionsBar(),
        ],
      ),
    );
  }

  /// 重置回起始表单(清空 dramaUuid / 账本 / 批次,并停掉所有轮询)
  void _backToStart() {
    _pollTimer?.cancel();
    _stageTimer?.cancel();
    _resetPortraitView();
    setState(() {
      _dramaUuid = null;
      _ledger = null;
      _batch = null;
      _genTask = null;
      _error = null;
      _assets = [];
      _assetsLoaded = false;
      _idlePolls = 0;
    });
    // 清单要重拉:否则刚选择「保留」的项目不会出现在「未完成的项目」里
    unawaited(_refreshActiveProjects());
  }

  /// 「回到起点」:开始新项目 —— 有进行中的项目时先问一句怎么处理它。
  ///
  /// 为什么必须问:这个按钮以前只清内存字段,剧本身还留在库里。用户以为
  /// "清掉了,重新开始",实际是留下一个**再也不会被打开的半成品** ——
  /// 而项目清单只列最近 3 个,它很快就被挤到看不见的地方,白烧的配额
  /// 连个交代都没有。反过来,直接删也不对:用户可能只是想换个小说试试。
  Future<void> _backToStartWithChoice() async {
    final uuid = _dramaUuid;
    if (uuid == null || uuid.isEmpty) {
      _backToStart();
      return;
    }
    final title = _ledger?['novelTitle']?.toString() ?? '当前项目';
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('开始新项目'),
        content: Text('「$title」还没做完,要怎么处理它?\n\n'
            '· 保留:它仍在「未完成的项目」里,随时点回来接着做\n'
            '· 删除:账本、已生成的角色/场景资产、成片一起清掉,无法恢复'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'cancel'),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'keep'),
            child: const Text('保留并新建'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, 'delete'),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: const Text('删除并新建'),
          ),
        ],
      ),
    );
    if (!mounted || choice == 'cancel' || choice == null) return;
    if (choice == 'delete') {
      try {
        await _api.dio.delete('/dramas/$uuid', options: _fresh);
        _api.invalidate('/dramas/novel/active');
        if (!mounted) return;
        _toast('项目已删除');
      } catch (e) {
        // 删失败就**别清界面** —— 清了用户会以为删掉了,实际还留在库里
        if (mounted) _toast(_errMsg(e), error: true);
        return;
      }
    }
    _backToStart();
  }

  Widget _buildBackToStartRow() {
    return Align(
      alignment: Alignment.centerLeft,
      child: InkWell(
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        onTap: _backToStartWithChoice,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.add_circle_outline_rounded,
                  size: 15, color: AppColors.textTertiary),
              const SizedBox(width: AppSpacing.xs),
              Text(
                '新建一个项目(回到起点)',
                style: AppTextStyles.caption
                    .copyWith(color: AppColors.textTertiary),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 小说原文卡片:标题 / 字数 / 来源(生成 or 上传) + 阅读全文
  Widget _buildNovelSourceCard() {
    final title = _ledger?['novelTitle']?.toString();
    final source = _ledger?['novelSource']?.toString();
    // totalChars 是 Prisma BigInt 列 → 后端序列化成**字符串**("14329"),
    // `as num?` 会抛 TypeError 把整页打成空白,必须走已兼容字符串的 _asInt。
    final chars = _asInt(_ledger?['totalChars']);
    final uploaded = source == 'uploaded';
    final hasText = (_ledger?['novelStorageKey']?.toString() ?? '').isNotEmpty;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.info.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.menu_book_rounded, color: AppColors.info, size: 20),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  title == null || title.isEmpty ? '小说原文' : title,
                  style: AppTextStyles.titleSmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
                decoration: BoxDecoration(
                  color: AppColors.info.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(AppColors.cardRadius),
                ),
                child: Text(
                  uploaded ? '我上传的' : 'AI 生成',
                  style: AppTextStyles.labelSmall
                      .copyWith(color: AppColors.info),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            '${chars == null ? '—' : '$chars'} 字 · 已入库对齐,原文一字不丢,'
            '每一集都能对回原文。全文可直接阅读 / 下载 Markdown、TXT。',
            style: AppTextStyles.bodySmall
                .copyWith(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.lg),
          WbSubmitButton(
            label: '阅读全文(Markdown 排版)',
            icon: Icons.auto_stories_rounded,
            disabled: !hasText,
            onTap: _openLedgerReader,
          ),
        ],
      ),
    );
  }

  /// 打开账本原文阅读器(只读通路 —— 传 dramaUuid 而非任务 uuid)
  void _openLedgerReader() {
    final uuid = _dramaUuid;
    if (uuid == null || uuid.isEmpty) return;
    Navigator.pushNamed(context, AppRoute.novelReader, arguments: {
      'dramaUuid': uuid,
      'title': _ledger?['novelTitle']?.toString(),
    });
  }

  // ── 开跑前预估(两个入口共用) ─────────────────────────────────────────
  //
  // 为什么要做:用户点「一键生成」时能看到的只有一句模糊的"数小时",而这一步
  // 实际会烧掉几千积分、跑几十小时。报价单那侧已经在补价格(见 _buildQuoteCard),
  // 但报价单是**小说写完、账本建好之后**才出现的 —— 用户在按下按钮之前同样
  // 需要知道自己在选什么。实测 33 份真实账本:demo 档 5-8 集,novella 档按同一
  // 口径会到 80 集以上,量级差一个数量级,不说清就是在赌。
  //
  // 公式与后端 drama-pricing.ts 同源(集数 ÷ 单集时长 = 总时长):
  //   总时长(分) = 字数 ÷ 10000 × k_eff        k_eff = 8.35
  //   集数       = 总时长 × 60 ÷ 单集目标秒数
  //   镜头数     = 集数 × ceil(单集秒数 ÷ 10)   每镜 8-12 秒的新策略
  //   积分       = 镜头 × (图 8 + 视频 40) + 集数 × 2 次 LLM × 2
  //
  // ⚠ 这是**量级估计**,不是承诺。真实数字在确认报价单时给出(那时账本已建,
  // 集数与字数都是实数,而且失败镜头不计费,实际通常低于预估值)。

  /// 每万字折算多少分钟(k_eff)。取自 33 份真实账本的中位数(8.35,均值 8.04),
  /// 口径见 `tool/n2d-core/dist/budget.js` 的 `applyBudget`。
  static const _kEffPerWanChars = 8.35;

  /// 三个小说规模档位的目标字数(与入口 A 的 WbDropdown 文案一一对应)
  static const _tierChars = <String, int>{
    'demo': 20000,
    'novella': 200000,
    'full': 800000,
  };

  /// 千分位:积分动辄四位数,不加分隔符读不出量级
  String _grouped(int n) {
    final s = n.abs().toString();
    final buf = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
      buf.write(s[i]);
    }
    return '${n < 0 ? '-' : ''}$buf';
  }

  Widget _buildEstimateCard(int chars, String epTarget) {
    if (chars <= 0) return const SizedBox.shrink();
    final epSec = int.tryParse(epTarget) ?? 120;
    final totalMin = chars / 10000 * _kEffPerWanChars;
    final eps = (totalMin * 60 / epSec).ceil().clamp(1, 9999).toInt();
    final shotsPerEp = (epSec / 10).ceil().clamp(2, 999).toInt();
    final shots = eps * shotsPerEp;
    // 单价与后端 DEFAULT_UNIT_PRICES 一致(图 8 / 视频 40 / 文本 2)
    final credits = shots * 8 + shots * 40 + eps * 2 * 2;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surfaceLight,
        borderRadius: BorderRadius.circular(AppColors.slotRadius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.calculate_outlined,
                  size: 16, color: AppColors.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text('开跑前预估(按当前设定)',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTextStyles.labelSmall.copyWith(
                        color: AppColors.textSecondary,
                        fontWeight: FontWeight.w700)),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: [
              Expanded(child: _StatCell(label: '预计集数', value: '$eps 集')),
              Expanded(child: _StatCell(label: '预计镜头', value: '$shots 镜')),
              Expanded(
                  child:
                      _StatCell(label: '预计积分', value: _grouped(credits))),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            '按每万字约 ${_kEffPerWanChars.toStringAsFixed(1)} 分钟折算 · '
            '每集约 $shotsPerEp 镜 · 确认报价单时会给出准确积分与预计耗时,'
            '失败镜头不计费。',
            style: AppTextStyles.labelSmall
                .copyWith(color: AppColors.textTertiary),
          ),
        ],
      ),
    );
  }

  Widget _buildQuoteCard() {
    final budget = (_ledger!['gates'] as List?)?.firstWhere(
      (g) => (g as Map)['gate'] == 'gate1_budget',
      orElse: () => null,
    );
    final payload = (budget is Map) ? (budget['payload'] as Map?) : null;
    final minutes = payload?['totalMinutes'];
    final eps = payload?['episodeCount'];
    final chars = payload?['novelChars'];
    final status = (budget is Map) ? budget['status']?.toString() : null;

    // ── 真实价格(2026-09-15 补) ───────────────────────────────────────
    // 之前这张卡只有「时长/集数/字数」—— 用户点「确认报价」时根本不知道要花
    // 多少积分、等多久。实测 gate1 有 25 个卡在 waiting、只有 9 个 passed,
    // 一部分原因就是这张卡没给出决策需要的信息。
    // 数字全部来自后端 drama-pricing.ts 的同一套公式(报价单与批次实际扣费
    // 同源),不是前端另算的,所以不会出现"报价说 800、实际扣 2000"。
    final credits = _asInt(payload?['estimatedCredits']);
    final shots = _asInt(payload?['estimatedShots']);
    final shotsPerEp = _asInt(payload?['shotsPerEpisode']);
    final wallMin = _asInt(payload?['estimatedWallMinutes']);
    final epSec = _asInt(payload?['epTargetSec']);
    final keys = _asInt(payload?['keyCount']);
    final unit = (payload?['unitPrices'] is Map)
        ? Map<String, dynamic>.from(payload!['unitPrices'] as Map)
        : null;
    // 老报价单是补算的(读时回填,没落库),标出来免得用户以为当初就是这么报的
    final estimated = payload?['quoteEstimated'] == true;

    final wallText = wallMin == null
        ? null
        : (wallMin >= 60
            ? '${(wallMin / 60).toStringAsFixed(1)} 小时'
            : '$wallMin 分钟');

    return Container(
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.25)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.fact_check_outlined,
                  color: AppColors.primary, size: 20),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text('🛑 审批门 ① 报价单', style: AppTextStyles.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis)),
              const Spacer(),
              if (status != null) _GateStatusChip(status: status),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          if (payload != null && minutes != null) ...[
            Row(
              children: [
                Expanded(
                    child: _StatCell(label: '预计总时长', value: '$minutes 分钟')),
                Expanded(child: _StatCell(label: '集数', value: '$eps 集')),
                Expanded(
                    child: _StatCell(label: '小说字数', value: '$chars 字')),
              ],
            ),
            if (credits != null || shots != null || wallText != null) ...[
              const SizedBox(height: AppSpacing.lg),
              Row(
                children: [
                  Expanded(
                      child: _StatCell(
                          label: '预计积分',
                          value: credits == null ? '—' : '$credits')),
                  Expanded(
                      child: _StatCell(
                          label: '预计镜头',
                          value: shots == null ? '—' : '$shots 镜')),
                  Expanded(
                      child: _StatCell(
                          label: '预计耗时',
                          value: wallText ?? '—')),
                ],
              ),
            ],
            if (epSec != null || unit != null) ...[
              const SizedBox(height: AppSpacing.md),
              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: AppColors.surfaceLight,
                  borderRadius: BorderRadius.circular(AppColors.slotRadius),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (epSec != null && shotsPerEp != null)
                      Text(
                        '单集 $epSec 秒 · 约 $shotsPerEp 个镜头(每镜 8-12 秒)',
                        style: AppTextStyles.labelSmall
                            .copyWith(color: AppColors.textSecondary),
                      ),
                    if (unit != null) ...[
                      const SizedBox(height: AppSpacing.xs),
                      Text(
                        '计费单价:图 ${unit['image']} / 视频 ${unit['video']} / 文本 ${unit['llm']} 积分'
                        '${keys != null ? ' · 视频通道 $keys 路' : ''}',
                        style: AppTextStyles.labelSmall
                            .copyWith(color: AppColors.textTertiary),
                      ),
                    ],
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      '积分是上限估算:失败的镜头不计费,实际消耗通常低于此值。',
                      style: AppTextStyles.labelSmall
                          .copyWith(color: AppColors.textTertiary),
                    ),
                  ],
                ),
              ),
            ],
            if (estimated) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(
                '此为按当前单价补算的估算值(这份报价单创建时还没记价格)。',
                style: AppTextStyles.labelSmall
                    .copyWith(color: AppColors.warning),
              ),
            ],
            const SizedBox(height: AppSpacing.md),
            Text(
              '确认这份报价单后,AI 才开始生成角色设定与逐集剧本;驳回则不产生任何生成费用。',
              style: AppTextStyles.bodySmall
                  .copyWith(color: AppColors.textSecondary),
            ),
          ] else
            Text('报价数据加载中…',
                style: AppTextStyles.bodySmall
                    .copyWith(color: AppColors.textTertiary)),
        ],
      ),
    );
  }

  Widget _buildGatesPanel() {
    final gates = (_ledger!['gates'] as List?)
            ?.whereType<Map>()
            .map((g) => Map<String, dynamic>.from(g))
            .toList() ??
        const <Map<String, dynamic>>[];
    return Container(
      padding: const EdgeInsets.all(AppSpacing.xl),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.account_tree_rounded,
                  color: AppColors.primary, size: 20),
              const SizedBox(width: AppSpacing.sm),
              Flexible(child: Text('生产管线状态', style: AppTextStyles.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis)),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          ...gates.map((g) {
            final gate = g['gate']?.toString() ?? '';
            final status = g['status']?.toString() ?? 'waiting';
            final label = switch (gate) {
              'gate1_budget' => '① 报价确认',
              'gate2_design' => '② 设定(角色/场景/画风)',
              'gate3_script' => '③ 剧本(逐集分镜)',
              _ => gate,
            };
            return Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: Row(
                children: [
                  _GateStatusDot(status: status),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                      child: Text(label, style: AppTextStyles.bodyMedium)),
                  _GateStatusChip(status: status),
                ],
              ),
            );
          }),
          const SizedBox(height: AppSpacing.sm),
          Text(
            '审批门驱动流水线:①报价确认后自动生成设定 → ②设定确认后逐集生成剧本 → ③剧本确认后进入连集生产(分镜/关键帧/视频/成片),全程不通过不烧钱。',
            style: AppTextStyles.labelSmall
                .copyWith(color: AppColors.textTertiary),
          ),
        ],
      ),
    );
  }

  Widget _buildActionsBar() {
    final gate1 = _gateOf('gate1_budget');
    final g1 = gate1?['status']?.toString();
    final waiting = g1 == 'waiting';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_error != null) ...[
          WbInfoCard(
            icon: Icons.error_outline_rounded,
            text: _error!,
            accent: AppColors.danger,
          ),
          const SizedBox(height: AppSpacing.md),
        ],
        if (waiting) ...[
          Row(
            children: [
              Expanded(
                child: WbSubmitButton(
                  label: '驳回报价',
                  loadingLabel: '提交中…',
                  icon: Icons.close_rounded,
                  loading: _deciding,
                  disabled: _deciding,
                  onTap: () => _decideGate('gate1_budget', false),
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                flex: 2,
                child: WbSubmitButton(
                  label: '确认报价,开始生产',
                  loadingLabel: '提交中…',
                  icon: Icons.check_rounded,
                  loading: _deciding,
                  disabled: _deciding,
                  onTap: () => _decideGate('gate1_budget', true),
                ),
              ),
            ],
          ),
        ] else if (g1 == 'rejected') ...[
          // AppColors.danger 非 const,不能包 const
          _rejectedBlock('gate1_budget',
              '报价已驳回,未产生任何生成费用。可重新打开此门后再确认,或返回调整单集时长。'),
        ] else ...[
          // 门①已过 → Stage 2 流水线:设定门 → 剧本门 → 连集生产
          _buildGate2Card(),
          const SizedBox(height: AppSpacing.md),
          _buildGate3Card(),
        ],
      ],
    );
  }

  // ── 门②:设定(角色/场景/画风) ────────────────────────────────────────
  Widget _buildGate2Card() {
    final g = _gateOf('gate2_design');
    final status = g?['status']?.toString() ?? 'waiting';
    final p = _gatePayload('gate2_design');
    final state = p?['state']?.toString();

    final List<Widget> body = [];
    if (status == 'passed') {
      body.add(_stageHint(Icons.check_circle_outline_rounded, AppColors.success,
          '设定已通过${_asInt(p?['createdCount']) != null ? ' · 新建资产 ${p?['createdCount']} 项' : ''},逐集剧本阶段继续'));
      if (state == 'ready') body.add(_assetSummary(p!));
      // 自动定妆正是在这一步之后才跑,进度必须显示在同一张卡片上
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_portraitNotice());
    } else if (status == 'rejected') {
      body.add(_rejectedBlock('gate2_design',
          '设定已驳回,未进入剧本生成。可重新打开此门后重试生成设定,或直接确认当前设定。'));
    } else if (state == 'generating') {
      body.add(_stageSpinner('AI 正在生成角色 / 场景 / 画风设定…(约 1-2 分钟)'));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_stageEscapeHatch('gate2_design', g));
    } else if (state == 'ready') {
      body.add(_assetSummary(p!));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_portraitNotice());
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(Row(
        children: [
          Expanded(
            child: _GateMiniButton(
              label: '驳回',
              icon: Icons.close_rounded,
              color: AppColors.danger,
              busy: _deciding,
              onTap: () => _decideGate('gate2_design', false),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            flex: 2,
            child: WbSubmitButton(
              label: '确认设定,生成剧本',
              loadingLabel: '提交中…',
              icon: Icons.check_rounded,
              loading: _deciding,
              disabled: _deciding,
              onTap: _confirmGate2,
            ),
          ),
        ],
      ));
    } else if (state == 'failed') {
      body.add(_stageHint(Icons.error_outline_rounded, AppColors.danger,
          '设定生成失败:${p?['error'] ?? '未知原因'}'));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(WbSubmitButton(
        label: '重试生成设定',
        loadingLabel: '拉起中…',
        icon: Icons.refresh_rounded,
        loading: _deciding,
        disabled: _deciding,
        onTap: () => _retryGate('gate2_design'),
      ));
    } else {
      body.add(_stageHint(Icons.hourglass_top_rounded, AppColors.warning,
          '已排队,AI 正在拉起设定生成…'));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_GateMiniButton(
        label: '长时间无响应?点此重新拉起',
        icon: Icons.refresh_rounded,
        color: AppColors.textSecondary,
        busy: _deciding,
        onTap: () => _retryGate('gate2_design'),
      ));
    }
    return _stageCard(
      icon: Icons.palette_outlined,
      title: '审批门 ② 设定(角色/场景/画风)',
      gateStatus: status,
      body: body,
    );
  }

  // ── 门③:剧本(逐集大纲/分镜)+ 连集生产 ───────────────────────────────
  Widget _buildGate3Card() {
    final g = _gateOf('gate3_script');
    final status = g?['status']?.toString() ?? 'waiting';
    final p = _gatePayload('gate3_script');
    final state = p?['state']?.toString();
    final gate2Passed = _gateOf('gate2_design')?['status'] == 'passed';

    final List<Widget> body = [];
    if (status == 'passed' && (state == 'producing' || _batch != null)) {
      body.add(_buildProductionCard(p));
    } else if (status == 'rejected') {
      body.add(_rejectedBlock('gate3_script',
          '剧本已驳回,未进入成片生产。可重新打开此门后确认剧本,或重试生成剧本再决策。'));
    } else if (!gate2Passed) {
      body.add(_stageHint(Icons.lock_outline_rounded, AppColors.textTertiary,
          '门②设定通过后,自动逐集生成剧本(承接大纲)'));
    } else if (state == 'generating') {
      final done = _asInt(p?['episodesDone']) ?? 0;
      final total = _asInt(p?['episodesTotal']) ?? 0;
      body.add(_stageSpinner(total > 0
          ? 'AI 正在逐集写承接大纲… 第 $done/$total 集'
          : 'AI 正在逐集写承接大纲…'));
      if (total > 0) {
        body.addAll([
          const SizedBox(height: AppSpacing.md),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppColors.thumbRadius),
            child: LinearProgressIndicator(
              value: (done / total).clamp(0.0, 1.0),
              minHeight: 6,
              backgroundColor: AppColors.surfaceLight,
              color: AppColors.primary,
            ),
          ),
        ]);
      }
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_stageEscapeHatch('gate3_script', g));
    } else if (state == 'ready') {
      body.add(_episodeSummary(p!));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(Row(
        children: [
          Expanded(
            child: _GateMiniButton(
              label: '驳回',
              icon: Icons.close_rounded,
              color: AppColors.danger,
              busy: _deciding,
              onTap: () => _decideGate('gate3_script', false),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            flex: 2,
            child: WbSubmitButton(
              label: '确认剧本,开始生产',
              loadingLabel: '提交中…',
              icon: Icons.movie_filter_outlined,
              loading: _deciding,
              disabled: _deciding,
              onTap: () => _decideGate('gate3_script', true),
            ),
          ),
        ],
      ));
    } else if (state == 'failed') {
      body.add(_stageHint(Icons.error_outline_rounded, AppColors.danger,
          '阶段失败:${p?['error'] ?? '未知原因'}'));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(WbSubmitButton(
        label: '重试本阶段',
        loadingLabel: '拉起中…',
        icon: Icons.refresh_rounded,
        loading: _deciding,
        disabled: _deciding,
        onTap: () => _retryGate('gate3_script'),
      ));
    } else {
      body.add(_stageHint(Icons.hourglass_top_rounded, AppColors.warning,
          '已排队,AI 正在拉起剧本生成…'));
      body.add(const SizedBox(height: AppSpacing.md));
      body.add(_GateMiniButton(
        label: '长时间无响应?点此重新拉起',
        icon: Icons.refresh_rounded,
        color: AppColors.textSecondary,
        busy: _deciding,
        onTap: () => _retryGate('gate3_script'),
      ));
    }
    return _stageCard(
      icon: Icons.movie_outlined,
      title: '审批门 ③ 剧本(逐集分镜)与成片生产',
      gateStatus: status,
      body: body,
    );
  }

  // ── 连集生产进度(门③通过后) ──────────────────────────────────────────
  Widget _buildProductionCard(Map<String, dynamic>? p) {
    final b = _batch;
    // 刷新页面后 _batch 还是空的(轮询已按 batchStatus 停了),此时退回门 payload
    // 上后端写回的终态,否则会把一个已完成的批次画成"连集生产中 EP1/1"。
    final status = (b?['status'] ?? p?['batchStatus'] ?? 'queued').toString();
    final toEp = _asInt(b?['toEp'] ?? p?['toEp']) ?? 1;
    final curEp = _asInt(b?['cursorEp']) ?? 1;
    final curStep = _asInt(b?['cursorStep']) ?? 0;
    final stepLabel = (b?['cursorStepLabel'] ?? '').toString();
    final logs = (b?['log'] as List?)?.whereType<Map>().toList() ?? const [];
    final lastLog = logs.isNotEmpty ? logs.last : null;
    // 批次也会被后端重启打断:旧任务的锁最长能占住 90 分钟,期间 DB 仍是
    // running 而进度一动不动。把"多久没动"摆出来,别让用户干等。
    // 只认日志里的 at(后端 JS 写的真 UTC);批次的 updatedAt 是 DB 本地时间,
    // 拿来相减会得到负数,宁可显示不出也别显示错的。
    // 注:上游限流退避会持续刷新心跳条目的 at,所以这里量的不是"步骤多久没完成",
    // 而是"执行者多久没发声" —— 只有进程真没了/锁真僵尸才会触发 looksStuck。
    final staleMins = _minutesSince(lastLog?['at']);
    const stepLabels = ['承接与大纲', '资产预检', '分镜脚本', '分镜关键帧', '分镜视频', '成片与状态回写'];
    // 非终态且长时间没动 = 执行者已经没了(进程重启 / 队列僵尸锁)
    final looksStuck = staleMins != null &&
        staleMins >= 10 &&
        status != 'done' &&
        status != 'cancelled';

    final (Color color, String title) = switch (status) {
      'done' => (AppColors.success, '全部完成 🎉 $toEp 集成片已产出'),
      'paused' => (AppColors.warning, '生产暂停(多为预算耗尽)——可到剧集详情提高预算续跑'),
      'failed' => (AppColors.danger,
          '生产失败:${(b?['error'] ?? p?['batchError'] ?? '见剧集详情').toString()}'),
      'cancelled' => (AppColors.textTertiary, '生产已取消'),
      _ => (AppColors.primary,
          '连集生产中:EP$curEp/$toEp · ${stepLabel.isNotEmpty ? stepLabel : (curStep >= 0 && curStep < 6 ? stepLabels[curStep] : '')}'),
    };
    final double? value = status == 'done'
        ? 1.0
        : toEp > 0
            ? (((curEp - 1) * 6 + curStep + (status == 'running' ? 0 : 1)) /
                    (toEp * 6))
                .clamp(0.0, 1.0)
            : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.smart_display_rounded, size: 18, color: color),
            const SizedBox(width: AppSpacing.sm),
            Expanded(child: Text(title, style: AppTextStyles.bodyMedium.copyWith(color: color))),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        ClipRRect(
          borderRadius: BorderRadius.circular(AppColors.thumbRadius),
          child: LinearProgressIndicator(
            value: value,
            minHeight: 6,
            backgroundColor: AppColors.surfaceLight,
            color: color,
          ),
        ),
        if (status != 'done' && lastLog != null) ...[
          const SizedBox(height: AppSpacing.sm),
          Text(
            'EP${lastLog['ep']} ${(lastLog['msg'] ?? '').toString()}',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary),
          ),
        ],
        if (logs.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.sm),
          // 2026-09-16(批3 透明工作台):批次全时间线 —— 之前只取 log.last,
          // 用户看不到"每集哪步失败/为什么/烧了多少分";现在全量可展开倒序核对。
          Theme(
            data: ThemeData(dividerColor: Colors.transparent),
            child: ExpansionTile(
              tilePadding: EdgeInsets.zero,
              childrenPadding: const EdgeInsets.only(bottom: AppSpacing.sm),
              title: Text('全时间线(${logs.length}条 · 含失败原因与逐步积分)',
                  style: AppTextStyles.labelSmall.copyWith(color: AppColors.textSecondary)),
              children: [
                ...logs.reversed.map((l) {
                  final ok = l['ok'] == true;
                  final at = (l['at'] ?? '').toString();
                  final hhmm = at.length >= 16 ? at.substring(11, 16) : '';
                  final credits = (l['credits'] as num?) ?? 0;
                  return Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(ok ? Icons.check_circle_outline : Icons.error_outline,
                            size: 13, color: ok ? AppColors.success : AppColors.danger),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(
                          child: Text(
                            'EP${l['ep']} 第${(_asInt(l['step']) ?? 0) + 1}步 · ${l['msg'] ?? ''}'
                            '${credits > 0 ? ' · $credits 分' : ''}'
                            '${hhmm.isNotEmpty ? ' · $hhmm' : ''}',
                            style: AppTextStyles.labelSmall.copyWith(
                                fontSize: 10,
                                color: ok ? AppColors.textSecondary : AppColors.danger),
                          ),
                        ),
                      ],
                    ),
                  );
                }),
              ],
            ),
          ),
        ],
        if (looksStuck) ...[
          const SizedBox(height: AppSpacing.md),
          Text(
            '已经 $staleMins 分钟没有新进展 · 批次执行者活在后端进程内存里,'
            '进程重启后 DB 仍是「生产中」但不会再动,可在此重新入队续跑',
            style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning),
          ),
          const SizedBox(height: AppSpacing.sm),
          _GateMiniButton(
            label: '长时间无响应?点此从断点续跑',
            icon: Icons.refresh_rounded,
            color: AppColors.textSecondary,
            busy: _deciding,
            onTap: _resumeBatch,
          ),
        ],
        if (status == 'paused' || status == 'failed') ...[
          const SizedBox(height: AppSpacing.md),
          _GateMiniButton(
            label: status == 'paused' ? '从断点续跑' : '重试该批次',
            icon: Icons.play_arrow_rounded,
            color: AppColors.primary,
            busy: _deciding,
            onTap: _resumeBatch,
          ),
        ],
        // ── 就地控制(2026-09-15) ───────────────────────────────────────
        // 以前这四个动作散在剧集详情页与剧集列表页,而工作台正是用户盯着进度
        // 的那一屏 —— 想暂停得先离开正在看的进度。运行中给「暂停 / 取消」,
        // 任何状态都给「看成片」(失败的批次也可能已经出了前几集的成片,
        // 那是烧过配额的,入口不能藏)与「删除项目」(带二次确认)。
        const SizedBox(height: AppSpacing.md),
        Row(
          children: [
            if (status == 'running' || status == 'queued') ...[
              Expanded(
                child: _GateMiniButton(
                  label: '暂停',
                  icon: Icons.pause_rounded,
                  color: AppColors.warning,
                  busy: _projectBusy,
                  onTap: () => _setBatchStatus('paused', '已暂停,可在断点续跑'),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: _GateMiniButton(
                  label: '取消生产',
                  icon: Icons.stop_rounded,
                  color: AppColors.danger,
                  busy: _projectBusy,
                  onTap: _confirmCancelBatch,
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
            ],
            Expanded(
              child: _GateMiniButton(
                label: _playing ? '打开中…' : '看成片',
                icon: Icons.play_circle_outline_rounded,
                color: AppColors.success,
                busy: _playing,
                onTap: _playFinal,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        Row(
          children: [
            Expanded(
              flex: 2,
              child: WbSubmitButton(
                label: '打开剧集详情(逐集进度 / 分镜 / 关键帧)',
                icon: Icons.open_in_new_rounded,
                onTap: _openDramaDetail,
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: _GateMiniButton(
                label: '删除项目',
                icon: Icons.delete_outline_rounded,
                color: AppColors.danger,
                busy: _projectBusy,
                onTap: _deleteProject,
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// 取消生产要二次确认:取消是终态,不会自动续跑,而已经烧掉的配额不会退回。
  Future<void> _confirmCancelBatch() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('取消生产'),
        content: const Text('取消后这一批不会再继续,已经生成的集与成片会保留,'
            '但不会自动补做剩下的集。\n\n之后仍可从这里「从断点续跑」恢复。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('再想想'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: const Text('取消生产'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await _setBatchStatus('cancelled', '已取消生产');
  }

  // ── 阶段卡片小组件 ────────────────────────────────────────────────────
  Widget _stageCard({
    required IconData icon,
    required String title,
    required String gateStatus,
    required List<Widget> body,
  }) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.lg),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: AppColors.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(child: Text(title, style: AppTextStyles.titleSmall)),
              _GateStatusChip(status: gateStatus),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          ...body,
        ],
      ),
    );
  }

  Widget _stageHint(IconData icon, Color color, String text) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Text(text,
              style: AppTextStyles.bodySmall.copyWith(color: AppColors.textSecondary)),
        ),
      ],
    );
  }

  /// 「已驳回」区块:说明 + 当时的驳回备注 + 「重新打开此门」。
  ///
  /// 三个门共用。驳回是可撤销的(后端 `gates/:gate/reopen`),所以这里必须
  /// 给出按钮 —— 2026-09-15 之前三个门的 rejected 分支都只有一行文字,用户
  /// 唯一的出路是删掉整个项目,而"驳回"本意只是"这次不满意,我调一下再来"。
  ///
  /// 备注来自后端 decideGate 落库的 `rejectedNote`:reopen 之后它会保留,
  /// 用户能看见自己当初为什么否掉,否则"改回待确认"会丢掉唯一一条上下文。
  Widget _rejectedBlock(String gateKey, String text) {
    final note = _gatePayload(gateKey)?['rejectedNote']?.toString();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _stageHint(Icons.block_rounded, AppColors.danger, text),
        if (note != null && note.trim().isNotEmpty) ...[
          const SizedBox(height: AppSpacing.sm),
          Text('驳回备注:$note',
              style: AppTextStyles.labelSmall
                  .copyWith(color: AppColors.textTertiary)),
        ],
        const SizedBox(height: AppSpacing.md),
        WbSubmitButton(
          label: '重新打开此门',
          loadingLabel: '提交中…',
          icon: Icons.lock_open_rounded,
          loading: _deciding,
          disabled: _deciding,
          onTap: () => _reopenGate(gateKey),
        ),
      ],
    );
  }

  Widget _stageSpinner(String text) {
    return Row(
      children: [
        // AppColors.* 是 static late 非 const,这里不能包 const(仓库已知坑 #2)
        SizedBox(
          width: AppSpacing.lg, height: AppSpacing.lg,
          child: CircularProgressIndicator(strokeWidth: 2.2, color: AppColors.primary),
        ),
        const SizedBox(width: AppSpacing.md),
        Expanded(
          child: Text(text,
              style: AppTextStyles.bodySmall.copyWith(color: AppColors.textSecondary)),
        ),
      ],
    );
  }

  Widget _assetSummary(Map<String, dynamic> p) {
    String names(String key) {
      final list = (p[key] as List?)?.whereType<Map>().toList() ?? const [];
      if (list.isEmpty) return '—';
      final s = list.map((x) => (x['name'] ?? '').toString()).join('、');
      return s.length > 90 ? '${s.substring(0, 90)}…' : s;
    }

    final rows = <Widget>[
      _assetRow(Icons.person_outline, '角色', names('characters')),
      _assetRow(WorkbenchIcons.scene, '场景', names('locations')),
      _assetRow(WorkbenchIcons.prop, '道具', names('props')),
    ];
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surfaceLight,
        borderRadius: BorderRadius.circular(AppColors.slotRadius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0) const SizedBox(height: AppSpacing.sm),
            rows[i],
          ],
        ],
      ),
    );
  }

  Widget _assetRow(IconData icon, String label, String value) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 14, color: AppColors.textSecondary),
        const SizedBox(width: AppSpacing.sm),
        Text('$label:', style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Text(value,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppTextStyles.bodySmall),
        ),
      ],
    );
  }

  /// 门② 的定妆状态条。按后端批次状态给四种口径,绝不谎报:
  ///   running          → 进度条 + done/total + 去资产库查看
  ///   终态但仍有待定妆  → 失败项与原因直接摊开 + 去资产库重试
  ///   全部就绪          → 一句成功确认(关键帧会走图生图)
  ///   还没开跑(idle)    → 说明「确认设定后自动开始批量定妆」+ 想去就去的入口
  /// 资产还没拉回来时只报「读取中」—— 空列表不等于「都已定妆」。
  Widget _portraitNotice() {
    final items =
        (_portrait['items'] as List?)?.whereType<Map>().toList() ?? const [];
    final running = '${_portrait['status'] ?? 'idle'}' == 'running';
    final total = _asInt(_portrait['total']) ?? 0;
    final done = _asInt(_portrait['done']) ?? 0;
    final failed = items.where((i) => i['state'] == 'failed').toList();
    final undressed = _undressedAssets;

    if (running) {
      final settled = total > 0 ? ((done + failed.length) / total) : 0.0;
      return _portraitCard(
        AppColors.primary, Icons.auto_awesome,
        '自动定妆进行中 $done/$total 项',
        children: [
          const SizedBox(height: AppSpacing.sm),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppColors.thumbRadius),
            child: LinearProgressIndicator(
              value: total > 0 ? settled : null,
              minHeight: 6,
              backgroundColor: AppColors.border.withValues(alpha: 0.4),
              color: AppColors.primary,
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text('与逐集剧本生成并行推进,每张图约 10~40 秒。'
              '等门③ 剧本出来时,定妆基本已就绪。',
              style: AppTextStyles.bodySmall
                  .copyWith(color: AppColors.textSecondary, height: 1.55)),
          const SizedBox(height: AppSpacing.md),
          _GateMiniButton(
            label: '去资产库查看',
            icon: Icons.palette_outlined,
            color: AppColors.primary,
            onTap: _openAssetsTab,
          ),
        ],
      );
    }

    if (!_assetsLoaded || _assets.isEmpty) {
      return _stageHint(Icons.hourglass_empty_rounded,
          AppColors.textTertiary, '正在读取资产与定妆进度…');
    }

    if (undressed.isEmpty) {
      return _stageHint(Icons.brush_rounded, AppColors.success,
          '定妆图已全部就绪(${_assets.length} 项资产各有可用参考图),'
              '关键帧走图生图,主角不会跨镜换脸');
    }

    final names = undressed
        .map((a) => (a['name'] ?? a['slug'] ?? '').toString())
        .where((x) => x.isNotEmpty)
        .toList();
    final head = names.isEmpty
        ? ''
        : '${names.take(4).join('、')}${names.length > 4 ? ' 等' : ''} —— ';

    if (failed.isNotEmpty) {
      return _portraitCard(
        AppColors.danger, Icons.error_outline_rounded,
        '${undressed.length} 项资产定妆没成功',
        children: [
          const SizedBox(height: AppSpacing.sm),
          for (final f in failed.take(4))
            Text('· ${f['name'] ?? ''}:${f['error'] ?? '未知原因'}',
                style: AppTextStyles.labelSmall
                    .copyWith(color: AppColors.danger, height: 1.5)),
          const SizedBox(height: AppSpacing.sm),
          Text('到资产库点「一键定妆剩余 ${undressed.length} 项」只会补这些,'
              '已成功的图不会重烧。',
              style: AppTextStyles.bodySmall
                  .copyWith(color: AppColors.textSecondary, height: 1.55)),
          const SizedBox(height: AppSpacing.md),
          _GateMiniButton(
            label: '去资产库重试',
            icon: Icons.refresh_rounded,
            color: AppColors.danger,
            onTap: _openAssetsTab,
          ),
        ],
      );
    }

    return _portraitCard(
      AppColors.warning, Icons.auto_awesome,
      '${undressed.length} 项资产待定妆',
      children: [
        const SizedBox(height: AppSpacing.sm),
        Text('$head'
            '点「确认设定,生成剧本」后系统会自动开始批量定妆(与剧本生成并行),'
            '通常在你审完门③ 剧本前就全部就绪,不需要再手动逐项点。'
            '想现在就看某一项,可以先进资产库。',
            style: AppTextStyles.bodySmall
                .copyWith(color: AppColors.textSecondary, height: 1.55)),
        const SizedBox(height: AppSpacing.md),
        // 竖排而不是横排 Row:这个状态没被视觉回归覆盖,窄屏下赌宽度不值当
        _GateMiniButton(
          label: _assetsLoading ? '读取资产…' : '先去资产库看看',
          icon: Icons.palette_outlined,
          color: AppColors.warning,
          busy: _assetsLoading,
          onTap: _openAssetsTab,
        ),
        const SizedBox(height: AppSpacing.sm),
        Text('或直接点下方「确认设定,生成剧本」,定妆会自动开跑。',
            style: AppTextStyles.labelSmall
                .copyWith(color: AppColors.textTertiary, height: 1.5)),
      ],
    );
  }

  /// 定妆状态条外壳(颜色 + 图标 + 标题由调用方给,内容列自由展开)
  Widget _portraitCard(Color color, IconData icon, String title,
      {required List<Widget> children}) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppColors.cardRadius),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: color),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(title,
                    style: AppTextStyles.bodyMedium.copyWith(
                        color: color, fontWeight: FontWeight.w800)),
              ),
            ],
          ),
          ...children,
        ],
      ),
    );
  }

  Widget _episodeSummary(Map<String, dynamic> p) {
    final eps = (p['episodes'] as List?)?.whereType<Map>().toList() ?? const [];
    final failed = (p['failedEps'] as List?)?.whereType<Map>().toList() ?? const [];
    final shown = eps.take(6).toList();
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: AppColors.surfaceLight,
        borderRadius: BorderRadius.circular(AppColors.slotRadius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final e in shown)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.xs),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('EP${e['epNo']}',
                      style: AppTextStyles.labelSmall
                          .copyWith(color: AppColors.primary, fontWeight: FontWeight.w800)),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      '${e['title'] ?? ''} · ${e['scenes'] ?? 0} 场${(e['hookOut'] ?? '').toString().isNotEmpty ? ' · 钩子:${(e['hookOut']).toString()}' : ''}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: AppTextStyles.bodySmall,
                    ),
                  ),
                ],
              ),
            ),
          if (eps.length > shown.length)
            Text('… 共 ${eps.length} 集',
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.textTertiary)),
          if (failed.isNotEmpty)
            Text('${failed.length} 集大纲生成失败(生产中会自动重试):${failed.map((f) => 'EP${f['ep']}').join('、')}',
                style: AppTextStyles.labelSmall.copyWith(color: AppColors.warning)),
        ],
      ),
    );
  }

  Map<String, dynamic>? _gateOf(String gate) {
    final gates = (_ledger!['gates'] as List?)
        ?.whereType<Map>()
        .map((g) => Map<String, dynamic>.from(g));
    for (final g in gates ?? const Iterable<Map<String, dynamic>>.empty()) {
      if (g['gate'] == gate) return g;
    }
    return null;
  }
}

// ─── 小组件 ─────────────────────────────────────────────────────────────

class _StatCell extends StatelessWidget {
  final String label;
  final String value;
  const _StatCell({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: AppTextStyles.labelSmall
                .copyWith(color: AppColors.textTertiary)),
        const SizedBox(height: AppSpacing.xs),
        Text(value,
            style: AppTextStyles.titleSmall
                .copyWith(
                    color: AppColors.primary, fontWeight: FontWeight.w900)),
      ],
    );
  }
}

class _GateStatusChip extends StatelessWidget {
  final String status;
  const _GateStatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final (text, color) = switch (status) {
      'waiting' => ('待确认', AppColors.warning),
      'passed' => ('已通过', AppColors.success),
      'rejected' => ('已驳回', AppColors.danger),
      _ => (status, AppColors.textTertiary),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(AppRadius.pill),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(text,
          style: AppTextStyles.labelSmall.copyWith(color: color)),
    );
  }
}

class _GateStatusDot extends StatelessWidget {
  final String status;
  const _GateStatusDot({required this.status});

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      'waiting' => AppColors.warning,
      'passed' => AppColors.success,
      'rejected' => AppColors.danger,
      _ => AppColors.textTertiary,
    };
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color.withValues(alpha: 0.9),
      ),
    );
  }
}

/// 门卡片内的次级操作按钮(描边小按钮;主操作用 WbSubmitButton)
class _GateMiniButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final Color color;
  final bool busy;
  final VoidCallback? onTap;

  const _GateMiniButton({
    required this.label,
    required this.color,
    this.icon,
    this.busy = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final active = !busy && onTap != null;
    return InkWell(
      onTap: active ? onTap : null,
      borderRadius: BorderRadius.circular(AppColors.cardRadius),
      child: Container(
        height: 46,
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.06),
          borderRadius: BorderRadius.circular(AppColors.cardRadius),
          border: Border.all(color: color.withValues(alpha: 0.45)),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (busy)
              SizedBox(
                width: AppSpacing.lg,
                height: AppSpacing.lg,
                child: CircularProgressIndicator(strokeWidth: 2, color: color),
              )
            else if (icon != null)
              Icon(icon, size: 16, color: color),
            const SizedBox(width: AppSpacing.sm),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTextStyles.labelSmall
                    .copyWith(color: color, fontWeight: FontWeight.w700),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
