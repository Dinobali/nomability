import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://nomability.net',
);

const String tokenKey = 'nmAuthToken';

void main() {
  runApp(const AdminApp());
}

class AdminApp extends StatefulWidget {
  const AdminApp({super.key});

  @override
  State<AdminApp> createState() => _AdminAppState();
}

class _AdminAppState extends State<AdminApp> {
  String? _token;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadToken();
  }

  Future<void> _loadToken() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(tokenKey);
    if (token == null) {
      setState(() {
        _token = null;
        _loading = false;
      });
      return;
    }
    final ok = await ApiClient.verifyAdmin(token);
    if (!ok) {
      await prefs.remove(tokenKey);
    }
    setState(() {
      _token = ok ? token : null;
      _loading = false;
    });
  }

  Future<void> _handleLoggedIn(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(tokenKey, token);
    setState(() {
      _token = token;
    });
  }

  Future<void> _handleLogout() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(tokenKey);
    setState(() {
      _token = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Nomability Admin',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF22D3EE)),
        useMaterial3: true,
      ),
      home: _loading
          ? const Scaffold(
              body: Center(child: CircularProgressIndicator()),
            )
          : (_token == null
              ? LoginScreen(onLoggedIn: _handleLoggedIn)
              : InvoiceScreen(token: _token!, onLogout: _handleLogout)),
    );
  }
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onLoggedIn});

  final ValueChanged<String> onLoggedIn;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _submitting = false;
  String? _error;

  Future<void> _submit() async {
    if (_submitting) return;
    setState(() {
      _submitting = true;
      _error = null;
    });

    final email = _emailController.text.trim();
    final password = _passwordController.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() {
        _error = 'Email and password are required.';
        _submitting = false;
      });
      return;
    }

    final result = await ApiClient.login(email, password);
    if (!result.success) {
      setState(() {
        _error = result.message ?? 'Login failed.';
        _submitting = false;
      });
      return;
    }

    final token = result.token;
    if (token == null) {
      setState(() {
        _error = 'Login failed.';
        _submitting = false;
      });
      return;
    }

    final isAdmin = await ApiClient.verifyAdmin(token);
    if (!isAdmin) {
      setState(() {
        _error = 'Not authorized. Admin access required.';
        _submitting = false;
      });
      return;
    }

    if (!mounted) return;
    widget.onLoggedIn(token);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Admin login')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: _emailController,
                  keyboardType: TextInputType.emailAddress,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(labelText: 'Email'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _passwordController,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Password'),
                  onSubmitted: (_) => _submit(),
                ),
                const SizedBox(height: 20),
                FilledButton(
                  onPressed: _submitting ? null : _submit,
                  child: _submitting
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Sign in'),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                ]
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class InvoiceScreen extends StatefulWidget {
  const InvoiceScreen({super.key, required this.token, required this.onLogout});

  final String token;
  final VoidCallback onLogout;

  @override
  State<InvoiceScreen> createState() => _InvoiceScreenState();
}

class _InvoiceScreenState extends State<InvoiceScreen> {
  bool _loading = true;
  String? _error;
  List<Invoice> _invoices = [];
  String? _updatingId;

  @override
  void initState() {
    super.initState();
    _loadInvoices();
  }

  Future<void> _loadInvoices() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final result = await ApiClient.fetchInvoices(widget.token);
    if (!mounted) return;
    if (!result.success) {
      setState(() {
        _error = result.message ?? 'Failed to load invoices.';
        _loading = false;
      });
      return;
    }
    setState(() {
      _invoices = result.invoices ?? [];
      _loading = false;
    });
  }

  Future<void> _updateInvoice(String invoiceId, String status) async {
    setState(() {
      _updatingId = invoiceId;
    });
    final result = await ApiClient.updateInvoice(widget.token, invoiceId, status);
    if (!mounted) return;
    if (!result.success) {
      setState(() {
        _updatingId = null;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(result.message ?? 'Failed to update invoice.')),
      );
      return;
    }
    await _loadInvoices();
    setState(() {
      _updatingId = null;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Invoice marked $status.')),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Invoice approvals'),
        actions: [
          IconButton(
            onPressed: widget.onLogout,
            icon: const Icon(Icons.logout),
            tooltip: 'Logout',
          )
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : (_error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!),
                        const SizedBox(height: 12),
                        OutlinedButton(
                          onPressed: _loadInvoices,
                          child: const Text('Retry'),
                        )
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _loadInvoices,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _invoices.length,
                    itemBuilder: (context, index) {
                      final invoice = _invoices[index];
                      final isPending = invoice.status == 'pending';
                      final isUpdating = _updatingId == invoice.id;
                      return Card(
                        margin: const EdgeInsets.only(bottom: 16),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '${invoice.invoiceNumber} · ${invoice.planKey}',
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              const SizedBox(height: 6),
                              Text('Amount: ${invoice.amountLabel}'),
                              Text('Status: ${invoice.status}'),
                              Text('Requested by: ${invoice.requestedBy}'),
                              Text('Created: ${invoice.createdAtLabel}'),
                              Text('Due: ${invoice.dueDateLabel}'),
                              if (isPending) ...[
                                const SizedBox(height: 12),
                                Row(
                                  children: [
                                    FilledButton(
                                      onPressed: isUpdating
                                          ? null
                                          : () => _updateInvoice(invoice.id, 'paid'),
                                      child: const Text('Mark paid'),
                                    ),
                                    const SizedBox(width: 12),
                                    OutlinedButton(
                                      onPressed: isUpdating
                                          ? null
                                          : () => _updateInvoice(invoice.id, 'rejected'),
                                      child: const Text('Reject'),
                                    )
                                  ],
                                )
                              ]
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                )),
    );
  }
}

class Invoice {
  Invoice({
    required this.id,
    required this.invoiceNumber,
    required this.planKey,
    required this.amountCents,
    required this.currency,
    required this.status,
    required this.createdAt,
    required this.dueDate,
    required this.requestedBy,
  });

  final String id;
  final String invoiceNumber;
  final String planKey;
  final int amountCents;
  final String currency;
  final String status;
  final String? createdAt;
  final String? dueDate;
  final String requestedBy;

  String get amountLabel {
    final value = (amountCents / 100).toStringAsFixed(2);
    return '${currency.toUpperCase()} $value';
  }

  String get createdAtLabel => _formatDate(createdAt);

  String get dueDateLabel => _formatDate(dueDate);

  static String _formatDate(String? value) {
    if (value == null || value.isEmpty) return '—';
    final parsed = DateTime.tryParse(value);
    if (parsed == null) return '—';
    final local = parsed.toLocal();
    final month = local.month.toString().padLeft(2, '0');
    final day = local.day.toString().padLeft(2, '0');
    return '${local.year}-$month-$day';
  }

  factory Invoice.fromJson(Map<String, dynamic> json) {
    final user = json['user'] as Map<String, dynamic>?;
    return Invoice(
      id: json['id'] as String? ?? '',
      invoiceNumber: json['invoiceNumber'] as String? ?? '—',
      planKey: json['planKey'] as String? ?? 'plan',
      amountCents: (json['amountCents'] as num?)?.toInt() ?? 0,
      currency: (json['currency'] as String?) ?? 'EUR',
      status: (json['status'] as String?) ?? 'pending',
      createdAt: json['createdAt'] as String?,
      dueDate: json['dueDate'] as String?,
      requestedBy: user?['email'] as String?
          ?? (json['billingName'] as String? ?? 'Unknown'),
    );
  }
}

class ApiResult {
  ApiResult({required this.success, this.message});

  final bool success;
  final String? message;
}

class LoginResult extends ApiResult {
  LoginResult({required super.success, super.message, this.token});

  final String? token;
}

class InvoiceResult extends ApiResult {
  InvoiceResult({required super.success, super.message, this.invoices});

  final List<Invoice>? invoices;
}

class ApiClient {
  static Uri _uri(String path) {
    return Uri.parse('$apiBaseUrl$path');
  }

  static Future<LoginResult> login(String email, String password) async {
    try {
      final response = await http.post(
        _uri('/api/auth/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': email, 'password': password}),
      );
      final data = _parseBody(response.body);
      if (response.statusCode != 200) {
        return LoginResult(
          success: false,
          message: data['error'] as String? ?? 'Login failed.',
        );
      }
      return LoginResult(
        success: true,
        token: data['token'] as String?,
      );
    } catch (error) {
      return LoginResult(success: false, message: 'Login failed.');
    }
  }

  static Future<bool> verifyAdmin(String token) async {
    try {
      final response = await http.get(
        _uri('/api/auth/me'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) {
        return false;
      }
      final data = _parseBody(response.body);
      final membership = data['membership'] as Map<String, dynamic>?;
      return membership?['role'] == 'admin';
    } catch (error) {
      return false;
    }
  }

  static Future<InvoiceResult> fetchInvoices(String token) async {
    try {
      final response = await http.get(
        _uri('/api/admin/org/invoices'),
        headers: {'Authorization': 'Bearer $token'},
      );
      final data = _parseBody(response.body);
      if (response.statusCode != 200) {
        return InvoiceResult(
          success: false,
          message: data['error'] as String? ?? 'Failed to load invoices.',
        );
      }
      final items = (data['invoices'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map(Invoice.fromJson)
          .toList();
      return InvoiceResult(success: true, invoices: items);
    } catch (error) {
      return InvoiceResult(success: false, message: 'Failed to load invoices.');
    }
  }

  static Future<ApiResult> updateInvoice(String token, String invoiceId, String status) async {
    try {
      final response = await http.post(
        _uri('/api/admin/org/invoices/$invoiceId'),
        headers: {
          'Authorization': 'Bearer $token',
          'Content-Type': 'application/json'
        },
        body: jsonEncode({'status': status}),
      );
      final data = _parseBody(response.body);
      if (response.statusCode != 200) {
        return ApiResult(
          success: false,
          message: data['error'] as String? ?? 'Failed to update invoice.',
        );
      }
      return ApiResult(success: true);
    } catch (error) {
      return ApiResult(success: false, message: 'Failed to update invoice.');
    }
  }

  static Map<String, dynamic> _parseBody(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic>) {
        return decoded;
      }
    } catch (_) {}
    return {};
  }
}
