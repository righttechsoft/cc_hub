import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';
import '../relative_time.dart';
import '../store.dart';
import '../terminal_screen.dart';
import '../theme.dart';
import '../widgets/accent_square_button.dart';
import '../widgets/mini_toggle.dart';
import '../widgets/status_chip.dart';

class _TimelineEvent {
  final String type;
  final String? payload;
  final int createdAt;

  const _TimelineEvent({required this.type, this.payload, required this.createdAt});
}

/// Best-effort human-readable one-liner for an event's JSON payload (the
/// `prompt` or `message` field, if present) — display-only, never affects
/// what's fetched or stored.
String? _humanSummary(String? payload) {
  if (payload == null || payload.isEmpty) return null;
  try {
    final decoded = jsonDecode(payload);
    if (decoded is Map) {
      final prompt = decoded['prompt'];
      if (prompt is String && prompt.trim().isNotEmpty) return prompt;
      final message = decoded['message'];
      if (message is String && message.trim().isNotEmpty) return message;
    }
  } catch (_) {
    // Not JSON / not decodable — no summary available.
  }
  return null;
}

Color _toneColor(String type, HubTokens tokens) {
  switch (type) {
    case 'UserPromptSubmit':
      return tokens.accent;
    case 'Notification':
      return tokens.stWarn;
    case 'Stop':
      return tokens.dim;
    default:
      return tokens.dim;
  }
}

/// Best-effort compact one-liner for a tool_use's `toolInput` JSON string:
/// the first non-null of a handful of common argument keys, or the raw
/// string if it's not decodable JSON / not a map.
String _compactToolInput(String? toolInput) {
  if (toolInput == null || toolInput.isEmpty) return '';
  try {
    final decoded = jsonDecode(toolInput);
    if (decoded is Map) {
      for (final key in const ['command', 'file_path', 'prompt', 'pattern', 'url', 'query', 'path']) {
        final value = decoded[key];
        if (value != null) {
          return value is String ? value : jsonEncode(value);
        }
      }
    }
  } catch (_) {
    // Not JSON — fall through to the raw string.
  }
  return toolInput;
}

/// Default tail size for the initial transcript fetch, matching the hub API
/// contract's example (`?tailBytes=262144`).
const int _kTranscriptTailBytes = 262144;

const Set<String> _kAllowedImageExts = {'png', 'jpg', 'jpeg', 'webp'};

/// Extension the hub writes the temp file with — derived from the picked
/// file's own extension (falls back to 'png' for anything unrecognized).
String _imageExtFromPath(String path) {
  final dot = path.lastIndexOf('.');
  if (dot == -1 || dot == path.length - 1) return 'png';
  final ext = path.substring(dot + 1).toLowerCase();
  return _kAllowedImageExts.contains(ext) ? ext : 'png';
}

/// Session detail: header (live status via store), conversation view (the
/// actual transcript — user/assistant/tool turns, like the desktop terminal)
/// with prompt composer and auto-continue toggle.
///
/// The conversation view is backed by `GET /sessions/:id/transcript`
/// (tail-fetched, then polled/pushed incrementally — see [_loadTranscript]).
/// If a transcript is unavailable (409 `no_transcript`, 404, or a network
/// failure on the very first fetch), the screen falls back to the original
/// hook-event timeline ([_fallbackEventTimeline]) — unchanged from before,
/// including its own newest-first scroll behavior — behind a small banner.
class SessionDetailScreen extends StatefulWidget {
  final String sessionId;

  const SessionDetailScreen({super.key, required this.sessionId});

  @override
  State<SessionDetailScreen> createState() => _SessionDetailScreenState();
}

class _SessionDetailScreenState extends State<SessionDetailScreen> {
  Session? _session; // fields not carried by WS frames (cwd, autoContinue, ...)
  List<_TimelineEvent> _events = [];
  bool _loading = true;
  String? _loadError;
  bool _autoContinueBusy = false;
  bool _sending = false;
  bool _attachingImage = false;

