import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';

class KbScreen extends StatefulWidget {
  const KbScreen({super.key});

  @override
  State<KbScreen> createState() => _KbScreenState();
}

class _KbScreenState extends State<KbScreen> {
  final _searchController = TextEditingController();
  List<KbSearchResult> _results = [];
  bool _searching = false;
  String? _error;

  Future<void> _search(String query) async {
    final q = query.trim();
    if (q.isEmpty) return;
    setState(() {
      _searching = true;
      _error = null;
    });
    try {
      final results = await context.read<ApiClient>().kbSearch(q);
      if (!mounted) return;
      setState(() => _results = results);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _openNote(int id) async {
    try {
      final note = await context.read<ApiClient>().kbGet(id);
      if (!mounted) return;
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (context) => DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.6,
          builder: (context, scrollController) => Padding(
            padding: const EdgeInsets.all(16),
            child: ListView(
              controller: scrollController,
              children: [
                Text(note.title, style: Theme.of(context).textTheme.titleLarge),
                if (note.tags.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text(note.tags, style: Theme.of(context).textTheme.bodySmall),
                  ),
                const SizedBox(height: 8),
                SelectableText(note.body),
              ],
            ),
          ),
        ),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _addNote() async {
    final titleController = TextEditingController();
    final bodyController = TextEditingController();
    final tagsController = TextEditingController();

    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Add note'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: titleController,
                decoration: const InputDecoration(labelText: 'Title'),
              ),
              TextField(
                controller: bodyController,
                decoration: const InputDecoration(labelText: 'Body'),
                maxLines: 5,
              ),
              TextField(
                controller: tagsController,
                decoration: const InputDecoration(labelText: 'Tags (optional)'),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () async {
              if (titleController.text.trim().isEmpty || bodyController.text.trim().isEmpty) {
                return;
              }
              try {
                await dialogContext.read<ApiClient>().kbAdd(
                  titleController.text.trim(),
                  bodyController.text.trim(),
                  tags: tagsController.text.trim().isEmpty ? null : tagsController.text.trim(),
                );
                if (dialogContext.mounted) Navigator.of(dialogContext).pop(true);
              } on ApiException catch (e) {
                if (dialogContext.mounted) {
                  ScaffoldMessenger.of(
                    dialogContext,
                  ).showSnackBar(SnackBar(content: Text(e.message)));
                }
              }
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );

    titleController.dispose();
    bodyController.dispose();
    tagsController.dispose();

    if (saved == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('saved')));
    }
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(8),
            child: TextField(
              controller: _searchController,
              decoration: InputDecoration(
                hintText: 'Search knowledge base',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _searching
                    ? const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : null,
              ),
              onSubmitted: _search,
            ),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.all(8), child: Text(_error!)),
          Expanded(
            child: _results.isEmpty
                ? const Center(child: Text('Search to find notes'))
                : ListView.builder(
                    itemCount: _results.length,
                    itemBuilder: (context, index) {
                      final r = _results[index];
                      return ListTile(
                        title: Text(r.title),
                        subtitle: Text(r.snippet, maxLines: 2, overflow: TextOverflow.ellipsis),
                        trailing: r.tags.isEmpty
                            ? null
                            : Text(r.tags, style: Theme.of(context).textTheme.bodySmall),
                        onTap: () => _openNote(r.id),
                      );
                    },
                  ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(onPressed: _addNote, child: const Icon(Icons.add)),
    );
  }
}
