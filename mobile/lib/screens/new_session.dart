import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../theme.dart';

class NewSessionScreen extends StatefulWidget {
  const NewSessionScreen({super.key});

  @override
  State<NewSessionScreen> createState() => _NewSessionScreenState();
}

class _NewSessionScreenState extends State<NewSessionScreen> {
  final _cwdController = TextEditingController();
  final _promptController = TextEditingController();
  String? _permissionMode;
  bool _submitting = false;

  Future<void> _submit() async {
    final cwd = _cwdController.text.trim();
    final prompt = _promptController.text.trim();
    if (cwd.isEmpty || prompt.isEmpty || _submitting) return;
    setState(() => _submitting = true);
    try {
      await context.read<ApiClient>().newSession(cwd, prompt, permissionMode: _permissionMode);
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Session starting — it will appear in the list shortly')),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      showErrorSnack(context, e.statusCode == 409 ? 'Runner at capacity, try later' : e.message);
    } catch (e) {
      if (!mounted) return;
      showErrorSnack(context, '$e');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  void dispose() {
    _cwdController.dispose();
    _promptController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('New Session')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _cwdController,
                decoration: const InputDecoration(
                  labelText: 'Working directory (absolute path on hub machine)',
                  hintText: '/home/user/project',
                ),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _promptController,
                decoration: const InputDecoration(labelText: 'Prompt'),
                maxLines: 6,
                minLines: 3,
              ),
              const SizedBox(height: 16),
              DropdownButtonFormField<String?>(
                initialValue: _permissionMode,
                decoration: const InputDecoration(labelText: 'Permission mode'),
                items: const [
                  DropdownMenuItem(value: null, child: Text('default')),
                  DropdownMenuItem(value: 'acceptEdits', child: Text('acceptEdits')),
                  DropdownMenuItem(value: 'plan', child: Text('plan')),
                  DropdownMenuItem(value: 'bypassPermissions', child: Text('bypassPermissions')),
                ],
                onChanged: (value) => setState(() => _permissionMode = value),
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _submitting ? null : _submit,
                child: _submitting
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Start'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
