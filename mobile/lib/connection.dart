import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'settings.dart';

enum WsStatus { connecting, up, down }

/// Non-2xx response with a parsed `{error:{code,message}}` envelope.
/// [statusCode] is the HTTP status (e.g. 409, 400) so callers can branch on
/// it without string-matching [code], which is the server's own error code.
class ApiException implements Exception {
  final String code;
  final String message;
  final int? statusCode;

  ApiException(this.code, this.message, {this.statusCode});

  @override
  String toString() => 'ApiException($code): $message';
}

/// 401 response. Never triggers LAN/relay failover — a bad token is bad on
/// either base.
class AuthException implements Exception {
  final String message;

  AuthException([this.message = 'Unauthorized']);

  @override
  String toString() => 'AuthException: $message';
}

/// Converts an http(s) base URL into the `/ws` URL the hub (or relay) expects,
/// with the bearer token as a query parameter.
String wsUrlFor(String base, String token) {
  var trimmed = base.trim();
  if (trimmed.endsWith('/')) {
    trimmed = trimmed.substring(0, trimmed.length - 1);
  }
  final uri = Uri.parse(trimmed);
  final scheme = uri.scheme == 'https' ? 'wss' : 'ws';
  return uri
      .replace(scheme: scheme, path: '/ws', queryParameters: {'token': token})
      .toString();
}

const List<int> _backoffScheduleMs = [1000, 2000, 4000, 8000, 16000, 30000];

/// WS reconnect backoff: 1s,2s,4s,8s,16s, capped at 30s. [attempt] is 0-based.
int nextBackoffMs(int attempt) {
  final idx = attempt < 0
      ? 0
      : (attempt >= _backoffScheduleMs.length ? _backoffScheduleMs.length - 1 : attempt);
  return _backoffScheduleMs[idx];
}

/// Whether a failed REST attempt should fail over to the other configured
/// base (LAN <-> relay worker).
bool shouldFailover({
  required bool isTransportError,
  int? statusCode,
  String? errorCode,
}) {
  if (isTransportError) return true;
  return statusCode == 503 && errorCode == 'hub_offline';
}

class _AttemptResult {
  final bool ok;
  final dynamic value;
  final bool isTransportError;
  final bool isAuthError;
  final int? statusCode;
  final String? errorCode;
  final String? message;

  const _AttemptResult._({
    required this.ok,
    this.value,
    this.isTransportError = false,
    this.isAuthError = false,
    this.statusCode,
    this.errorCode,
    this.message,
  });

  factory _AttemptResult.success(dynamic value) => _AttemptResult._(ok: true, value: value);

  factory _AttemptResult.failure({
    bool isTransportError = false,
    bool isAuthError = false,
    int? statusCode,
    String? errorCode,
    String? message,
  }) =>
      _AttemptResult._(
        ok: false,
        isTransportError: isTransportError,
        isAuthError: isAuthError,
        statusCode: statusCode,
        errorCode: errorCode,
        message: message,
      );
}

/// Owns REST access (with LAN/relay failover) and the live `/ws` connection.
///
/// Bases are tried in order [lanUrl, workerUrl?]. A failed REST call fails
/// over to the other base and, on success there, stays put (sticky) rather
/// than reverting next call. The WS connection independently reconnects with
/// backoff and can alternate bases too; whichever proves live last "wins"
/// [activeIndex] since a live WS is the best liveness signal available.
class ConnectionManager extends ChangeNotifier {
  final AppSettings settings;
  final List<String> bases;
  final Duration lanTimeout;
  final Duration relayTimeout;
  final http.Client _client;

  int _activeIndex = 0;
  WsStatus _wsStatus = WsStatus.down;

  WebSocketChannel? _ws;
  int _wsGeneration = 0;
  int _wsBaseIndex = 0;
  Timer? _pingTimer;
  Timer? _watchdogTimer;
  Timer? _reconnectTimer;
  int _reconnectAttempt = 0;
  int _consecutiveFailuresOnBase = 0;
  bool _alternating = false;
  bool _wsClosing = true; // until connectWs() is called
  DateTime? _lastInboundFrameAt;

  /// Every decoded WS frame (`{type, data}`), including `hello`/`pong`.
  void Function(Map<String, dynamic> frame)? onFrame;

  /// Fired after a `hello` frame — hub does not include permissions in
  /// `hello`, so callers refetch them here.
  void Function()? onWsConnected;

  ConnectionManager(
    this.settings, {
    http.Client? httpClient,
    this.lanTimeout = const Duration(seconds: 8),
    this.relayTimeout = const Duration(seconds: 35),
  })  : _client = httpClient ?? http.Client(),
        bases = [
          settings.lanUrl,
          if (settings.workerUrl != null && settings.workerUrl!.trim().isNotEmpty)
            settings.workerUrl!,
        ];

