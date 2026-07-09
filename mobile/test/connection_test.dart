import 'package:cc_hub_mobile/connection.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('wsUrlFor', () {
    test('converts http to ws and appends /ws?token=', () {
      expect(
        wsUrlFor('http://192.168.1.10:4270', 'secret'),
        'ws://192.168.1.10:4270/ws?token=secret',
      );
    });

    test('converts https to wss', () {
      expect(
        wsUrlFor('https://relay.example.workers.dev', 'tok'),
        'wss://relay.example.workers.dev/ws?token=tok',
      );
    });

    test('strips a trailing slash on the base', () {
      expect(wsUrlFor('http://host:4270/', 'tok'), 'ws://host:4270/ws?token=tok');
    });

    test('percent-encodes the token', () {
      final uri = Uri.parse(wsUrlFor('http://host:4270', 'a b&c'));
      expect(uri.queryParameters['token'], 'a b&c');
    });
  });

  group('nextBackoffMs', () {
    test('follows the 1,2,4,8,16,30s schedule', () {
      expect(nextBackoffMs(0), 1000);
      expect(nextBackoffMs(1), 2000);
      expect(nextBackoffMs(2), 4000);
      expect(nextBackoffMs(3), 8000);
      expect(nextBackoffMs(4), 16000);
      expect(nextBackoffMs(5), 30000);
    });

    test('caps at 30s for attempts beyond the schedule', () {
      expect(nextBackoffMs(6), 30000);
      expect(nextBackoffMs(100), 30000);
    });

    test('treats a negative attempt as the first step', () {
      expect(nextBackoffMs(-1), 1000);
    });
  });

  group('shouldFailover', () {
    test('any transport error triggers failover', () {
      expect(shouldFailover(isTransportError: true), isTrue);
    });

    test('503 hub_offline triggers failover', () {
      expect(
        shouldFailover(isTransportError: false, statusCode: 503, errorCode: 'hub_offline'),
        isTrue,
      );
    });

    test('503 with a different error code does not fail over', () {
      expect(
        shouldFailover(isTransportError: false, statusCode: 503, errorCode: 'some_other_code'),
        isFalse,
      );
    });

    test('401 does not fail over', () {
      expect(shouldFailover(isTransportError: false, statusCode: 401), isFalse);
    });

    test('a generic 500 does not fail over', () {
      expect(
        shouldFailover(isTransportError: false, statusCode: 500, errorCode: 'internal'),
        isFalse,
      );
    });
  });
}
