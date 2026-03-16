# Frontend Role-Based Access Control (RBAC) — Implementation Prompt

> **Status:** Deferred to future sprint. Backend must be fully implemented first.
> **App:** Flutter (FluffyChat fork) at `/Users/priyanshupatel/Downloads/Lumos Logic/CQR-Chat`

---

## Architecture Overview

This is a **multi-company** platform. Each company is an isolated tenant.
Users from different companies never see each other.

```
Super Admin  >  Admin  >  Agent (Trusted User)  >  User
```

| Role | Scope | Who |
|---|---|---|
| `super_admin` | Platform-wide | Manages ALL companies |
| `admin` | Company-level | Full control of their company |
| `agent` | Company-level | Trusted User — external sharing (1 per company) |
| `user` | Company-level | Staff members and clients (default) |

---

## What to Build

### 1. Role Model — `lib/models/user_role.dart`

```dart
enum UserRole { superAdmin, admin, agent, user }

extension UserRoleExtension on UserRole {
  static UserRole fromString(String value) {
    switch (value) {
      case 'super_admin': return UserRole.superAdmin;
      case 'admin':       return UserRole.admin;
      case 'agent':       return UserRole.agent;
      default:            return UserRole.user;
    }
  }

  String get value {
    switch (this) {
      case UserRole.superAdmin: return 'super_admin';
      case UserRole.admin:      return 'admin';
      case UserRole.agent:      return 'agent';
      case UserRole.user:       return 'user';
    }
  }

  bool isAtLeast(UserRole minimum) {
    const hierarchy = [
      UserRole.user,
      UserRole.agent,
      UserRole.admin,
      UserRole.superAdmin,
    ];
    return hierarchy.indexOf(this) >= hierarchy.indexOf(minimum);
  }

  // Permission helpers — mirrors the backend role_permissions table
  bool get canManageCompanies   => this == UserRole.superAdmin;
  bool get canViewAllCompanies  => this == UserRole.superAdmin;
  bool get canManageUsers       => isAtLeast(UserRole.admin);
  bool get canInviteUsers       => isAtLeast(UserRole.admin);
  bool get canChangeUserRole    => isAtLeast(UserRole.admin); // Admin: up to admin; Super Admin: up to admin
  bool get canViewFullAuditLog  => isAtLeast(UserRole.admin);
  // External sharing: Admin + Agent + Super Admin (NOT user)
  bool get canShareExternally   => isAtLeast(UserRole.agent);
  bool get canExportChat        => isAtLeast(UserRole.agent);
  bool get canDownloadFiles     => isAtLeast(UserRole.agent);
  bool get canManageRoomMembers => isAtLeast(UserRole.agent);
  bool get canViewAuditLog      => isAtLeast(UserRole.agent);

  String get displayName {
    switch (this) {
      case UserRole.superAdmin: return 'Super Admin';
      case UserRole.admin:      return 'Admin';
      case UserRole.agent:      return 'Agent';
      case UserRole.user:       return 'User';
    }
  }
}
```

---

### 2. Role Provider — `lib/providers/role_provider.dart`

```dart
import 'package:flutter/material.dart';
import '../models/user_role.dart';
import '../services/api_service.dart';

class RoleProvider extends ChangeNotifier {
  UserRole _role     = UserRole.user;
  String?  _tenantId;
  String?  _userId;
  bool     _loaded   = false;

  UserRole get role     => _role;
  String?  get tenantId => _tenantId;
  String?  get userId   => _userId;
  bool     get isLoaded => _loaded;

  Future<void> loadRole() async {
    try {
      final data = await ApiService.instance.get('/api/roles/me');
      final user = data['user'] as Map<String, dynamic>;
      _role     = UserRoleExtension.fromString(user['role'] as String);
      _tenantId = user['tenant_id'] as String?;
      _userId   = user['id'] as String?;
      _loaded   = true;
      notifyListeners();
    } catch (_) {
      _loaded = true;
      notifyListeners();
    }
  }

  void clear() {
    _role     = UserRole.user;
    _tenantId = null;
    _userId   = null;
    _loaded   = false;
    notifyListeners();
  }
}
```

> Call `loadRole()` immediately after `LoginState.loggedIn` fires in `matrix.dart`.
> Call `clear()` in `_performLogout()`.

---

### 3. Role Guard Widget — `lib/widgets/role_guard.dart`

```dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/user_role.dart';
import '../providers/role_provider.dart';

/// Shows [child] only when the current user's role meets [minimum].
/// Shows [fallback] (default: empty box) otherwise.
/// Use this everywhere in the UI to progressively hide admin features.
class RoleGuard extends StatelessWidget {
  final UserRole minimum;
  final Widget   child;
  final Widget   fallback;

  const RoleGuard({
    super.key,
    required this.minimum,
    required this.child,
    this.fallback = const SizedBox.shrink(),
  });

  @override
  Widget build(BuildContext context) {
    final role = context.watch<RoleProvider>().role;
    return role.isAtLeast(minimum) ? child : fallback;
  }
}

/// Use this variant for permission-based (not just role-level) guards.
/// Example: canShareExternally is true for Agent AND Super Admin (not just role level).
class PermissionGuard extends StatelessWidget {
  final bool Function(UserRole role) permission;
  final Widget child;
  final Widget fallback;

  const PermissionGuard({
    super.key,
    required this.permission,
    required this.child,
    this.fallback = const SizedBox.shrink(),
  });

  @override
  Widget build(BuildContext context) {
    final role = context.watch<RoleProvider>().role;
    return permission(role) ? child : fallback;
  }
}
```

**Usage examples:**
```dart
// Show "Manage Users" only for admin+
RoleGuard(
  minimum: UserRole.admin,
  child: ListTile(title: const Text('Manage Users'), onTap: _openManageUsers),
)

// Show external share button only for agent AND super_admin (not admin!)
PermissionGuard(
  permission: (role) => role.canShareExternally,
  child: IconButton(icon: const Icon(Icons.share), onPressed: _shareExternally),
)
```

---

### 4. Drawer / Navigation — Role-Based Menu Items

In `lib/pages/chat_list/chat_list_view.dart` drawer, show items conditionally:

```dart
// Every user sees these:
ListTile(leading: Icon(Icons.chat), title: Text('Chats'), ...),
ListTile(leading: Icon(Icons.person), title: Text('Profile'), ...),

// Agent and above — room management
RoleGuard(
  minimum: UserRole.agent,
  child: ListTile(
    leading: const Icon(Icons.group),
    title: const Text('My Rooms'),
    onTap: () => context.push('/rooms'),
  ),
),

// Agent and above — audit log (own actions)
RoleGuard(
  minimum: UserRole.agent,
  child: ListTile(
    leading: const Icon(Icons.history),
    title: const Text('Activity Log'),
    onTap: () => context.push('/audit-log'),
  ),
),

// Admin and above — user management
RoleGuard(
  minimum: UserRole.admin,
  child: ListTile(
    leading: const Icon(Icons.people),
    title: const Text('Manage Users'),
    onTap: () => context.push('/admin/users'),
  ),
),

// Admin and above — invite new user
RoleGuard(
  minimum: UserRole.admin,
  child: ListTile(
    leading: const Icon(Icons.person_add),
    title: const Text('Invite User'),
    onTap: () => context.push('/admin/invite'),
  ),
),

// Super Admin only — company management
RoleGuard(
  minimum: UserRole.superAdmin,
  child: ListTile(
    leading: const Icon(Icons.business),
    title: const Text('All Companies'),
    onTap: () => context.push('/superadmin/companies'),
  ),
),
```

---

### 5. Route Protection — `lib/config/routes.dart`

```dart
// Helper to build a role-guarded redirect
String? _guardRoute(BuildContext context, UserRole minimum, {String fallback = '/'}) {
  final role = ProviderScope.containerOf(context).read(roleProvider).role;
  return role.isAtLeast(minimum) ? null : fallback;
}

// Routes
GoRoute(
  path: '/admin/users',
  redirect: (ctx, _) => _guardRoute(ctx, UserRole.admin),
  builder: (_, __) => const AdminUsersPage(),
),
GoRoute(
  path: '/admin/invite',
  redirect: (ctx, _) => _guardRoute(ctx, UserRole.admin),
  builder: (_, __) => const InviteUserPage(),
),
GoRoute(
  path: '/audit-log',
  redirect: (ctx, _) => _guardRoute(ctx, UserRole.agent),
  builder: (_, __) => const AuditLogPage(),
),
GoRoute(
  path: '/superadmin/companies',
  redirect: (ctx, _) => _guardRoute(ctx, UserRole.superAdmin),
  builder: (_, __) => const CompaniesPage(),
),
```

---

### 6. Pages to Build (Per Role)

#### Super Admin Pages
- `lib/pages/superadmin/companies_page.dart`
  — List all companies with user count and status
  — Create new company button
  — Deactivate / reactivate company
- `lib/pages/superadmin/all_audit_log_page.dart`
  — Full audit log across all companies with company filter

#### Admin Pages
- `lib/pages/admin/admin_users_page.dart`
  — List all users in their company (role, status)
  — Change role (agent ↔ user)
  — Deactivate / reactivate user
- `lib/pages/admin/invite_user_page.dart`
  — Email input + role selector (agent / user)
  — Calls `POST /invites`
  — Shows invite link / token on success
- `lib/pages/admin/company_audit_log_page.dart`
  — Audit log scoped to their company
- `lib/pages/admin/byod_approval_page.dart`
  — List pending BYOD requests, approve / reject

#### Agent Pages
- `lib/pages/agent/external_share_page.dart`
  — File picker → share via platform share sheet (WhatsApp, email, etc.)
  — Logs every share action
