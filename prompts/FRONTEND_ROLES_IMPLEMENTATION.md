# Frontend Role-Based Access Control (RBAC) — Implementation Prompt

> **Status:** Ready to implement. Backend is fully complete and deployed.
> **App:** Flutter (FluffyChat fork) at `/Users/vtechglobe/Downloads/Priyanshu/CQR-Chat`
> **Backend base URL:** `https://api.enrichlabs.net` (Node.js — port 3000)
> **Matrix homeserver:** `https://cqr-server.enrichlabs.net` (Synapse — port 8008)

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
| `agent` | Company-level | Trusted User — external sharing privilege (**multiple allowed per company**) |
| `user` | Company-level | Staff members and clients (default) |

> **Agent (Trusted User) — multiple allowed per company.**
> Admin can freely assign the `agent` role to any number of users in their company.
> There is NO limit on how many agents a company can have.

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
  // Admin can freely move users between user ↔ agent ↔ admin (not super_admin)
  bool get canChangeUserRole    => isAtLeast(UserRole.admin);
  bool get canViewFullAuditLog  => isAtLeast(UserRole.admin);
  // External sharing: Admin + Agent + Super Admin (NOT plain user)
  bool get canShareExternally   => isAtLeast(UserRole.agent);
  bool get canExportChat        => isAtLeast(UserRole.agent);
  bool get canDownloadFiles     => isAtLeast(UserRole.agent);
  bool get canManageRoomMembers => isAtLeast(UserRole.agent);
  bool get canViewAuditLog      => isAtLeast(UserRole.agent);

  String get displayName {
    switch (this) {
      case UserRole.superAdmin: return 'Super Admin';
      case UserRole.admin:      return 'Admin';
      case UserRole.agent:      return 'Trusted User';
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

/// Permission-based guard (for permissions that skip a role level).
/// Example: canShareExternally is true for Agent AND above (not just admin level).
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

// Show external share button for agent AND above (not plain user)
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

// Agent and above — own activity log
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
String? _guardRoute(BuildContext context, UserRole minimum, {String fallback = '/'}) {
  final role = ProviderScope.containerOf(context).read(roleProvider).role;
  return role.isAtLeast(minimum) ? null : fallback;
}

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
  — List all users in their company (name, role badge, status)
  — Change role: `user ↔ agent ↔ admin` freely (no limit on agents)
  — Deactivate / reactivate user
  — **Cannot touch Super Admin users**
  — **Cannot change own role**
- `lib/pages/admin/invite_user_page.dart`
  — Label input (name/description — **no email required**)
  — Role selector: `user` / `agent (Trusted User)` / `admin`
  — Calls `POST /invites` with `{ label, role }`
  — Shows invite link on success (copy / share)
- `lib/pages/admin/company_audit_log_page.dart`
  — Audit log scoped to their company

#### Agent (Trusted User) Pages
- `lib/pages/agent/external_share_page.dart`
  — File picker → share via platform share sheet (WhatsApp, email, etc.)
  — Logs every share action
- `lib/pages/agent/export_chat_page.dart`
  — Select chat room → export to PDF or text file
- `lib/pages/agent/my_activity_page.dart`
  — Audit log filtered to own actions

#### All Roles
- `lib/pages/profile/my_profile_page.dart`
  — Shows name, role display name (`Trusted User` for agent), company name

---

### 7. Role Assignment UX — Admin Users Page

The role change dropdown for each user should offer:

```dart
// Available roles admin can assign (cannot assign super_admin)
const assignableRoles = ['user', 'agent', 'admin'];
```

**No restriction on how many agents.** Admin can assign `agent` to any number of users.
The dropdown simply patches the role — no warning about "already has an agent" needed.

Role badge colors:
```dart
Color _roleColor(String role) {
  switch (role) {
    case 'super_admin': return Colors.red.shade100;
    case 'admin':       return Colors.orange.shade100;
    case 'agent':       return Colors.blue.shade100;
    default:            return Colors.grey.shade200;
  }
}

// Display label (agent shows as "Trusted User" in UI)
String _roleLabel(String role) {
  switch (role) {
    case 'super_admin': return 'Super Admin';
    case 'admin':       return 'Admin';
    case 'agent':       return 'Trusted User';
    default:            return 'User';
  }
}
```

Always show a confirmation dialog before changing a role or deactivating an account.

---

### 8. External Sharing (Admin + Agent + Super Admin)

In the file viewer and chat pages, show the share button for all roles with `canShareExternally`:

```dart
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

> Admin, Agent (Trusted User), and Super Admin all have this permission. Plain User does NOT.

---

### 9. Chat Export (Admin + Agent + Super Admin)

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

### 10. API Service Methods — `lib/services/api_service.dart`

All API calls use `AppConfig.backendUrl` = `https://api.enrichlabs.net`.

```dart
// Role & user management
Future<Map<String, dynamic>> getMyRole() =>
    get('/api/roles/me');

Future<List<dynamic>> getCompanyUsers() async {
  final data = await get('/api/roles/users');
  return data['users'] as List<dynamic>;
}

// new_role: 'user' | 'agent' | 'admin'
// Admin can assign agent to multiple users freely — no limit
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

// Invite — NO email field. Use label (name / description) instead.
// role: 'user' | 'agent' | 'admin'  (super_admin cannot be invited)
Future<Map<String, dynamic>> createInvite(String label, String role) =>
    post('/invites', {'label': label, 'role': role});
```

> **Important:** The invite endpoint does NOT accept email or phone number.
> `label` is a free-text description (e.g. "New Sales Agent", "Client - Acme Corp").
> No email is stored or sent anywhere. The invite link is shared manually by the Admin.

---

## Complete API Surface (Backend — Already Deployed)

| Method | Path | Min Role | Description |
|---|---|---|---|
| GET | `/api/roles/me` | user | Own role, tenant, status |
| GET | `/api/roles/users` | admin | All users (Super Admin: all tenants; Admin: own company) |
| PATCH | `/api/roles/users/:id/role` | admin | Change a user's role |
| PATCH | `/api/roles/users/:id/status` | admin | Activate / deactivate user |
| GET | `/api/roles/audit-logs` | agent | Audit log (scoped by role) |
| GET | `/api/roles/companies` | super_admin | List all companies |
| POST | `/api/roles/companies` | super_admin | Create a new company |
| PATCH | `/api/roles/companies/:tenantId/status` | super_admin | Activate / deactivate company |
| POST | `/invites` | admin | Create invite token (no email — label only) |
| GET | `/invites/:id` | admin | Check invite status |

---

## Role Access Matrix

| Action | Super Admin | Admin | Agent | User |
|---|:---:|:---:|:---:|:---:|
| Send messages | ✅ | ✅ | ✅ | ✅ |
| Upload / view files | ✅ | ✅ | ✅ | ✅ |
| Download files | ✅ | ✅ | ✅ | ❌ |
| Manage room members | ✅ | ✅ | ✅ | ❌ |
| View own audit log | ✅ | ✅ | ✅ | ❌ |
| **External file sharing** | ✅ | ✅ | ✅ | ❌ |
| **Export chat history** | ✅ | ✅ | ✅ | ❌ |
| View full company audit log | ✅ | ✅ | ❌ | ❌ |
| Invite new users (no email) | ✅ | ✅ | ❌ | ❌ |
| Manage / deactivate users | ✅ | ✅ (not super_admin) | ❌ | ❌ |
| Change user roles (up to admin) | ✅ | ✅ (not super_admin) | ❌ | ❌ |
| Assign agent role (unlimited) | ✅ | ✅ | ❌ | ❌ |
| Assign admin role within company | ✅ | ✅ | ❌ | ❌ |
| Assign super_admin role | ✅ | ❌ | ❌ | ❌ |
| View all companies | ✅ | ❌ | ❌ | ❌ |
| Create / deactivate company | ✅ | ❌ | ❌ | ❌ |
| View all tenants' audit logs | ✅ | ❌ | ❌ | ❌ |

---

## Key Behavioral Rules (Backend Enforced)

- Admin can freely move users between `user → agent → admin` and back
- Admin **cannot** touch Super Admin users
- Admin **cannot** change their own role
- Admin **cannot** assign `super_admin` role
- **No limit on agents per company** — multiple Trusted Users allowed
- Super Admin cannot modify another Super Admin's role
- `requireSameTenant` ensures Admin cannot act on users in other companies
- Super Admin bypasses tenant isolation (platform-wide access)

---

## Implementation Order

1. Create `UserRole` enum and extension (`user_role.dart`)
2. Create `RoleProvider` + wire into `matrix.dart` after login / `_performLogout`
3. Create `RoleGuard` and `PermissionGuard` widgets
4. Add `RoleProvider` to the Provider tree in `main.dart`
5. Wrap existing UI elements (drawer, menus, buttons) with guards
6. Add route protection in `routes.dart`
7. Build **Admin pages** (user list with role badges, invite without email)
8. Build **Agent pages** (external share, chat export, own activity)
9. Build **Super Admin pages** (companies list, platform audit log)
10. Test all four roles end-to-end on device

---

## UI/UX Principles

- **Progressive disclosure:** Users never see admin UI. Hide completely — do not disable.
- **Agent displays as "Trusted User"** everywhere in the UI (`displayName` = `'Trusted User'`).
- **No email anywhere:** The invite flow has no email input. Admin enters a label/description, copies the link, and shares it manually (WhatsApp, Slack, etc.).
- **No role labels in chat UI:** Regular users never see "You are a User" in the chat interface. Role info appears only in profile/settings pages.
- **External share is visually distinct:** Use a different icon (`ios_share`) and a confirm dialog before sharing, since data leaves the secure environment.
- **Company isolation in Super Admin view:** Always show company name alongside each user when Super Admin views across tenants.
- **Role change confirmation:** Always confirm before changing a role or deactivating an account.
- **No "agent limit" warning needed:** Since multiple agents are allowed, never show a warning about existing agents when assigning the agent role.

---

## Dependencies to Add (`pubspec.yaml`)

```yaml
provider:   ^6.1.2   # if not already present — for RoleProvider
share_plus: ^7.2.1   # for external file sharing from Agent/Admin role
```

> `go_router` is already used for routing.