  int get activeIndex => _activeIndex;
  bool get activeBaseIsRelay => _activeIndex > 0;
  WsStatus get wsStatus => _wsStatus;

  /// Resets REST attempts to try LAN first again (app resume / pull-to-refresh).
  void preferLan() {
    if (_activeIndex != 0) {
      _activeIndex = 0;
      notifyListeners();
    }
  }

  // ---------------------------------------------------------------- REST --

  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Object? jsonBody,
    Map<String, String>? query,
  }) async {
    final first = await _attempt(_activeIndex, method, path, jsonBody, query);
    if (first.ok) return (first.value as Map<String, dynamic>?) ?? {};
    if (first.isAuthError) throw AuthException(first.message ?? 'Unauthorized');

    final canFailover = bases.length > 1 &&
        shouldFailover(
          isTransportError: first.isTransportError,
          statusCode: first.statusCode,
          errorCode: first.errorCode,
        );
    if (!canFailover) {
      throw ApiException(
        first.errorCode ?? 'request_failed',
        first.message ?? 'Request failed',
        statusCode: first.statusCode,
      );
    }

    final otherIndex = _activeIndex == 0 ? 1 : 0;
    final second = await _attempt(otherIndex, method, path, jsonBody, query);
    if (second.ok) {
      if (_activeIndex != otherIndex) {
        _activeIndex = otherIndex;
        notifyListeners();
      }
      return (second.value as Map<String, dynamic>?) ?? {};
    }
    if (second.isAuthError) throw AuthException(second.message ?? 'Unauthorized');
    throw ApiException(
      second.errorCode ?? 'request_failed',
      second.message ?? 'Request failed',
      statusCode: second.statusCode,
    );
  }

  Future<_AttemptResult> _attempt(
    int baseIndex,
    String method,
    String path,
    Object? jsonBody,
    Map<String, String>? query,
  ) async {
    final isRelay = baseIndex > 0;
    final timeout = isRelay ? relayTimeout : lanTimeout;
    final uri = _buildUri(bases[baseIndex], path, query);
    final headers = <String, String>{
      'Authorization': 'Bearer ${settings.token}',
      'Content-Type': 'application/json',
    };
    final body = jsonBody != null ? jsonEncode(jsonBody) : null;

    http.Response response;
    try {
      response = await _rawSend(method, uri, headers, body).timeout(timeout);
    } on TimeoutException {
      return _AttemptResult.failure(isTransportError: true, message: 'Timed out');
    } on SocketException catch (e) {
      return _AttemptResult.failure(isTransportError: true, message: e.message);
    } on http.ClientException catch (e) {
      return _AttemptResult.failure(isTransportError: true, message: e.message);
    }

    if (response.statusCode == 401) {
      return _AttemptResult.failure(isAuthError: true, statusCode: 401, message: 'Unauthorized');
    }

    Map<String, dynamic>? parsed;
    if (response.body.isNotEmpty) {
      try {
        final decoded = jsonDecode(response.body);
        if (decoded is Map<String, dynamic>) parsed = decoded;
      } catch (_) {
        parsed = null;
      }
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return _AttemptResult.success(parsed ?? <String, dynamic>{});
    }

    final errorObj = parsed?['error'];
    final errorCode = errorObj is Map ? errorObj['code'] as String? : null;
    final errorMessage = errorObj is Map
        ? (errorObj['message'] as String? ?? 'Request failed (${response.statusCode})')
        : 'Request failed (${response.statusCode})';

    return _AttemptResult.failure(
      statusCode: response.statusCode,
      errorCode: errorCode,
      message: errorMessage,
    );
  }

  Future<http.Response> _rawSend(
    String method,
    Uri uri,
    Map<String, String> headers,
    String? body,
  ) async {
    final req = http.Request(method, uri)..headers.addAll(headers);
    if (body != null) req.body = body;
    final streamed = await _client.send(req);
    return http.Response.fromStream(streamed);
  }

  Uri _buildUri(String base, String path, Map<String, String>? query) {
    var trimmed = base.trim();
    if (trimmed.endsWith('/')) {
      trimmed = trimmed.substring(0, trimmed.length - 1);
    }
    return Uri.parse(trimmed).replace(
      path: '/api/v1$path',
      queryParameters: (query != null && query.isNotEmpty) ? query : null,
    );
  }

  // ------------------------------------------------------------------ WS --

  void connectWs() {
    _wsClosing = false;
    _reconnectTimer?.cancel();
    _openWs(_activeIndex);
  }

  void disposeWs() {
    _wsClosing = true;
    _wsGeneration++; // invalidate any in-flight listeners
    _reconnectTimer?.cancel();
    _pingTimer?.cancel();
    _watchdogTimer?.cancel();
    _ws?.sink.close();
    _ws = null;
    if (_wsStatus != WsStatus.down) {
      _wsStatus = WsStatus.down;
      notifyListeners();
    }
  }

  void _openWs(int baseIndex) {
    final generation = ++_wsGeneration;
    _wsBaseIndex = baseIndex;
    _wsStatus = WsStatus.connecting;
    notifyListeners();

    final WebSocketChannel channel;
    try {
      channel = WebSocketChannel.connect(Uri.parse(wsUrlFor(bases[baseIndex], settings.token)));
    } catch (_) {
      _scheduleReconnect(baseIndex, closeCode: null);
      return;
    }
    _ws = channel;
    unawaited(channel.ready.catchError((Object _) {
      // Failure also surfaces via the stream's onError/onDone; swallowing here
      // only prevents an unhandled async exception.
    }));
    _lastInboundFrameAt = DateTime.now(); // start the dead-man window now

    channel.stream.listen(
      (data) {
        if (generation != _wsGeneration) return;
        _handleWsData(baseIndex, data);
      },
      onDone: () {
        if (generation != _wsGeneration) return;
        _handleWsClosed(baseIndex, channel.closeCode);
      },
      onError: (_) {
        if (generation != _wsGeneration) return;
        _handleWsClosed(baseIndex, channel.closeCode);
      },
      cancelOnError: true,
    );

    _startTimers(channel, generation);
  }

  void _startTimers(WebSocketChannel channel, int generation) {
    _pingTimer?.cancel();
    _pingTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      if (generation != _wsGeneration) return;
      try {
        channel.sink.add(jsonEncode({'type': 'ping'}));
      } catch (_) {
        // Best-effort; the watchdog below catches a truly dead connection.
      }
    });

    _watchdogTimer?.cancel();
    _watchdogTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (generation != _wsGeneration) return;
      final last = _lastInboundFrameAt;
      if (last != null && DateTime.now().difference(last) > const Duration(seconds: 35)) {
        _wsGeneration++; // invalidate this socket's own callbacks first
        channel.sink.close();
        _handleWsClosed(_wsBaseIndex, null);
      }
    });
  }

  void _handleWsData(int baseIndex, dynamic data) {
    _lastInboundFrameAt = DateTime.now(); // any frame counts, including pong

    if (_wsStatus != WsStatus.up) {
      _wsStatus = WsStatus.up;
      _reconnectAttempt = 0;
      _consecutiveFailuresOnBase = 0;
      _alternating = false;
      if (_activeIndex != baseIndex) {
        _activeIndex = baseIndex; // WS is the best liveness signal
      }
      notifyListeners();
    }

    Map<String, dynamic>? frame;
    try {
      final decoded = jsonDecode(data as String);
      if (decoded is Map<String, dynamic>) frame = decoded;
    } catch (_) {
      return;
    }
    if (frame == null) return;

    onFrame?.call(frame);
    if (frame['type'] == 'hello') {
      onWsConnected?.call();
    }
  }

  void _handleWsClosed(int baseIndex, int? closeCode) {
    _pingTimer?.cancel();
    _watchdogTimer?.cancel();
    _ws = null;
    if (_wsStatus != WsStatus.down) {
      _wsStatus = WsStatus.down;
      notifyListeners();
    }
    if (_wsClosing) return;
    _scheduleReconnect(baseIndex, closeCode: closeCode);
  }

  void _scheduleReconnect(int baseIndex, {int? closeCode}) {
    var nextBaseIndex = baseIndex;
    int delayMs;

    if (closeCode == 1012) {
      // Hub reconnected to the relay: immediate reconnect, same base, no backoff.
      _reconnectAttempt = 0;
      _consecutiveFailuresOnBase = 0;
      _alternating = false;
      delayMs = 0;
    } else {
      if (_alternating && bases.length > 1) {
        nextBaseIndex = baseIndex == 0 ? 1 : 0;
      } else {
        _consecutiveFailuresOnBase++;
        if (_consecutiveFailuresOnBase >= 2 && bases.length > 1) {
          _alternating = true;
          nextBaseIndex = baseIndex == 0 ? 1 : 0;
        }
      }
      delayMs = nextBackoffMs(_reconnectAttempt);
      _reconnectAttempt++;
    }

    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      if (_wsClosing) return;
      _openWs(nextBaseIndex);
    });
  }

  @override
  void dispose() {
    disposeWs();
    _client.close();
    super.dispose();
  }
}