  // Transcript (conversation) state.
  List<TranscriptEntry> _transcriptEntries = [];
  int? _transcriptByteOffset;
  bool _transcriptTruncatedHead = false;
  bool _transcriptLoading = true;
  bool _transcriptAvailable = true; // flips false on a failed *initial* fetch
  final Set<String> _expandedToolUseKeys = {};
  Timer? _transcriptPollTimer;
  Timer? _transcriptDebounce;

  final _promptController = TextEditingController();
  final _scrollController = ScrollController(); // fallback event timeline
  final _transcriptScrollController = ScrollController();
  StreamSubscription<Map<String, dynamic>>? _eventSub;

  @override
  void initState() {
    super.initState();
    _eventSub = context
        .read<HubStore>()
        .eventFrames
        .where((f) => f['sessionId'] == widget.sessionId)
        .listen(_onLiveEvent);
    _load();
    _loadTranscript(initial: true);
    _transcriptPollTimer = Timer.periodic(const Duration(seconds: 4), (_) => _pollTranscript());
  }

  Future<void> _load() async {
    try {
      final detail = await context.read<ApiClient>().getSession(widget.sessionId);
      if (!mounted) return;
      setState(() {
        _session = detail.session;
        _events = detail.events
            .map((e) => _TimelineEvent(type: e.type, payload: e.payload, createdAt: e.createdAt))
            .toList();
        _loading = false;
      });
      _scrollToNewestSoon();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadError = '$e';
      });
    }
  }

  void _pollTranscript() {
    if (!mounted || !_transcriptAvailable) return;
    final status = context.read<HubStore>().sessions[widget.sessionId]?.status ?? _session?.status;
    if (status != 'active') return;
    _loadTranscript();
  }

  Future<void> _loadTranscript({bool initial = false}) async {
    final wasNearBottom = _isTranscriptNearBottom();
    try {
      final result = await context.read<ApiClient>().getTranscript(
            widget.sessionId,
            tailBytes: initial ? _kTranscriptTailBytes : null,
            afterByte: initial ? null : _transcriptByteOffset,
          );
      if (!mounted) return;
      if (!result.available) {
        setState(() {
          _transcriptAvailable = false;
          _transcriptLoading = false;
        });
        return;
      }
      setState(() {
        _transcriptEntries = initial ? result.entries : [..._transcriptEntries, ...result.entries];
        _transcriptByteOffset = result.byteOffset;
        if (initial) _transcriptTruncatedHead = result.truncatedHead;
        _transcriptAvailable = true;
        _transcriptLoading = false;
      });
      if (initial) {
        _scrollTranscriptToBottomWhenReady();
      } else if (result.entries.isNotEmpty) {
        _maybeAutoScrollTranscript(force: wasNearBottom);
      }
    } catch (e) {
      if (!mounted) return;
      if (initial) {
        setState(() {
          _transcriptAvailable = false;
          _transcriptLoading = false;
        });
      }
      // Non-initial failures: leave state as-is, the next poll/debounce retries.
    }
  }

  bool _isTranscriptNearBottom() {
    if (!_transcriptScrollController.hasClients) return true;
    final position = _transcriptScrollController.position;
    return (position.maxScrollExtent - position.pixels) <= 100;
  }

  void _maybeAutoScrollTranscript({required bool force}) {
    if (!force) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_transcriptScrollController.hasClients) return;
      _transcriptScrollController.jumpTo(_transcriptScrollController.position.maxScrollExtent);
    });
  }

  // On first open the transcript list isn't mounted yet (the view shows a spinner until _load()
  // finishes), so a single post-frame jump can fire before the list exists and be skipped. Retry
  // across frames until the controller is attached with content dimensions, then jump to the
  // bottom — and once more next frame in case variable-height content grew after first layout.
  void _scrollTranscriptToBottomWhenReady({int attempts = 0}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final ready = _transcriptScrollController.hasClients &&
          _transcriptScrollController.position.hasContentDimensions;
      if (!ready) {
        if (attempts < 10) _scrollTranscriptToBottomWhenReady(attempts: attempts + 1);
        return;
      }
      _transcriptScrollController.jumpTo(_transcriptScrollController.position.maxScrollExtent);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _transcriptScrollController.hasClients) {
          _transcriptScrollController.jumpTo(_transcriptScrollController.position.maxScrollExtent);
        }
      });
    });
  }

  void _onLiveEvent(Map<String, dynamic> data) {
    final createdAt = (data['createdAt'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch;
    setState(() {
      _events = [
        ..._events,
        _TimelineEvent(
          type: data['eventType'] as String? ?? 'event',
          payload: data['payload'] as String?,
          createdAt: createdAt,
        ),
      ];
    });
    if (_transcriptAvailable) {
      _transcriptDebounce?.cancel();
      _transcriptDebounce = Timer(const Duration(milliseconds: 500), () {
        if (mounted) _loadTranscript();
      });
    } else {
      _scrollToNewestSoon();
    }
  }

  void _scrollToNewestSoon() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(0, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
    });
  }

  void _jumpToNewest() {
    if (!_scrollController.hasClients) return;
    _scrollController.animateTo(0, duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
  }

  /// Posts [prompt] via `POST /sessions/:id/prompt` and shows the standard
  /// delivery snackbar (queued vs spawned) or an error snackbar. Shared by
  /// the composer's send button and the image-compose sheet below, so both
  /// paths go through the same endpoint and get the same result.
  /// Returns true on success (caller decides what to clear).
  Future<bool> _sendPromptText(String prompt) async {
    setState(() => _sending = true);
    try {
      final result = await context.read<ApiClient>().sendPrompt(widget.sessionId, prompt);
      if (!mounted) return true;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(result.delivery == 'queued' ? 'Queued — runs at next turn end' : 'Spawned'),
        ),
      );
      return true;
    } on ApiException catch (e) {
      if (!mounted) return false;
      showErrorSnack(context, e.message);
      return false;
    } catch (e) {
      if (!mounted) return false;
      showErrorSnack(context, '$e');
      return false;
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _send() async {
    final prompt = _promptController.text.trim();
    if (prompt.isEmpty || _sending) return;
    final ok = await _sendPromptText(prompt);
    if (ok) _promptController.clear();
  }

  /// Small Gallery/Camera picker, matching the DraggableScrollableSheet style
  /// used elsewhere in the app (see kb.dart's note viewer).
  Future<void> _showImageSourceMenu() async {
    final tokens = context.tokens;
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      backgroundColor: tokens.surface,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(Icons.photo_library_outlined, color: tokens.text),
              title: Text('Gallery', style: hubSans(size: 14, color: tokens.text)),
              onTap: () => Navigator.of(sheetContext).pop(ImageSource.gallery),
            ),
            ListTile(
              leading: Icon(Icons.photo_camera_outlined, color: tokens.text),
              title: Text('Camera', style: hubSans(size: 14, color: tokens.text)),
              onTap: () => Navigator.of(sheetContext).pop(ImageSource.camera),
            ),
          ],
        ),
      ),
    );
    if (source != null) await _attachImage(source);
  }

  /// Picks + compresses an image, lets the user preview it and add a
  /// message in a compose sheet, then uploads it (`POST
  /// /sessions/:id/image`, which just saves the file and returns its path)
  /// and sends the text + path together as one prompt via the normal
  /// prompt-send path — works for any session, attached or not.
  Future<void> _attachImage(ImageSource source) async {
    if (_attachingImage) return;
    // Grabbed synchronously (before any await) so this method never reads
    // `context` across an async gap.
    final apiClient = context.read<ApiClient>();
    setState(() => _attachingImage = true);
    try {
      final picked = await ImagePicker().pickImage(
        source: source,
        maxWidth: 1920,
        maxHeight: 1920,
        imageQuality: 80,
      );
      if (picked == null) return; // user cancelled
      final bytes = await picked.readAsBytes();
      final ext = _imageExtFromPath(picked.path);
      if (!mounted) return;
      final text = await _showComposeSheet(bytes);
      if (text == null) return; // cancelled

      final base64Image = base64Encode(bytes);
      final path = await apiClient.attachImage(widget.sessionId, base64Image, ext);
      final trimmedText = text.trim();
      final prompt = trimmedText.isEmpty ? path : '$trimmedText\n$path';
      await _sendPromptText(prompt);
    } on ApiException catch (e) {
      if (!mounted) return;
      showErrorSnack(context, e.message);
    } catch (e) {
      if (!mounted) return;
      showErrorSnack(context, '$e');
    } finally {
      if (mounted) setState(() => _attachingImage = false);
    }
  }

  /// Bottom sheet previewing the picked image with a text field for an
  /// optional accompanying message. Returns the entered text (possibly
  /// empty — image-only is allowed) on Send, or null on Cancel.
  Future<String?> _showComposeSheet(Uint8List bytes) async {
    final tokens = context.tokens;
    final textController = TextEditingController();
    final sent = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: tokens.surface,
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(sheetContext).viewInsets.bottom),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(kRadiusCard),
                  child: Image.memory(bytes, height: 200, fit: BoxFit.contain),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: textController,
                  maxLines: 4,
                  minLines: 1,
                  autofocus: true,
                  decoration: const InputDecoration(hintText: 'Add a message…'),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: TextButton(
                        onPressed: () => Navigator.of(sheetContext).pop(false),
                        child: const Text('Cancel'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: FilledButton(
                        onPressed: () => Navigator.of(sheetContext).pop(true),
                        child: const Text('Send'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
    return sent == true ? textController.text : null;
  }

  Future<void> _toggleAutoContinue(bool value) async {
    setState(() => _autoContinueBusy = true);
    try {
      final enabled = await context.read<ApiClient>().setAutoContinue(widget.sessionId, value);
      final current = _session;
      if (!mounted || current == null) return;
      setState(() {
        _session = Session(
          id: current.id,
          instanceId: current.instanceId,
          cwd: current.cwd,
          transcriptPath: current.transcriptPath,
          status: current.status,
          startedAt: current.startedAt,
          lastEventAt: current.lastEventAt,
          endedAt: current.endedAt,
          lastPrompt: current.lastPrompt,
          autoContinue: enabled ? 1 : 0,
          continuesToday: current.continuesToday,
          instanceName: current.instanceName,
        );
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      showErrorSnack(context, e.message);
    } catch (e) {
      if (!mounted) return;
      showErrorSnack(context, '$e');
    } finally {
      if (mounted) setState(() => _autoContinueBusy = false);
    }
  }

  @override
  void dispose() {
    _eventSub?.cancel();
    _transcriptPollTimer?.cancel();
    _transcriptDebounce?.cancel();
    _promptController.dispose();
    _scrollController.dispose();
    _transcriptScrollController.dispose();
    super.dispose();
  }

  Widget _header(BuildContext context, Session? session, String? liveStatus, bool terminalLive) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              InkWell(
                onTap: () => Navigator.of(context).pop(),
                borderRadius: BorderRadius.circular(kRadiusCard),
                child: SizedBox(
                  width: 30,
                  height: 30,
                  child: Icon(Icons.arrow_back, size: 18, color: tokens.text),
                ),
              ),
              Expanded(
                child: Text(
                  session?.instanceName ?? widget.sessionId,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: hubSans(
                    size: 16,
                    weight: FontWeight.w700,
                    color: tokens.text,
                    letterSpacing: -0.16,
                  ),
                ),
              ),
              if (session != null && terminalLive) ...[
                const SizedBox(width: 4),
                InkWell(
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) =>
                          TerminalScreen(cwd: session.cwd, instanceName: session.instanceName),
                    ),
                  ),
                  borderRadius: BorderRadius.circular(kRadiusCard),
                  child: SizedBox(
                    width: 30,
                    height: 30,
                    child: Icon(Icons.terminal, size: 18, color: tokens.stRunning),
                  ),
                ),
              ],
              if (session != null) ...[
                const SizedBox(width: 8),
                Text('Auto', style: hubSans(size: 11, color: tokens.dim)),
                const SizedBox(width: 8),
                MiniToggle(
                  value: session.autoContinue != 0,
                  onChanged: _autoContinueBusy ? null : _toggleAutoContinue,
                ),
              ],
            ],
          ),
          if (session != null) ...[
            const SizedBox(height: 9),
            Row(
              children: [
                StatusChip(status: liveStatus ?? session.status, style: StatusChipStyle.pill),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    session.cwd,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: hubMono(size: 11, color: tokens.dim),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  // ------------------------------------------------------ conversation view --

  TranscriptEntry? _pairedToolResult(String? toolUseId) {
    if (toolUseId == null) return null;
    for (final e in _transcriptEntries) {
      if (e.kind == 'tool_result' && e.toolUseId == toolUseId) return e;
    }
    return null;
  }

  Widget _conversationView(BuildContext context) {
    final tokens = context.tokens;
    final visible = _transcriptEntries.where((e) => e.kind != 'tool_result').toList();
    return Column(
      children: [
        if (_transcriptTruncatedHead)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
            child: Text('older history not loaded', style: hubMono(size: 10, color: tokens.faint)),
          ),
        Expanded(
          child: _transcriptLoading
              ? const Center(child: CircularProgressIndicator())
              : visible.isEmpty
              ? Center(
                  child: Text('No conversation yet', style: hubSans(size: 13, color: tokens.dim)),
                )
              : ListView.builder(
                  controller: _transcriptScrollController,
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                  itemCount: visible.length,
                  itemBuilder: (context, index) => _conversationRow(context, visible[index]),
                ),
        ),
      ],
    );
  }

  Widget _conversationRow(BuildContext context, TranscriptEntry e) {
    switch (e.kind) {
      case 'user':
        return _userRow(context, e);
      case 'assistant':
        return _assistantRow(context, e);
      case 'tool_use':
        return _toolUseRow(context, e);
      default:
        return const SizedBox.shrink();
    }
  }

  Widget _userRow(BuildContext context, TranscriptEntry e) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: SelectableText.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '❯ ',
              style: hubSans(size: 13, weight: FontWeight.w700, color: tokens.accent),
            ),
            TextSpan(
              text: e.text ?? '',
              style: hubSans(size: 13, weight: FontWeight.w600, color: tokens.text, height: 1.4),
            ),
          ],
        ),
      ),
    );
  }

  Widget _assistantRow(BuildContext context, TranscriptEntry e) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: SelectableText(
        e.text ?? '',
        style: hubSans(size: 13, color: tokens.text, height: 1.45),
      ),
    );
  }

  Widget _toolUseRow(BuildContext context, TranscriptEntry e) {
    final tokens = context.tokens;
    final key = e.toolUseId ?? e.uuid ?? e.hashCode.toString();
    final expanded = _expandedToolUseKeys.contains(key);
    final result = _pairedToolResult(e.toolUseId);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: InkWell(
        onTap: () => setState(() {
          if (expanded) {
            _expandedToolUseKeys.remove(key);
          } else {
            _expandedToolUseKeys.add(key);
          }
        }),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '● ${e.toolName ?? 'tool'}: ${_compactToolInput(e.toolInput)}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: hubMono(size: 11.5, color: tokens.dim),
            ),
            if (expanded) ...[
              const SizedBox(height: 5),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
                decoration: BoxDecoration(
                  color: tokens.surface,
                  border: Border.all(color: tokens.border),
                  borderRadius: BorderRadius.circular(kRadiusCard),
                ),
                child: SelectableText(
                  e.toolInput ?? '',
                  style: hubMono(size: 10.5, color: tokens.dim),
                ),
              ),
              if (result?.text != null && result!.text!.isNotEmpty) ...[
                const SizedBox(height: 5),
                SelectableText(
                  result.text!,
                  style: hubMono(size: 10.5, color: tokens.faint),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  // ------------------------------------------------------- fallback view --

  Widget _fallbackEventTimeline(BuildContext context) {
    final tokens = context.tokens;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
          child: Text(
            'showing hook events — transcript unavailable',
            style: hubSans(size: 11, color: tokens.faint),
          ),
        ),
        Expanded(
          child: Stack(
            children: [
              _events.isEmpty
                  ? Center(
                      child: Text('No events yet', style: hubSans(size: 13, color: tokens.dim)),
                    )
                  : ListView.builder(
                      reverse: true,
                      controller: _scrollController,
                      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
                      itemCount: _events.length,
                      itemBuilder: (context, index) => _eventRow(context, _events[index]),
                    ),
              if (_events.isNotEmpty)
                Positioned(
                  right: 14,
                  bottom: 14,
                  child: GestureDetector(
                    onTap: _jumpToNewest,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
                      decoration: BoxDecoration(
                        color: tokens.accent,
                        borderRadius: BorderRadius.circular(999),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withValues(alpha: 0.35),
                            blurRadius: 16,
                            offset: const Offset(0, 6),
                          ),
                        ],
                      ),
                      child: Text(
                        '↑ Newest',
                        style: hubSans(
                          size: 11,
                          weight: FontWeight.w700,
                          color: tokens.accentInk,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _eventRow(BuildContext context, _TimelineEvent e) {
    final tokens = context.tokens;
    final tone = _toneColor(e.type, tokens);
    final summary = e.type == 'Stop' ? null : _humanSummary(e.payload);

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 14,
            child: Column(
              children: [
                const SizedBox(height: 4),
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(color: tone, borderRadius: BorderRadius.circular(3)),
                ),
                const SizedBox(height: 3),
                Expanded(child: Container(width: 2, color: tokens.border)),
              ],
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Expanded(
                        child: Text(
                          e.type,
                          style: hubSans(size: 13, weight: FontWeight.w700, color: tone),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(formatRelativeTime(e.createdAt), style: hubMono(size: 10, color: tokens.faint)),
                    ],
                  ),
                  if (e.type == 'Stop')
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Text('null', style: hubMono(size: 11, color: tokens.faint)),
                    )
                  else if (summary != null) ...[
                    Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
                        decoration: BoxDecoration(
                          color: tokens.surface,
                          border: Border.all(color: tokens.border),
                          borderRadius: BorderRadius.circular(kRadiusCard),
                        ),
                        child: Text(
                          summary,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: hubSans(size: 12, color: tokens.text, height: 1.4),
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        e.payload ?? '',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: hubMono(size: 9.5, color: tokens.faint),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _composer(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 9, 12, 12),
      decoration: BoxDecoration(color: tokens.navBg, border: Border(top: BorderSide(color: tokens.border))),
      child: SafeArea(
        top: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                InkWell(
                  onTap: _attachingImage ? null : _showImageSourceMenu,
                  borderRadius: BorderRadius.circular(kRadiusSend),
                  child: SizedBox(
                    width: 38,
                    height: 38,
                    child: _attachingImage
                        ? Padding(
                            padding: const EdgeInsets.all(10),
                            child: CircularProgressIndicator(strokeWidth: 2, color: tokens.dim),
                          )
                        : Icon(Icons.image_outlined, size: 19, color: tokens.dim),
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: TextField(
                    controller: _promptController,
                    maxLength: 8000,
                    maxLines: 4,
                    minLines: 1,
                    buildCounter: (context, {required currentLength, required isFocused, maxLength}) => null,
                    decoration: const InputDecoration(hintText: 'Prompt'),
                  ),
                ),
                const SizedBox(width: 9),
                AccentSquareButton(
                  size: 38,
                  radius: kRadiusSend,
                  onTap: _sending ? null : _send,
                  child: _sending
                      ? SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: tokens.accentInk),
                        )
                      : Icon(Icons.arrow_forward, size: 17, color: tokens.accentInk),
                ),
              ],
            ),
            const SizedBox(height: 4),
            ValueListenableBuilder<TextEditingValue>(
              valueListenable: _promptController,
              builder: (context, value, _) => Text(
                '${value.text.length}/8000',
                style: hubMono(size: 9.5, color: tokens.faint),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final store = context.watch<HubStore>();
    final session = _session;
    final liveStatus = store.sessions[widget.sessionId]?.status ?? session?.status;
    final terminalLive = session != null && store.attachedCwds.contains(session.cwd);

    return Scaffold(
      body: SafeArea(
        bottom: false, // the prompt bar below has its own SafeArea
        child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _loadError != null
          ? Center(
              child: Text(
                'Failed to load: $_loadError',
                style: hubSans(size: 13, color: tokens.stEnded),
              ),
            )
          : Column(
              children: [
                _header(context, session, liveStatus, terminalLive),
                Expanded(
                  child: _transcriptAvailable
                      ? _conversationView(context)
                      : _fallbackEventTimeline(context),
                ),
                _composer(context),
              ],
            ),
      ),
    );
  }
}
