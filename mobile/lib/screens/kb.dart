import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/accent_square_button.dart';

class KbScreen extends StatefulWidget {
  const KbScreen({super.key});

  @override
  State<KbScreen> createState() => _KbScreenState();
}

class _KbScreenState extends State<KbScreen> {
  final _searchController = TextEditingController();
  List<KbSearchResult> _results = [];
  bool _searched = false;
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
      setState(() {
        _results = results;
        _searched = true;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e is ApiException ? e.message : '$e');
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _openNote(int id) async {
    try {
      final note = await context.read<ApiClient>().kbGet(id);
      if (!mounted) return;
      final tokens = context.tokens;
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        backgroundColor: tokens.surface,
        builder: (context) => DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.6,
          builder: (context, scrollController) => Padding(
            padding: const EdgeInsets.all(16),
            child: ListView(
              controller: scrollController,
              children: [
                Text(
                  note.title,
                  style: hubSans(size: 16, weight: FontWeight.w700, color: tokens.text),
                ),
                if (note.tags.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text(note.tags, style: hubMono(size: 10, color: tokens.faint)),
                  ),
                const SizedBox(height: 8),
                SelectableText(note.body, style: hubSans(size: 13, color: tokens.text, height: 1.4)),
              ],
            ),
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      showErrorSnack(context, e is ApiException ? e.message : '$e');
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
              const SizedBox(height: 12),
              TextField(
                controller: bodyController,
                decoration: const InputDecoration(labelText: 'Body'),
                maxLines: 5,
              ),
              const SizedBox(height: 12),
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
              } catch (e) {
                if (dialogContext.mounted) {
                  showErrorSnack(dialogContext, e is ApiException ? e.message : '$e');
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

  Widget _card(BuildContext context, KbSearchResult r) {
    final tokens = context.tokens;
    final tag = r.tags.split(',').map((t) => t.trim()).firstWhere((t) => t.isNotEmpty, orElse: () => '');
    return InkWell(
      onTap: () => _openNote(r.id),
      borderRadius: BorderRadius.circular(kRadiusCard),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: tokens.surface,
          border: Border.all(color: tokens.border),
          borderRadius: BorderRadius.circular(kRadiusCard),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    r.title,
                    style: hubSans(size: 13.5, weight: FontWeight.w600, color: tokens.text),
                  ),
                ),
                if (tag.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: tokens.surface2,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      tag.toUpperCase(),
                      style: hubMono(
                        size: 9,
                        weight: FontWeight.w600,
                        color: tokens.accent,
                        letterSpacing: 0.54,
                      ),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 5),
            Text(
              r.snippet,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: hubSans(size: 11.5, color: tokens.dim, height: 1.4),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final subtitle = !_searched
        ? 'Search notes across your projects'
        : '${_results.length} result${_results.length == 1 ? '' : 's'}';

    return Scaffold(
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Knowledge Base',
                  style: hubSans(
                    size: 19,
                    weight: FontWeight.w700,
                    color: tokens.text,
                    letterSpacing: -0.19,
                  ),
                ),
                const SizedBox(height: 2),
                Text(subtitle, style: hubSans(size: 12, color: tokens.dim)),
                const SizedBox(height: 11),
                TextField(
                  controller: _searchController,
                  style: hubSans(size: 12.5, color: tokens.text),
                  decoration: InputDecoration(
                    hintText: 'Search knowledge base',
                    prefixIcon: Icon(Icons.search, size: 18, color: tokens.dim),
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
              ],
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Text(_error!, style: hubSans(size: 12, color: tokens.stEnded)),
            ),
          Expanded(
            child: _results.isEmpty
                ? Center(
                    child: Text(
                      _searched ? 'No notes found' : 'Search to find notes',
                      style: hubSans(size: 13, color: tokens.dim),
                    ),
                  )
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(14, 11, 14, 14),
                    itemCount: _results.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 9),
                    itemBuilder: (context, index) => _card(context, _results[index]),
                  ),
          ),
        ],
      ),
      floatingActionButton: AccentSquareButton(
        size: 52,
        radius: kRadiusFab,
        onTap: _addNote,
        shadow: [
          BoxShadow(
            color: tokens.accent.withValues(alpha: 0.55),
            blurRadius: 22,
            spreadRadius: -6,
            offset: const Offset(0, 8),
          ),
        ],
        child: Icon(Icons.add, size: 22, color: tokens.accentInk),
      ),
    );
  }
}
