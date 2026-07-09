import 'dart:async';
import 'dart:convert';

import 'package:cc_hub_mobile/api_client.dart';
import 'package:cc_hub_mobile/connection.dart';
import 'package:cc_hub_mobile/settings.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, {int statusCode = 200}) {
  return http.Response(
    jsonEncode(body),
    statusCode,
    headers: {'content-type': 'application/json'},
  );
}

AppSettings _settings({String? workerUrl}) => AppSettings(
      lanUrl: 'http://lan.local:4270',
      workerUrl: workerUrl,
      token: 'test-token',
    );

void main() {
  group('ConnectionManager.request failover', () {
    test('LAN ok: no flip', () async {
      final client = MockClient((req) async {
        expect(req.url.host, 'lan.local');
        return _json({'status': 'ok'});
      });
      final conn = ConnectionManager(
        _settings(workerUrl: 'http://worker.example'),
        httpClient: client,
        lanTimeout: const Duration(milliseconds: 200),
        relayTimeout: const Duration(milliseconds: 200),
      );

      final result = await conn.request('GET', '/health');

      expect(result['status'], 'ok');
      expect(conn.activeIndex, 0);
      expect(conn.activeBaseIsRelay, isFalse);
    });

    test('LAN timeout: flips to worker, retries once, sticky', () async {
      var lanCalls = 0;
      var workerCalls = 0;
      final client = MockClient((req) async {
        if (req.url.host == 'lan.local') {
          lanCalls++;
          return Completer<http.Response>().future; // never resolves -> timeout
        }
        workerCalls++;
        return _json({'status': 'ok'});
      });
      final conn = ConnectionManager(
        _settings(workerUrl: 'http://worker.example'),
        httpClient: client,
        lanTimeout: const Duration(milliseconds: 30),
        relayTimeout: const Duration(milliseconds: 500),
      );

      final result = await conn.request('GET', '/health');

      expect(result['status'], 'ok');
      expect(lanCalls, 1);
      expect(workerCalls, 1);
      expect(conn.activeIndex, 1);
      expect(conn.activeBaseIsRelay, isTrue);

      // Sticky: the next call goes straight to the worker, no LAN attempt.
      final second = await conn.request('GET', '/health');
      expect(second['status'], 'ok');
      expect(lanCalls, 1);
      expect(workerCalls, 2);
    });

    test('LAN 503 hub_offline: flips to worker', () async {
      final client = MockClient((req) async {
        if (req.url.host == 'lan.local') {
          return _json({
            'error': {'code': 'hub_offline', 'message': 'no hub'},
          }, statusCode: 503);
        }
        return _json({'status': 'ok'});
      });
      final conn = ConnectionManager(
        _settings(workerUrl: 'http://worker.example'),
        httpClient: client,
        lanTimeout: const Duration(milliseconds: 200),
        relayTimeout: const Duration(milliseconds: 200),
      );

      final result = await conn.request('GET', '/health');

      expect(result['status'], 'ok');
      expect(conn.activeIndex, 1);
    });

    test('401: throws AuthException, never flips', () async {
      var workerCalls = 0;
      final client = MockClient((req) async {
        if (req.url.host == 'worker.example') workerCalls++;
        return _json({
          'error': {'code': 'unauthorized', 'message': 'bad token'},
        }, statusCode: 401);
      });
      final conn = ConnectionManager(
        _settings(workerUrl: 'http://worker.example'),
        httpClient: client,
        lanTimeout: const Duration(milliseconds: 200),
        relayTimeout: const Duration(milliseconds: 200),
      );

      await expectLater(conn.request('GET', '/health'), throwsA(isA<AuthException>()));
      expect(workerCalls, 0);
      expect(conn.activeIndex, 0);
    });

    test('both bases fail: rethrows', () async {
      final client = MockClient((req) async {
        return _json({
          'error': {'code': 'hub_offline', 'message': 'down'},
        }, statusCode: 503);
      });
      final conn = ConnectionManager(
        _settings(workerUrl: 'http://worker.example'),
        httpClient: client,
        lanTimeout: const Duration(milliseconds: 200),
        relayTimeout: const Duration(milliseconds: 200),
      );

      await expectLater(conn.request('GET', '/health'), throwsA(isA<ApiException>()));
    });

    test('no worker configured: single attempt rethrows', () async {
      var calls = 0;
      final client = MockClient((req) async {
        calls++;
        return _json({
          'error': {'code': 'boom', 'message': 'kaboom'},
        }, statusCode: 500);
      });
      final conn = ConnectionManager(
        _settings(),
        httpClient: client,
        lanTimeout: const Duration(milliseconds: 200),
      );

      await expectLater(conn.request('GET', '/health'), throwsA(isA<ApiException>()));
      expect(calls, 1);
    });

    test('ApiException carries the parsed error envelope', () async {
      final client = MockClient((req) async {
        return _json({
          'error': {'code': 'not_found', 'message': 'no such session'},
        }, statusCode: 404);
      });
      final conn = ConnectionManager(
        _settings(),
        httpClient: client,
        lanTimeout: const Duration(milliseconds: 200),
      );

      try {
        await conn.request('GET', '/sessions/xyz');
        fail('expected ApiException');
      } on ApiException catch (e) {
        expect(e.code, 'not_found');
        expect(e.message, 'no such session');
      }
    });
  });

  group('ApiClient parsing', () {
    test('listSessions parses SessionJoined rows', () async {
      final client = MockClient((req) async {
        expect(req.url.path, '/api/v1/sessions');
        return _json({
          'sessions': [
            {
              'id': 'abc',
              'instance_id': 1,
              'cwd': '/proj',
              'status': 'idle',
              'started_at': 1000,
              'last_event_at': 2000,
              'auto_continue': 1,
              'continues_today': 0,
              'instance_name': 'proj',
            },
          ],
        });
      });
      final api = ApiClient(ConnectionManager(_settings(), httpClient: client));

      final sessions = await api.listSessions();

      expect(sessions, hasLength(1));
      expect(sessions.first.id, 'abc');
      expect(sessions.first.instanceName, 'proj');
      expect(sessions.first.autoContinue, 1);
    });

    test('decidePermission posts the behavior and parses the returned permission', () async {
      final client = MockClient((req) async {
        expect(req.method, 'POST');
        expect(req.url.path, '/api/v1/permissions/5/decision');
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        expect(body['behavior'], 'allow');
        return _json({
          'permission': {
            'id': 5,
            'session_id': 'abc',
            'tool_name': 'Bash',
            'status': 'allowed',
            'created_at': 1000,
          },
        });
      });
      final api = ApiClient(ConnectionManager(_settings(), httpClient: client));

      final perm = await api.decidePermission(5, 'allow');

      expect(perm.status, 'allowed');
      expect(perm.toolName, 'Bash');
    });
  });
}
