import 'package:flutter/material.dart';

import '../restart_widget.dart';
import '../settings.dart';

/// First-run (and re-visitable, from Settings) screen to configure how the
/// app reaches the cc_hub server: LAN URL, optional Cloudflare Worker relay
/// URL, and the bearer token.
class SetupScreen extends StatefulWidget {
  final AppSettings? initial;

  const SetupScreen({super.key, this.initial});

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _lanUrlController;
  late final TextEditingController _workerUrlController;
  late final TextEditingController _tokenController;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _lanUrlController = TextEditingController(text: widget.initial?.lanUrl ?? '');
    _workerUrlController = TextEditingController(text: widget.initial?.workerUrl ?? '');
    _tokenController = TextEditingController(text: widget.initial?.token ?? '');
  }

  @override
  void dispose() {
    _lanUrlController.dispose();
    _workerUrlController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    final settings = AppSettings(
      lanUrl: _lanUrlController.text.trim(),
      workerUrl: _workerUrlController.text.trim().isEmpty
          ? null
          : _workerUrlController.text.trim(),
      token: _tokenController.text.trim(),
    );
    await settings.save();
    if (!mounted) return;
    // Full restart so a fresh ConnectionManager/ApiClient/HubStore get built
    // from the new settings, rather than patching the running ones.
    RestartWidget.restartApp(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('cc_hub Setup')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextFormField(
                  controller: _lanUrlController,
                  decoration: const InputDecoration(
                    labelText: 'LAN URL',
                    hintText: 'http://192.168.1.10:4270',
                  ),
                  keyboardType: TextInputType.url,
                  validator: (value) =>
                      (value == null || value.trim().isEmpty) ? 'Required' : null,
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _workerUrlController,
                  decoration: const InputDecoration(
                    labelText: 'Worker URL (optional)',
                    hintText: 'https://your-relay.workers.dev',
                  ),
                  keyboardType: TextInputType.url,
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _tokenController,
                  decoration: const InputDecoration(labelText: 'Token'),
                  obscureText: true,
                  validator: (value) =>
                      (value == null || value.trim().isEmpty) ? 'Required' : null,
                ),
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: _saving
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Save'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