- `lib/pages/agent/export_chat_page.dart`
  — Select chat room → export to PDF or text file
- `lib/pages/agent/my_activity_page.dart`
  — Audit log filtered to own actions

#### All Roles
- `lib/pages/profile/my_profile_page.dart`
  — Shows name, email, role display name, company name

---

### 7. External Sharing (Admin + Agent + Super Admin)

In the file viewer and chat pages, show the share button for all roles with `canShareExternally`:

```dart
// In file viewer
PermissionGuard(
  permission: (role) => role.canShareExternally,
  child: IconButton(
    icon: const Icon(Icons.ios_share),
    tooltip: 'Share Externally',
    onPressed: () => _shareFileExternally(context, fileUrl, fileName),
  ),
),
```

`_shareFileExternally` should:
1. Call `Share.shareFiles([localPath], text: fileName)` (using `share_plus` package)
2. After share completes, POST to `/api/audit` to log the `EXTERNAL_SHARE` event

> Admin, Agent, and Super Admin all have this permission. User does NOT.

---

### 8. Chat Export (Admin + Agent + Super Admin)

In chat view menu:
```dart
PermissionGuard(
  permission: (role) => role.canExportChat,
  child: PopupMenuItem(
    value: 'export_chat',
    child: const ListTile(
      leading: Icon(Icons.download),
      title: Text('Export Chat'),
    ),
  ),
),
```

---

### 9. User Role Badge (Admin Panel)

In `admin_users_page.dart`, show a color-coded chip next to each user:

```dart
Chip(
  label: Text(UserRoleExtension.fromString(user['role']).displayName),
  backgroundColor: _roleColor(user['role']),
)

Color _roleColor(String role) {
  switch (role) {
    case 'super_admin': return Colors.red.shade100;
    case 'admin':       return Colors.orange.shade100;
    case 'agent':       return Colors.blue.shade100;
    default:            return Colors.grey.shade200;
  }
}
```

---

### 10. API Service Methods — `lib/services/api_service.dart`

Add these methods:

```dart
// Role & user management
Future<Map<String, dynamic>> getMyRole() =>
    get('/api/roles/me');

Future<List<dynamic>> getCompanyUsers() async {
  final data = await get('/api/roles/users');
  return data['users'] as List<dynamic>;
}

Future<void> changeUserRole(String userId, String newRole) =>
    patch('/api/roles/users/$userId/role', {'new_role': newRole});

Future<void> changeUserStatus(String userId, String status) =>
    patch('/api/roles/users/$userId/status', {'status': status});

Future<List<dynamic>> getAuditLogs() async {
  final data = await get('/api/roles/audit-logs');
  return data['logs'] as List<dynamic>;
}

// Company management (Super Admin only)
Future<List<dynamic>> getAllCompanies() async {
  final data = await get('/api/roles/companies');
  return data['companies'] as List<dynamic>;
}

Future<Map<String, dynamic>> createCompany(String name, String tenantId) =>
    post('/api/roles/companies', {'name': name, 'tenant_id': tenantId});

Future<void> setCompanyStatus(String tenantId, String status) =>
    patch('/api/roles/companies/$tenantId/status', {'status': status});

// Invite
Future<Map<String, dynamic>> createInvite(String email, String role) =>
    post('/invites', {'email': email, 'role': role});
```

---

## Implementation Order

1. Create `UserRole` enum and extension (`user_role.dart`)
2. Create `RoleProvider` + wire into `matrix.dart` after login
3. Create `RoleGuard` and `PermissionGuard` widgets
4. Add `RoleProvider` to the Provider tree in `main.dart`
5. Wrap existing UI elements (drawer, menus, buttons) with guards
6. Add route protection in `routes.dart`
7. Build **Admin pages** first (user list, invite)
8. Build **Agent pages** (external share, chat export)
9. Build **Super Admin pages** (companies list)
10. Test all four roles end-to-end on device

---

## UI/UX Principles

- **Progressive disclosure:** Users never see admin UI. Do not disable — hide completely.
- **External share is visually distinct:** Use a different icon (`ios_share`) and confirm dialog before sharing, since it sends data outside the secure environment.
- **External sharing: Admin + Agent + Super Admin** — all three roles see the share button. Only User is excluded.
- **No role labels in chat UI:** Regular users should never see "You are a User" anywhere in the chat interface. Role info only appears in the profile/settings pages.
- **Company isolation in Super Admin view:** When Super Admin views users across companies, always show the company name alongside each user.
- **Role change confirmation:** Always show a confirmation dialog before changing a user's role or deactivating an account.

---

## Dependencies to Add (`pubspec.yaml`)

```yaml
provider:   ^6.1.2   # if not already present — for RoleProvider
share_plus: ^7.2.1   # for external file sharing from Agent role
```

> `go_router` is already used for routing.
