import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'api_client.dart';
import 'connection.dart';
import 'restart_widget.dart';
import 'screens/home.dart';
import 'screens/setup.dart';
import 'settings.dart';
import 'store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const RestartWidget(child: CcHubApp()));
}

class CcHubApp extends StatelessWidget {
  const CcHubApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'cc_hub',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
        useMaterial3: true,
      ),
      home: const AppRoot(),
    );
  }
}

/// Loads persisted settings once per (re)start and decides between
/// [SetupScreen] and a fully wired [HomeScreen].
class AppRoot extends StatefulWidget {
  const AppRoot({super.key});

  @override
  State<AppRoot> createState() => _AppRootState();
}

class _AppRootState extends State<AppRoot> {
  late final Future<AppSettings?> _settingsFuture;

  @override
  void initState() {
    super.initState();
    _settingsFuture = AppSettings.load();
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<AppSettings?>(
      future: _settingsFuture,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        final settings = snapshot.data;
        if (settings == null) {
          return const SetupScreen();
        }
        return _HubServicesRoot(settings: settings);
      },
    );
  }
}

/// Owns the ConnectionManager/ApiClient/HubStore for one set of AppSettings
/// and provides them to the widget tree below. [RestartWidget] is what
/// produces a fresh instance after Setup saves.
class _HubServicesRoot extends StatefulWidget {
  final AppSettings settings;

  const _HubServicesRoot({required this.settings});

  @override
  State<_HubServicesRoot> createState() => _HubServicesRootState();
}

class _HubServicesRootState extends State<_HubServicesRoot> with WidgetsBindingObserver {
  late final ConnectionManager _connection;
  late final ApiClient _api;
  late final HubStore _store;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _connection = ConnectionManager(widget.settings);
    _api = ApiClient(_connection);
    _store = HubStore()..refreshSessions = _api.listSessions;
    _connection.onFrame = _store.applyFrame;
    _connection.onWsConnected = _refreshPending;
    _connection.connectWs();
  }

  Future<void> _refreshPending() async {
    try {
      _store.setPending(await _api.pendingPermissions());
    } catch (_) {
      // Best-effort; the next WS connect (or a manual refresh) retries.
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    _connection.preferLan();
    if (_connection.wsStatus == WsStatus.down) {
      _connection.connectWs();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _connection.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<ConnectionManager>.value(value: _connection),
        Provider<ApiClient>.value(value: _api),
        ChangeNotifierProvider<HubStore>.value(value: _store),
      ],
      child: const HomeScreen(),
    );
  }
}
