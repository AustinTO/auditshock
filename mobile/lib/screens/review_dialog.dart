import 'package:flutter/material.dart';

Future<bool> showReviewDialog(
  BuildContext context, {
  required String title,
  required String instruction,
  required Map<String, String> fields,
  required Map<String, String> initial,
  Map<String, bool> checks = const {},
  Map<String, Map<String, String>> choices = const {},
  required Future<void> Function(Map<String, String>, Map<String, bool>) save,
}) async {
  final controllers = {
    for (final entry in fields.entries)
      entry.key: TextEditingController(text: initial[entry.key] ?? ''),
  };
  final values = Map<String, bool>.from(checks);
  bool busy = false;
  String? error;
  try {
    return await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (dialogContext) => StatefulBuilder(
            builder: (context, setState) => PopScope(
              canPop: !busy,
              child: AlertDialog(
                title: Text(title),
                content: SizedBox(
                  width: 480,
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(instruction),
                        const SizedBox(height: 16),
                        ...fields.entries.map(
                          (entry) => Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: choices.containsKey(entry.key)
                                ? DropdownButtonFormField<String>(
                                    initialValue:
                                        choices[entry.key]!.containsKey(
                                          controllers[entry.key]!.text,
                                        )
                                        ? controllers[entry.key]!.text
                                        : null,
                                    isExpanded: true,
                                    decoration: InputDecoration(
                                      labelText: entry.value,
                                    ),
                                    items: choices[entry.key]!.entries
                                        .map(
                                          (option) => DropdownMenuItem(
                                            value: option.key,
                                            child: Text(option.value),
                                          ),
                                        )
                                        .toList(),
                                    onChanged: busy
                                        ? null
                                        : (value) =>
                                              controllers[entry.key]!.text =
                                                  value ?? '',
                                  )
                                : TextField(
                                    controller: controllers[entry.key],
                                    enabled: !busy,
                                    decoration: InputDecoration(
                                      labelText: entry.value,
                                    ),
                                  ),
                          ),
                        ),
                        ...values.keys.map(
                          (key) => CheckboxListTile(
                            title: Text(key),
                            value: values[key],
                            onChanged: busy
                                ? null
                                : (value) => setState(
                                    () => values[key] = value ?? false,
                                  ),
                          ),
                        ),
                        if (error != null)
                          Text(
                            error!,
                            style: const TextStyle(color: Colors.red),
                          ),
                      ],
                    ),
                  ),
                ),
                actions: [
                  TextButton(
                    onPressed: busy
                        ? null
                        : () => Navigator.pop(dialogContext, false),
                    child: const Text('Cancel'),
                  ),
                  FilledButton(
                    onPressed: busy
                        ? null
                        : () async {
                            setState(() {
                              busy = true;
                              error = null;
                            });
                            try {
                              await save({
                                for (final entry in controllers.entries)
                                  entry.key: entry.value.text.trim(),
                              }, values);
                              if (dialogContext.mounted) {
                                Navigator.pop(dialogContext, true);
                              }
                            } catch (_) {
                              if (dialogContext.mounted) {
                                setState(() {
                                  busy = false;
                                  error =
                                      'Unable to save. Check dates, required fields, and connection.';
                                });
                              }
                            }
                          },
                    child: Text(busy ? 'Saving...' : 'Confirm review'),
                  ),
                ],
              ),
            ),
          ),
        ) ??
        false;
  } finally {
    for (final controller in controllers.values) {
      controller.dispose();
    }
  }
}
